import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fixture, device, login, authenticate, signedRequest, ALICE } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { importCache } from '../src/import-cache.js';
import { pruneDatabase } from '../src/database.js';
import { prepareRestore } from '../src/recovery.js';

test('sessions, replay protection, events, and snapshots survive database reopen', async t => {
  const f = fixture(t), dev = device(), tokens = await login(f, dev);
  const usedRequest = signedRequest(dev, { token: tokens.accessToken, now: f.clock() });
  f.auth.authenticate(tokens.accessToken, usedRequest);
  f.db.prepare('INSERT INTO events (discord_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(ALICE, 'sold_out', '{}', f.clock());
  const file = path.join(f.directory, 'cache.json');
  fs.writeFileSync(file, JSON.stringify({ lastSaved: new Date(f.clock()).toISOString(), state: {
    '196214158801': { '100': { qty: 5, address: 'Fixture only' } },
  }, timing: { byStore: { '100': { count: 1, totalMs: 86_400_000 } } } }));
  assert.equal(importCache(f.db, file, f.clock()).observations, 1);
  f.reopen();
  assert.throws(() => f.auth.authenticate(tokens.accessToken, usedRequest), { code: 'REPLAYED_REQUEST' });
  assert.equal(authenticate(f, dev, tokens.accessToken).discord_id, ALICE);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  const snapshot = JSON.parse(f.db.prepare('SELECT payload_json FROM monitor_snapshots').get().payload_json);
  assert.equal(snapshot.timingBasis, 'elapsed-clock-time');
  assert.equal(snapshot.shelfStatus, 'unknown');
  assert.equal(snapshot.legacyTiming.byStore['100'].count, 1);
  assert.throws(() => importCache(f.db, file), /already imported/);
});

test('online SQLite backup contains a consistent, usable database', async t => {
  const f = fixture(t), dev = device(), tokens = await login(f, dev);
  const destination = path.join(f.directory, 'backup.sqlite');
  await backup(f.db, destination);
  const copy = new DatabaseSync(destination, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(copy.prepare('SELECT discord_id FROM users').get().discord_id, ALICE);
  copy.close();
  assert.equal(authenticate(f, dev, tokens.accessToken).discord_id, ALICE);
});

test('an offline restore invalidates old sessions and protects transfer cooldowns without changing the source', async t => {
  const f = fixture(t), dev = device(), tokens = await login(f, dev);
  const source = path.join(f.directory, 'backup.sqlite');
  const destination = path.join(f.directory, 'prepared.sqlite');
  await backup(f.db, source);
  await prepareRestore(source, destination, f.clock());
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    for (const table of ['sessions', 'access_tokens', 'refresh_tokens', 'oauth_flows', 'login_codes']) {
      assert.equal(copy.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
    assert.equal(copy.prepare('SELECT next_transfer_at FROM users').get().next_transfer_at,
      f.clock() + f.config.transferCooldownMs);
  } finally { copy.close(); }
  const original = new DatabaseSync(source, { readOnly: true });
  assert.equal(original.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
  original.close();
  assert.equal(authenticate(f, dev, tokens.accessToken).discord_id, ALICE);
  await assert.rejects(prepareRestore(source, destination), /must not already exist/);
});

test('cleanup removes expired events and challenges but retains refresh replay history', async t => {
  const f = fixture(t), dev = device();
  await login(f, dev);
  f.db.prepare('INSERT INTO events (discord_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(ALICE, 'old', '{}', f.clock() - f.config.historyTtlMs - 1);
  pruneDatabase(f.db, f.clock(), f.config.historyTtlMs);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM refresh_tokens').get().n, 1);
});

test('production refuses HTTP origins, missing volumes, invalid allowlists, and off-volume paths', t => {
  const f = fixture(t);
  const env = { NODE_ENV: 'production', DISCORD_CLIENT_ID: f.config.discordClientId,
    DISCORD_CLIENT_SECRET: f.config.discordClientSecret, PUBLIC_BASE_URL: 'https://takeoff.example',
    DATA_DIR: '/data', RAILWAY_VOLUME_MOUNT_PATH: '/data', ALLOWED_DISCORD_IDS: ALICE };
  assert.equal(loadConfig(env).production, true);
  assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: 'http://takeoff.example' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, RAILWAY_VOLUME_MOUNT_PATH: '' }), /mounted Railway volume/);
  assert.throws(() => loadConfig({ ...env, DATA_DIR: '/tmp' }), /mounted Railway volume/);
  assert.throws(() => loadConfig({ ...env, ALLOWED_DISCORD_IDS: 'username' }), /numeric user IDs/);
  assert.throws(() => loadConfig({ ...env, MODERATOR_DISCORD_IDS: '923456789012345678' }), /also appear/);
});

test('invalid legacy inventories fail before being persisted', t => {
  const f = fixture(t), file = path.join(f.directory, 'invalid.json');
  fs.writeFileSync(file, JSON.stringify({ state: { '196214158801': { '100': { qty: -1 } } } }));
  assert.throws(() => importCache(f.db, file), /Invalid inventory/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM monitor_snapshots').get().n, 0);
});
