import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, device, login, ALICE, BOB } from './helpers.js';
import { AppData } from '../src/app-data.js';
import { createGeography } from '../src/geography.js';
import { Inventory, observeInventory } from '../src/inventory.js';
import { createMonitor } from '../src/monitor.js';
import { createDGProvider, normalizeStores, ProviderError } from '../src/dg-provider.js';
import { loadCatalog } from '../src/catalog.js';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, pruneDatabase } from '../src/database.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const UPC = '196214158801';
const store = quantity => ({ id: '100', quantity, address: '100 Test Street', city: 'Blacksburg', state: 'VA',
  postalCode: '24060', phone: '555-0100', latitude: 37.23, longitude: -80.42, distance: 1 });
async function setup(t) {
  const f = fixture(t);
  await login(f, device()); await login(f, device(), BOB);
  f.db.prepare('INSERT INTO zip_regions (zip,latitude,longitude,label,resolved_at) VALUES (?,?,?,?,?)')
    .run('24060', 37.23, -80.42, 'Blacksburg, VA', f.clock());
  const geography = createGeography({ ...f, fetchImpl: async () => { throw new Error('No network expected'); } });
  const appData = new AppData({ ...f, catalog: loadCatalog(), geography });
  await appData.saveSettings(ALICE, { zip: '24060', products: [UPC] });
  const inventory = new Inventory({ ...f, appData });
  const job = appData.jobs().values().next().value;
  return { ...f, geography, appData, inventory, job };
}

test('settings validate catalog and ZIP, preserve flags, and deduplicate shared subscriptions', async t => {
  const f = await setup(t);
  await f.appData.saveSettings(BOB, { zip: '24060', products: [UPC] });
  assert.equal(f.appData.jobs().size, 1);
  await f.appData.saveSettings(ALICE, { alerts: { paused: true } });
  assert.equal(f.appData.settings(ALICE).alerts.soldOut, true);
  assert.equal(f.appData.settings(BOB).alerts.paused, false);
  await assert.rejects(f.appData.saveSettings(ALICE, { products: ['unapproved'] }), { code: 'INVALID_PRODUCTS' });
  await assert.rejects(f.appData.saveSettings(ALICE, { zip: '24060/../../' }), { code: 'INVALID_ZIP' });
  await assert.rejects(f.appData.saveSettings(ALICE, { discordId: BOB }), { code: 'INVALID_INPUT' });
  await f.appData.saveSettings(ALICE, { products: [] });
  assert.equal(f.appData.jobs().size, 1);
  f.config.allowedIds.delete(BOB);
  assert.equal(f.appData.jobs().size, 0);
});

test('private notes and favorites stay private; public notes require moderator role', async t => {
  const f = await setup(t);
  f.inventory.ingest(f.job, [store(0)]);
  f.appData.saveStorePreferences(ALICE, '100', { privateNote: 'My private detail', favorite: true });
  assert.equal(f.appData.store(ALICE, '100').privateNote, 'My private detail');
  assert.equal(f.appData.store(BOB, '100').privateNote, '');
  assert.equal(f.appData.store(BOB, '100').favorite, false);
  assert.throws(() => f.appData.savePublicNote(BOB, '100', { note: 'No' }), { code: 'MODERATOR_REQUIRED' });
  f.appData.savePublicNote(ALICE, '100', { note: 'Limit one per item' });
  assert.equal(f.appData.store(BOB, '100').publicNote, 'Limit one per item');
  assert.throws(() => f.appData.saveStorePreferences(ALICE, '100', { privateNote: 'a'.repeat(2001) }), { code: 'INVALID_INPUT' });
});

test('old available stock must be exhausted before a new batch qualifies as selling', async t => {
  const f = await setup(t), seen = [];
  for (const quantity of [0, 4, 3, 15, 14, 13, 12, 11]) {
    f.inventory.ingest(f.job, [store(quantity)]);
    seen.push(f.appData.store(ALICE, '100').inventory[0].status);
    f.advance(10_000);
  }
  assert.deepEqual(seen, ['out', 'back', 'available', 'available', 'available', 'available', 'back', 'available']);
  const signals = f.db.prepare("SELECT quantity FROM inventory_history WHERE kind='first_decrease' ORDER BY id").all();
  assert.deepEqual(signals.map(s => s.quantity), [3, 11]);
});

test('baseline positive quantities and interrupted observations stay unknown', () => {
  const baseline = observeInventory(null, 10, 1000);
  assert.equal(baseline.status, 'unknown');
  const old = { quantity: 10, status: 'available', pending_quantity: 0, observed_at: 1000 };
  const resumed = observeInventory(old, 15, 1000 + 10 * 60_000);
  assert.equal(resumed.status, 'unknown');
  assert.equal(resumed.event, null);
  assert.equal(resumed.pending, 0);
});

test('stale and abandoned coverage never claims fresh stock or invents a zero', async t => {
  const f = await setup(t);
  f.inventory.ingest(f.job, [store(0)]); f.advance(10_000); f.inventory.ingest(f.job, [store(5)]);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].status, 'back');
  await f.appData.saveSettings(ALICE, { products: [] });
  const abandoned = f.appData.store(ALICE, '100').inventory[0];
  assert.equal(abandoned.status, 'unknown'); assert.equal(abandoned.quantity, 5); assert.equal(abandoned.stale, true);
  f.inventory.ingest(f.job, [store(0)]);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].quantity, 5);
  await f.appData.saveSettings(ALICE, { products: [UPC] });
  f.advance(10 * 60_000);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].stale, true);
});

test('alerts match followed products and exclusions, survive pause, and overlapping observations do not duplicate them', async t => {
  const f = await setup(t);
  await f.appData.saveSettings(BOB, { zip: '24060', products: [UPC] });
  f.inventory.ingest(f.job, [store(0)]);
  f.appData.saveStorePreferences(BOB, '100', { excluded: true });
  await f.appData.saveSettings(ALICE, { alerts: { paused: true } });
  f.advance(10_000); f.inventory.ingest(f.job, [store(5)]);
  f.advance(10_000); f.inventory.ingest(f.job, [store(4)]);
  f.inventory.ingest(f.job, [store(4)]);
  const events = f.db.prepare('SELECT * FROM events').all();
  assert.equal(events.length, 1); assert.equal(events[0].discord_id, ALICE);
  assert.equal(JSON.parse(events[0].payload_json).notificationsPaused, true);
});

test('worker deduplicates ZIP/product requests, switches to fast cadence, and honors account-wide backoff', async t => {
  const f = await setup(t); let calls = 0, fail = false, quantity = 0;
  f.config.monitor.enabled = true; f.config.monitor.geocodeStores = false;
  await f.appData.saveSettings(BOB, { zip: '24060', products: [UPC] });
  const monitor = createMonitor({ ...f, logger: { warn() {} }, provider: {
    async fetchInventory() { calls++; if (fail) throw new ProviderError('DG_RATE_LIMITED', 120_000); return [store(quantity)]; },
  } });
  await monitor.tick(); assert.equal(calls, 1);
  await monitor.tick(); assert.equal(calls, 1);
  quantity = 10; f.advance(180_000); await monitor.tick(); assert.equal(calls, 2);
  assert.equal(f.db.prepare('SELECT next_poll_at FROM monitor_jobs').get().next_poll_at, f.clock() + 10_000);
  fail = true; f.advance(10_000); await monitor.tick(); assert.equal(calls, 3);
  f.advance(100_000); await monitor.tick(); assert.equal(calls, 3);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].quantity, 10);
});

test('nearby filtering and cursor pages do not silently include stores outside 25 miles', async t => {
  const f = await setup(t);
  f.inventory.ingest(f.job, [store(2), { ...store(0), id: '200' }, { ...store(3), id: '300', latitude: 40, longitude: -80, distance: 400 }]);
  const first = f.appData.stores(ALICE, { limit: '1' });
  assert.equal(first.stores.length, 1); assert.equal(first.nextCursor, '100');
  const next = f.appData.stores(ALICE, { after: first.nextCursor, limit: '1' });
  assert.equal(next.stores[0].id, '200'); assert.equal(next.nextCursor, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stores').get().n, 2);
});

test('seven-day history excludes and prunes older observations', async t => {
  const f = await setup(t);
  f.inventory.ingest(f.job, [store(0)]);
  f.advance(f.config.historyTtlMs + 1);
  assert.equal(f.appData.history('100').history.length, 0);
  pruneDatabase(f.db, f.clock(), f.config.historyTtlMs);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory_history').get().n, 0);
});

test('ZIP lookup preserves leading zero, caches results, and rejects untrusted paths', async t => {
  const f = fixture(t); let calls = 0;
  const geography = createGeography({ ...f, fetchImpl: async url => {
    calls++; assert.equal(url, 'https://api.zippopotam.us/us/02108');
    return Response.json({ 'country abbreviation': 'US', places: [{ latitude: '42.35', longitude: '-71.06', 'place name': 'Boston', 'state abbreviation': 'MA' }] });
  } });
  assert.equal((await geography.resolveZip('02108')).zip, '02108');
  await geography.resolveZip('02108'); assert.equal(calls, 1);
  await assert.rejects(geography.resolveZip('https://example.com'), { code: 'INVALID_ZIP' });
});

test('invalid DG inventory never coerces missing quantities into sold out', () => {
  for (const qty of [undefined, null, '', '   ', false, [], {}, -1, 'abc', 1.5]) {
    assert.throws(() => normalizeStores({ stores: [{ storeNumber: '100', productQTY: qty }] }), { code: 'DG_INVALID_RESPONSE' });
  }
  assert.equal(normalizeStores({ stores: [{ storeNumber: '100', productQTY: '0' }] })[0].quantity, 0);
  assert.throws(() => normalizeStores({ result: [] }), { code: 'DG_INVALID_RESPONSE' });
});

test('DG token refresh retries once, keeps secrets off result data, and respects 429', async t => {
  const f = fixture(t); let calls = 0;
  const provider = createDGProvider(f.config, async (url, options) => {
    calls++;
    if (calls === 1) return new Response('', { status: 401 });
    if (calls === 2) { assert.ok(url.includes('refreshCookies')); return Response.json({ idToken: 'fixture-secret' }); }
    assert.equal(options.headers.authorization, 'Bearer fixture-secret');
    assert.equal(options.body.get('radius'), '25');
    return Response.json({ stores: [{ storeNumber: '100', productQTY: 4 }] });
  });
  const data = await provider.fetchInventory({ latitude: 37, longitude: -80 }, UPC);
  assert.equal(calls, 3); assert.equal(data[0].quantity, 4); assert.equal(JSON.stringify(data).includes('fixture-secret'), false);
  const limited = createDGProvider(f.config, async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  await assert.rejects(limited.fetchInventory({ latitude: 37, longitude: -80 }, UPC), { code: 'DG_RATE_LIMITED', retryMs: 120000 });
});

test('the actual Milestone 1 schema upgrades without losing accounts or cooldowns', t => {
  // Recreate the previously delivered module in an isolated temp directory, never
  // a production database. This exercises a real v1 -> current upgrade.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takeoff-upgrade-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previous = new DatabaseSync(path.join(directory, 'takeoff.sqlite'));
  previous.exec(fs.readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'));
  previous.prepare('INSERT INTO users (discord_id,display_name,next_transfer_at,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(ALICE, 'Preserved', 9999999999999, 1, 1);
  previous.prepare('INSERT INTO installation_keys (key_id,discord_id,public_key,device_name,created_at) VALUES (?,?,?,?,?)')
    .run('fixture-key', ALICE, device().publicKey, 'Preserved iPhone', 1);
  previous.prepare('INSERT INTO sessions (id,discord_id,key_id,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run('fixture-session', ALICE, 'fixture-key', 1, 9999999999999);
  previous.close();
  const db = openDatabase(directory);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT next_transfer_at FROM users').get().next_transfer_at, 9999999999999);
  assert.equal(db.prepare('SELECT id FROM sessions').get().id, 'fixture-session');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preferences').get().n, 0);
  db.close();
});

test('a slow address lookup does not block inventory polling and a distant map match is rejected', async t => {
  const f = await setup(t); f.config.monitor.enabled = true; f.config.monitor.geocodeStores = true;
  const noLocation = quantity => ({ ...store(quantity), latitude: null, longitude: null });
  f.inventory.ingest(f.job, [noLocation(0)]);
  let resolveAddress, requests = 0;
  const monitor = createMonitor({ ...f, logger: { warn() {} },
    geography: { locateStore: () => new Promise(resolve => { resolveAddress = resolve; }) },
    provider: { async fetchInventory() { requests++; return [noLocation(5)]; } },
  });
  const lookup = monitor.geocodeTick();
  await monitor.tick();
  assert.equal(requests, 1);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].status, 'back');
  resolveAddress({ latitude: 40, longitude: -80 }); await lookup;
  assert.equal(f.appData.store(ALICE, '100').latitude, null);
  await monitor.stop();
});

test('changing access during an asynchronous ZIP lookup cannot save settings with a revoked session', async t => {
  const f = fixture(t), dev = device(), tokens = await login(f, dev);
  const { signedRequest } = await import('./helpers.js');
  const session = f.auth.authenticate(tokens.accessToken, signedRequest(dev, { token: tokens.accessToken, now: f.clock() }));
  let finish;
  const geography = { resolveZip: () => new Promise(resolve => { finish = () => {
    f.db.prepare('INSERT INTO zip_regions (zip,latitude,longitude,label,resolved_at) VALUES (?,?,?,?,?)')
      .run('24060', 37.23, -80.42, 'Blacksburg', f.clock()); resolve();
  }; }) };
  const data = new AppData({ ...f, catalog: loadCatalog(), geography });
  const pending = data.saveSettings(ALICE, { zip: '24060' }, () => f.auth.assertActive(session));
  f.auth.logout(session); finish();
  await assert.rejects(pending, { code: 'SESSION_REVOKED' });
  assert.equal(data.settings(ALICE).zip, null);
});
