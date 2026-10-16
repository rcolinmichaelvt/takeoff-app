import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { latestSchemaVersion, migration2, migration3, migration4 } from './migrations.js';

const schema = `
CREATE TABLE users (
  discord_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active_key_id TEXT,
  next_transfer_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE installation_keys (
  key_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  key_id TEXT NOT NULL REFERENCES installation_keys(key_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX sessions_user ON sessions(discord_id);
CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  consumed_at INTEGER
) STRICT;
CREATE TABLE request_nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(key_id, nonce)
) STRICT;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
) STRICT;
CREATE INDEX events_user_time ON events(discord_id, created_at DESC, id DESC);
CREATE TABLE monitor_snapshots (
  name TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
) STRICT;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 1;
`;

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('SQLite transactions must be synchronous.');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'takeoff.sqlite');
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) { transaction(db, () => db.exec(schema)); version = 1; }
  if (version === 1) { transaction(db, () => db.exec(migration2)); version = 2; }
  if (version === 2) { transaction(db, () => db.exec(migration3)); version = 3; }
  if (version === 3) { transaction(db, () => db.exec(migration4)); version = 4; }
  if (version !== latestSchemaVersion) {
    db.close();
    throw new Error('Unsupported database version; use the application version that created this database.');
  }
  return db;
}

export function pruneDatabase(db, now, historyTtlMs) {
  transaction(db, () => {
    db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM request_nonces WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(now);
    // Retain consumed refresh tokens until their session expires, to detect replay.
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM events WHERE created_at <= ?').run(now - historyTtlMs);
    db.prepare('DELETE FROM audit_events WHERE created_at <= ?').run(now - 30 * 24 * 60 * 60_000);
    db.prepare('DELETE FROM inventory_history WHERE created_at <= ?').run(now - historyTtlMs);
    db.prepare('DELETE FROM restock_batches WHERE ended_at <= ?').run(now - historyTtlMs);
    db.prepare('DELETE FROM travel_estimates WHERE updated_at <= ?').run(now - historyTtlMs);
  });
}
