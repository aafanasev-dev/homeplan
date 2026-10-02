// The whole backend: static site + JSON API, on node:http with no dependencies.
//
//   /                  the editor
//   /s/<token>         the editor in read-only preview, for a shared plan
//   /invite/<token>    set a password for an invited email
//   /api/...           JSON API (see the routes at the bottom)

import { createServer as httpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import {
  hashPassword, verifyPassword, passwordProblem, isEmail,
  readCookie, sessionCookie, clearCookie, rateLimited, noteFailure, clearFailures,
} from './auth.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_BODY = 2 * 1024 * 1024; // 2 MB, which is a very large plan
const MAX_NAME = 100;

// What a browser may download: the editor's own files, nothing else in the tree.
const PUBLIC_FILES = new Set(['/index.html', '/invite.html', '/style.css', '/tests.html']);
const PUBLIC_JS = /^\/js\/[\w.-]+\.m?js$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
};
const fail = (res, status, error, headers) => send(res, status, { error }, headers);

/** Read a JSON body, or null when it is missing, too big or malformed. */
function readJson(req) {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); done(undefined); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { done(null); return; }
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(undefined); }
    });
    req.on('error', () => done(undefined));
  });
}

/** A cross-site request with our cookie would be the one thing SameSite=Lax lets through. */
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return true; } catch { return true; }
  }
  return false;
}

async function sendFile(res, file, { status = 200 } = {}) {
  try {
    const body = await readFile(file);
    res.writeHead(status, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/**
 * Serve one of the client's own files. Only those: the server's sources sit in the same tree and
 * have no business being downloadable, and an allowlist says so once instead of guessing per path.
 */
async function serveStatic(res, path) {
  if (!PUBLIC_FILES.has(path) && !PUBLIC_JS.test(path)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const file = resolve(ROOT, `.${path}`);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(404).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) { res.writeHead(404).end(); return; }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  await sendFile(res, file);
}

const planView = (row) => ({
  id: row.id,
  name: row.name,
  updatedAt: row.updated_at,
  share: row.share_token && row.share_mode ? { token: row.share_token, mode: row.share_mode } : null,
});

/** Check and normalise what a client sent for a plan. Returns { name, data } or an error string. */
function planBody(body, { partial = false } = {}) {
  const out = {};
  if (body?.name != null) {
    const name = String(body.name).trim().slice(0, MAX_NAME);
    if (!name) return 'A plan needs a name.';
    out.name = name;
  } else if (!partial) {
    out.name = 'Untitled plan';
  }
  if (body?.data != null) {
    if (typeof body.data !== 'object') return 'That plan data is not an object.';
    const text = JSON.stringify(body.data);
    if (text.length > MAX_BODY) return 'That plan is too large.';
    out.data = text;
  } else if (!partial) {
    return 'That request has no plan data.';
  }
  return out;
}

export function createApp({ dataDir = process.env.DATA_DIR || './data' } = {}) {
  const db = openDb(dataDir);

  const server = httpServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { res.writeHead(400).end(); return; }
    const path = decodeURIComponent(url.pathname);

    try {
      if (path.startsWith('/api/')) { await api(req, res, path, db); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (path === '/' || /^\/s\/[\w-]+$/.test(path)) { await sendFile(res, join(ROOT, 'index.html')); return; }
      if (/^\/invite\/[\w-]+$/.test(path)) { await sendFile(res, join(ROOT, 'invite.html')); return; }
      await serveStatic(res, path);
    } catch (e) {
      console.error('request failed', e);
      if (!res.headersSent) fail(res, 500, 'Something went wrong.');
      else res.end();
    }
  });
  server.db = db;
  server.on('close', () => { try { db.close(); } catch { /* already closed */ } });
  return server;
}

// -------------------------------------------------------------------- the API

async function api(req, res, path, db) {
  const method = req.method;
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating) {
    if (crossSite(req)) return fail(res, 403, 'Cross-site requests are not allowed.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (type && type !== 'application/json') return fail(res, 415, 'Send JSON.');
  }
  const me = () => db.sessionUser(readCookie(req));
  const ip = req.socket.remoteAddress || '?';

  if (path === '/api/health') return send(res, 200, { ok: true });

  // ---------------------------------------------------------------- accounts
  if (path === '/api/me' && method === 'GET') {
    const user = me();
    return user ? send(res, 200, { email: user.email }) : fail(res, 401, 'Not signed in.');
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    if (!body) return fail(res, 400, 'Send an email and a password.');
    const email = String(body.email || '').trim();
    const key = `login:${email.toLowerCase()}:${ip}`;
    if (rateLimited(key)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
    const user = db.userByEmail(email);
    if (!user || !user.password_hash || !verifyPassword(String(body.password || ''), user.password_hash)) {
      noteFailure(key);
      return fail(res, 401, 'That email and password do not match.');
    }
    clearFailures(key);
    const token = db.newSession(user.id);
    return send(res, 200, { email: user.email }, { 'set-cookie': sessionCookie(req, token) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = readCookie(req);
    if (token) db.dropSession(token);
    return send(res, 200, { ok: true }, { 'set-cookie': clearCookie(req) });
  }

  const invite = /^\/api\/invite\/([\w-]+)$/.exec(path);
  if (invite) {
    const row = db.liveInvite(invite[1]);
    if (method === 'GET') {
      return row ? send(res, 200, { email: row.email }) : fail(res, 404, 'That invite link is not valid any more.');
    }
    if (method === 'POST') {
      const key = `invite:${ip}`;
      if (rateLimited(key)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
      if (!row) { noteFailure(key); return fail(res, 404, 'That invite link is not valid any more.'); }
      const body = await readJson(req);
      const problem = passwordProblem(body?.password);
      if (problem) return fail(res, 400, problem);
      db.setPassword(row.user_id, hashPassword(body.password));
      db.useInvite(row.token);
      db.dropUserSessions(row.user_id); // anyone holding an old session is signed out
      const token = db.newSession(row.user_id);
      return send(res, 200, { email: row.email }, { 'set-cookie': sessionCookie(req, token) });
    }
  }

  // ---------------------------------------------------------------- shared links (public)
  const shared = /^\/api\/shared\/([\w-]+)$/.exec(path);
  if (shared && method === 'GET') {
    const plan = db.planByShareToken(shared[1]);
    if (!plan) return fail(res, 404, 'That link is not shared any more.');
    return send(res, 200, { name: plan.name, mode: plan.share_mode, data: JSON.parse(plan.data) });
  }

  // ---------------------------------------------------------------- plans (owner only)
  if (path === '/api/plans' || path.startsWith('/api/plans/')) {
    const user = me();
    if (!user) return fail(res, 401, 'Sign in to keep plans on the server.');

    if (path === '/api/plans' && method === 'GET') {
      return send(res, 200, { plans: db.listPlans(user.id).map(planView) });
    }
    if (path === '/api/plans' && method === 'POST') {
      const body = await readJson(req);
      if (body === undefined) return fail(res, 400, 'That request body is not valid JSON.');
      const fields = planBody(body);
      if (typeof fields === 'string') return fail(res, 400, fields);
      return send(res, 201, { plan: planView(db.createPlan(user.id, fields.name, fields.data)) });
    }

    const share = /^\/api\/plans\/([\w-]+)\/share$/.exec(path);
    if (share && method === 'POST') {
      const body = await readJson(req);
      const result = db.setShare(share[1], user.id, body?.mode);
      if (result === undefined) return fail(res, 404, 'No such plan.');
      return send(res, 200, { share: result });
    }

    const one = /^\/api\/plans\/([\w-]+)$/.exec(path);
    if (one) {
      const plan = db.getPlan(one[1], user.id);
      if (!plan) return fail(res, 404, 'No such plan.'); // someone else's plan is simply not there
      if (method === 'GET') return send(res, 200, { plan: { ...planView(plan), data: JSON.parse(plan.data) } });
      if (method === 'PUT') {
        const body = await readJson(req);
        if (body === undefined) return fail(res, 400, 'That request body is not valid JSON.');
        const fields = planBody(body, { partial: true });
        if (typeof fields === 'string') return fail(res, 400, fields);
        db.updatePlan(plan.id, user.id, fields.name ?? plan.name, fields.data ?? plan.data);
        return send(res, 200, { plan: planView(db.getPlan(plan.id, user.id)) });
      }
      if (method === 'DELETE') {
        db.deletePlan(plan.id, user.id);
        return send(res, 200, { ok: true });
      }
    }
  }

  return fail(res, 404, 'No such endpoint.');
}

// Started directly (not imported by the tests)?
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => console.log(`Home Plan on http://localhost:${port}`));
}
