// Assertions for the backend. Standard library only; needs a Node with node:sqlite (>= 22.5).
// Run through `node run-tests.mjs`, which skips this suite on older runtimes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.js';
import { resetRateLimits } from './auth.js';
import { openDb } from './db.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class AssertionError extends Error {}
const assert = (cond, msg = 'assertion failed') => { if (!cond) throw new AssertionError(msg); };
function eq(actual, expected, msg = '') {
  if (actual !== expected) throw new AssertionError(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A running app with its own database, plus a fetch that keeps cookies per "browser". */
async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'homeplan-test-'));
  const server = createApp({ dataDir: dir });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  resetRateLimits();

  const browser = () => {
    let cookie = null;
    return async function call(path, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const set = res.headers.getSetCookie?.() || [];
      for (const c of set) cookie = c.split(';')[0];
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text, headers: res.headers };
    };
  };

  try {
    await fn({ base, call: browser(), browser, db: openDb(dir), dir });
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Register an email and walk through its invite, leaving `call` signed in. */
async function signUp(call, dir, email, password = 'correct horse battery') {
  const db = openDb(dir);
  const user = db.userByEmail(email) || db.createUser(email);
  const token = db.newInvite(user.id);
  db.close();
  const res = await call(`/api/invite/${token}`, { method: 'POST', body: { password } });
  eq(res.status, 200, `invite accepted for ${email}:`);
  return { email, password };
}

const samplePlan = { version: 2, nextId: 1, levels: [{ id: 'l1', name: 'Level 1', height: 270 }], nodes: [], walls: [], openings: [], floors: [], stairs: [], furniture: [] };

// ------------------------------------------------------------------ static site

test('serves the editor, the share page and nothing above the root', async () => {
  await withServer(async ({ call }) => {
    eq((await call('/api/health')).json.ok, true);
    const home = await call('/');
    eq(home.status, 200);
    assert(home.text.includes('<canvas id="plan"'), 'the editor page');
    const shared = await call('/s/whatever-token');
    eq(shared.status, 200, 'a share link serves the same page:');
    assert(shared.text.includes('<canvas id="plan"'), 'so the app can boot in preview');
    eq((await call('/invite/abc')).status, 200, 'invite page:');
    eq((await call('/js/model.js')).status, 200, 'modules are served:');
    eq((await call('/js/../server/db.js')).status, 404, 'the server sources are not downloadable:');
    eq((await call('/server/db.js')).status, 404, 'by any spelling:');
    eq((await call('/../README.md')).status, 404, 'and nothing above the root:');
    eq((await call('/nope.txt')).status, 404);
    eq((await call('/style.css')).status, 200, 'but the stylesheet is:');
  });
});

// ------------------------------------------------------------------ accounts

test('an invite sets a password once, and only a good one', async () => {
  await withServer(async ({ call, dir }) => {
    const db = openDb(dir);
    const user = db.createUser('invited@example.com');
    const token = db.newInvite(user.id);
    db.close();
    eq((await call(`/api/invite/${token}`)).json.email, 'invited@example.com');
    eq((await call('/api/invite/not-a-token')).status, 404);
    const short = await call(`/api/invite/${token}`, { method: 'POST', body: { password: 'short' } });
    eq(short.status, 400, 'a short password is refused:');
    const ok = await call(`/api/invite/${token}`, { method: 'POST', body: { password: 'a good long password' } });
    eq(ok.status, 200);
    eq((await call('/api/me')).json.email, 'invited@example.com', 'and signs them in:');
    eq((await call(`/api/invite/${token}`, { method: 'POST', body: { password: 'another long one' } })).status, 404,
      'the link cannot be used twice:');
  });
});

test('sign in, sign out, and a rate limit on guessing', async () => {
  await withServer(async ({ call, browser, dir }) => {
    const { email, password } = await signUp(call, dir, 'me@example.com');
    eq((await call('/api/logout', { method: 'POST', body: {} })).status, 200);
    eq((await call('/api/me')).status, 401, 'signed out:');

    const guess = browser();
    for (let i = 0; i < 10; i++) {
      eq((await guess('/api/login', { method: 'POST', body: { email, password: 'wrong wrong wrong' } })).status, 401);
    }
    eq((await guess('/api/login', { method: 'POST', body: { email, password } })).status, 429, 'rate limited:');

    resetRateLimits();
    const good = await call('/api/login', { method: 'POST', body: { email, password } });
    eq(good.status, 200);
    eq(good.json.email, email);
    eq((await call('/api/me')).json.email, email);
  });
});

test('a cross-site write is refused', async () => {
  await withServer(async ({ call }) => {
    const res = await call('/api/login', {
      method: 'POST', body: { email: 'a@b.co', password: 'x' }, headers: { origin: 'http://evil.example' },
    });
    eq(res.status, 403);
  });
});

// ------------------------------------------------------------------ plans

test('plans belong to their owner', async () => {
  await withServer(async ({ call, browser, dir }) => {
    eq((await call('/api/plans')).status, 401, 'anonymous listing:');
    eq((await call('/api/plans', { method: 'POST', body: { name: 'x', data: samplePlan } })).status, 401,
      'anonymous saving:');

    await signUp(call, dir, 'owner@example.com');
    const made = await call('/api/plans', { method: 'POST', body: { name: 'Ground floor', data: samplePlan } });
    eq(made.status, 201);
    const id = made.json.plan.id;
    eq(made.json.plan.name, 'Ground floor');
    eq(made.json.plan.share, null);

    const list = await call('/api/plans');
    eq(list.json.plans.length, 1);
    eq(list.json.plans[0].id, id);

    const got = await call(`/api/plans/${id}`);
    eq(got.json.plan.data.version, 2, 'the plan comes back:');

    const changed = { ...samplePlan, nextId: 7 };
    eq((await call(`/api/plans/${id}`, { method: 'PUT', body: { data: changed } })).status, 200);
    eq((await call(`/api/plans/${id}`)).json.plan.data.nextId, 7, 'and the update stuck:');
    eq((await call(`/api/plans/${id}`, { method: 'PUT', body: { name: 'First floor' } })).json.plan.name, 'First floor');

    const other = browser();
    await signUp(other, dir, 'someone@example.com');
    eq((await other(`/api/plans/${id}`)).status, 404, "someone else's plan is simply not there:");
    eq((await other(`/api/plans/${id}`, { method: 'DELETE', body: {} })).status, 404);
    eq((await other('/api/plans')).json.plans.length, 0);

    eq((await call('/api/plans', { method: 'POST', body: { name: 'bad', data: 'not an object' } })).status, 400);
    eq((await call(`/api/plans/${id}`, { method: 'DELETE', body: {} })).status, 200);
    eq((await call('/api/plans')).json.plans.length, 0, 'deleted:');
  });
});

// ------------------------------------------------------------------ sharing

test('share links are public, keep their token and can be revoked', async () => {
  await withServer(async ({ call, browser, dir }) => {
    await signUp(call, dir, 'sharer@example.com');
    const id = (await call('/api/plans', { method: 'POST', body: { name: 'Shared', data: samplePlan } })).json.plan.id;

    const view = await call(`/api/plans/${id}/share`, { method: 'POST', body: { mode: 'view' } });
    eq(view.status, 200);
    const token = view.json.share.token;
    eq(view.json.share.mode, 'view');

    const anon = browser();
    const seen = await anon(`/api/shared/${token}`);
    eq(seen.status, 200, 'anyone with the link can read it:');
    eq(seen.json.mode, 'view');
    eq(seen.json.name, 'Shared');
    eq(seen.json.data.version, 2);
    eq((await anon('/api/plans')).status, 401, 'but it is not an account:');

    const copy = await call(`/api/plans/${id}/share`, { method: 'POST', body: { mode: 'copy' } });
    eq(copy.json.share.token, token, 'switching the mode keeps the link:');
    eq((await anon(`/api/shared/${token}`)).json.mode, 'copy');

    eq((await call(`/api/plans/${id}/share`, { method: 'POST', body: { mode: 'off' } })).json.share, null);
    eq((await anon(`/api/shared/${token}`)).status, 404, 'a revoked link stops working:');
    eq((await call(`/api/plans/nope/share`, { method: 'POST', body: { mode: 'view' } })).status, 404);
  });
});

/** Run every server test. Returns { passed, failed, results }. */
export async function runServerTests() {
  const results = [];
  for (const t of tests) {
    try { await t.fn(); results.push({ name: t.name, ok: true }); }
    catch (e) { results.push({ name: t.name, ok: false, error: e && e.message ? e.message : String(e) }); }
  }
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, results };
}
