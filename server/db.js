// Persistent storage for accounts + progress, backed by SQLite (Node's built-in
// node:sqlite — no external dependency, single file on disk, survives restarts).
// Guests never touch this; only logged-in users are stored here.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.POTLUCK_DB || path.join(__dirname, '..', 'data', 'potluck.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash  TEXT NOT NULL,
    bankroll   INTEGER NOT NULL,
    xp         INTEGER NOT NULL DEFAULT 0,
    wins       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const stmt = {
  insertUser: db.prepare(
    `INSERT INTO users (id, username, pass_hash, bankroll, xp, wins, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  byUsername: db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  byId: db.prepare(`SELECT * FROM users WHERE id = ?`),
  updateProgress: db.prepare(`UPDATE users SET bankroll = ?, xp = ?, wins = ?, updated_at = ? WHERE id = ?`),
  insertSession: db.prepare(`INSERT OR REPLACE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`),
  sessionUser: db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
};

export function createUser({ id, username, passHash, bankroll, now }) {
  stmt.insertUser.run(id, username, passHash, bankroll, 0, 0, now, now);
}
export function getUserByUsername(username) { return stmt.byUsername.get(username) || null; }
export function getUserById(id) { return stmt.byId.get(id) || null; }
export function updateProgress(id, { bankroll, xp, wins, now }) {
  stmt.updateProgress.run(bankroll, xp, wins, now, id);
}
export function createSession(token, userId, now) { stmt.insertSession.run(token, userId, now); }
export function getSessionUser(token) { return stmt.sessionUser.get(token) || null; }
export function deleteSession(token) { stmt.deleteSession.run(token); }
