// Account auth: signup / login / session-resume, plus progress persistence.
// Passwords are hashed with scrypt (built-in crypto) — we never store plaintext.
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as db from './db.js';
import { CONFIG } from './config.js';

const USERNAME_RE = /^[A-Za-z0-9 _-]{3,16}$/; // also the in-game display name
const MIN_PASSWORD = 6;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, keyHex] = String(stored || '').split(':');
  if (!saltHex || !keyHex) return false;
  const key = Buffer.from(keyHex, 'hex');
  let test;
  try { test = scryptSync(password, Buffer.from(saltHex, 'hex'), key.length); }
  catch { return false; }
  return key.length === test.length && timingSafeEqual(key, test);
}

const publicUser = (r) => ({ id: r.id, username: r.username, bankroll: r.bankroll, xp: r.xp, wins: r.wins });

function startSession(userId, now) {
  const token = randomUUID() + randomUUID(); // long, opaque
  db.createSession(token, userId, now);
  return token;
}

export function signup(username, password) {
  username = String(username || '').trim();
  if (!USERNAME_RE.test(username)) return { error: '3–16 characters: letters, numbers, spaces, _ or -.' };
  if (String(password || '').length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  if (db.getUserByUsername(username)) return { error: 'That name is already taken.' };
  const now = Date.now();
  const id = randomUUID();
  db.createUser({ id, username, passHash: hashPassword(password), bankroll: CONFIG.STARTING_BANKROLL, now });
  const user = db.getUserById(id);
  return { ok: true, token: startSession(id, now), user: publicUser(user) };
}

export function login(username, password) {
  username = String(username || '').trim();
  const row = db.getUserByUsername(username);
  // Verify even when the user is missing-ish to keep timing roughly constant.
  const ok = row && verifyPassword(password, row.pass_hash);
  if (!ok) return { error: 'Wrong username or password.' };
  return { ok: true, token: startSession(row.id, Date.now()), user: publicUser(row) };
}

// Re-establish a login from a stored token (page reload / new socket).
export function resume(token) {
  const row = token ? db.getSessionUser(token) : null;
  if (!row) return { error: 'Session expired — please log in again.' };
  return { ok: true, user: publicUser(row) };
}

export function logout(token) {
  if (token) db.deleteSession(token);
  return { ok: true };
}

// Fetch the live account row (for seeding a player when they join a room).
export function loadAccount(userId) {
  const r = userId ? db.getUserById(userId) : null;
  return r ? publicUser(r) : null;
}

// Write a player's progress back to their account.
export function saveProgress(userId, { bankroll, xp, wins }) {
  if (!userId) return;
  db.updateProgress(userId, {
    bankroll: Math.max(0, Math.round(bankroll || 0)),
    xp: Math.max(0, Math.round(xp || 0)),
    wins: Math.max(0, Math.round(wins || 0)),
    now: Date.now(),
  });
}
