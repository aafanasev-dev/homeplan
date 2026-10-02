// SQLite storage. This is the only file in the project that writes SQL: swapping the database
// later means rewriting openDb() and nothing else. No npm dependencies — node:sqlite is built in.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  share_token TEXT UNIQUE,
  share_mode  TEXT CHECK (share_mode IN ('view', 'copy'))
);
CREATE INDEX IF NOT EXISTS plans_by_user ON plans(user_id, updated_at DESC);
`;

const now = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

/** A URL-safe random token. */
export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

/**
 * Open (and create) the database in `dir`, returning every query the server needs.
 * `:memory:` as the directory keeps it in memory, which the tests use.
 */
export function openDb(dir = process.env.DATA_DIR || './data') {
  let file = ':memory:';
  if (dir !== ':memory:') {
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'homeplan.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const sel = {
    userByEmail: q('SELECT * FROM users WHERE email = ?'),
    userById: q('SELECT * FROM users WHERE id = ?'),
    insertUser: q('INSERT INTO users (email, created_at) VALUES (?, ?)'),
    setPassword: q('UPDATE users SET password_hash = ? WHERE id = ?'),

    insertInvite: q('INSERT INTO invites (token, user_id, expires_at) VALUES (?, ?, ?)'),
    invite: q(`SELECT i.*, u.email FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token = ?`),
    useInvite: q('UPDATE invites SET used_at = ? WHERE token = ? AND used_at IS NULL'),
    dropUserInvites: q('DELETE FROM invites WHERE user_id = ?'),

    insertSession: q('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    session: q(`SELECT s.token, s.expires_at, u.id, u.email FROM sessions s
                JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    dropSession: q('DELETE FROM sessions WHERE token = ?'),
    dropUserSessions: q('DELETE FROM sessions WHERE user_id = ?'),
    dropOldSessions: q('DELETE FROM sessions WHERE expires_at < ?'),

    listPlans: q(`SELECT id, name, updated_at, share_token, share_mode FROM plans
                  WHERE user_id = ? ORDER BY updated_at DESC`),
    plan: q('SELECT * FROM plans WHERE id = ? AND user_id = ?'),
    insertPlan: q(`INSERT INTO plans (id, user_id, name, data, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)`),
    updatePlan: q('UPDATE plans SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
    deletePlan: q('DELETE FROM plans WHERE id = ? AND user_id = ?'),
    setShare: q('UPDATE plans SET share_token = ?, share_mode = ? WHERE id = ? AND user_id = ?'),
    planByShare: q(`SELECT id, name, data, share_mode FROM plans WHERE share_token = ? AND share_mode IS NOT NULL`),
  };

  return {
    db,
    close: () => db.close(),

    // ---------------------------------------------------------------- users
    userByEmail: (email) => sel.userByEmail.get(String(email).trim()) ?? null,
    userById: (id) => sel.userById.get(id) ?? null,
    createUser(email) {
      sel.insertUser.run(String(email).trim(), now());
      return this.userByEmail(email);
    },
    setPassword: (userId, hash) => sel.setPassword.run(hash, userId),

    // ---------------------------------------------------------------- invites
    /** Replace any outstanding invite for the user with a fresh one, and return its token. */
    newInvite(userId, hours = Number(process.env.INVITE_HOURS) || 72) {
      sel.dropUserInvites.run(userId);
      const t = token(24);
      sel.insertInvite.run(t, userId, inHours(hours));
      return t;
    },
    /** The invite, with the user's email, when it exists, is unused and has not expired. */
    liveInvite(t) {
      const row = sel.invite.get(String(t));
      if (!row || row.used_at || row.expires_at < now()) return null;
      return row;
    },
    useInvite: (t) => sel.useInvite.run(now(), String(t)).changes > 0,

    // ---------------------------------------------------------------- sessions
    newSession(userId, days = Number(process.env.SESSION_DAYS) || 30) {
      sel.dropOldSessions.run(now());
      const t = token(32);
      sel.insertSession.run(t, userId, now(), inDays(days));
      return t;
    },
    sessionUser(t) {
      if (!t) return null;
      const row = sel.session.get(String(t));
      if (!row) return null;
      if (row.expires_at < now()) { sel.dropSession.run(String(t)); return null; }
      return { id: row.id, email: row.email };
    },
    dropSession: (t) => sel.dropSession.run(String(t)),
    dropUserSessions: (userId) => sel.dropUserSessions.run(userId),

    // ---------------------------------------------------------------- plans
    listPlans: (userId) => sel.listPlans.all(userId),
    getPlan: (id, userId) => sel.plan.get(String(id), userId) ?? null,
    createPlan(userId, name, data) {
      const id = token(9);
      const t = now();
      sel.insertPlan.run(id, userId, name, data, t, t);
      return this.getPlan(id, userId);
    },
    updatePlan: (id, userId, name, data) => sel.updatePlan.run(name, data, now(), String(id), userId).changes > 0,
    deletePlan: (id, userId) => sel.deletePlan.run(String(id), userId).changes > 0,

    // ---------------------------------------------------------------- shares
    /**
     * Turn sharing on in `mode` (keeping the link a plan already has) or off, which clears the
     * token for good. Returns { token, mode } or null.
     */
    setShare(id, userId, mode) {
      const plan = this.getPlan(id, userId);
      if (!plan) return undefined;
      if (mode !== 'view' && mode !== 'copy') {
        sel.setShare.run(null, null, String(id), userId);
        return null;
      }
      const t = plan.share_token || token(20);
      sel.setShare.run(t, mode, String(id), userId);
      return { token: t, mode };
    },
    planByShareToken: (t) => sel.planByShare.get(String(t)) ?? null,
  };
}
