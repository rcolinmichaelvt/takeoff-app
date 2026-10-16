import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, device, login, ALICE, BOB } from './helpers.js';
import { AppData } from '../src/app-data.js';
import { Inventory } from '../src/inventory.js';
import { normalizeHours, DAY } from '../src/hours.js';
import { loadCatalog } from '../src/catalog.js';
import { eventPayload } from '../src/event-display.js';
import { pruneDatabase } from '../src/database.js';

const UPC = '196214158801';
const store = quantity => ({ id: '100', quantity, address: '100 Test Street', city: 'Blacksburg', state: 'VA',
  postalCode: '24060', phone: '555-0100', latitude: 37.23, longitude: -80.42, distance: 1 });
const providerHours = { timeZone: 'America/New_York', storeHours: Object.fromEntries(
  ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(day => [day, '08:00-22:00'])) };

async function setup(t) {
  const f = fixture(t);
  f.advance(Date.parse('2026-10-12T13:00:00-04:00') - f.clock());
  await login(f, device()); await login(f, device(), BOB);
  f.config.monitor.enabled = true;
  f.db.prepare('INSERT INTO zip_regions (zip,latitude,longitude,label,resolved_at) VALUES (?,?,?,?,?)')
    .run('24060', 37.23, -80.42, 'Blacksburg, VA', f.clock());
  f.geography = { async resolveZip(zip) { assert.equal(zip, '24060'); } };
  f.appData = new AppData({ ...f, catalog: loadCatalog() });
  await f.appData.saveSettings(ALICE, { zip: '24060', products: [UPC], alerts: { stockIncrease: true } });
  f.inventory = new Inventory(f);
  f.job = f.appData.jobs().values().next().value;
  f.inventory.ingest(f.job, [store(0)]);
  f.db.prepare('INSERT INTO store_hours (store_id,schedule_json,updated_at) VALUES (?,?,?)')
    .run('100', JSON.stringify(normalizeHours(providerHours, store(0))), f.clock());
  f.observe = (quantity, minutes = 0) => { f.advance(minutes * 60_000); f.inventory.ingest(f.job, [store(quantity)]); };
  f.until = (end, quantity) => { while (f.clock() < end) { f.advance(Math.min(180_000, end - f.clock())); f.inventory.ingest(f.job, [store(quantity)]); } };
  f.seed = (minutes = 60, count = 3) => f.db.prepare('INSERT INTO store_timing VALUES (?,1,?,?,?,?)')
    .run('100', count, count * minutes, count * minutes ** 2, f.clock());
  f.travel = (id = ALICE, seconds = 1200) => f.appData.saveTravel(id, '100', { zip: '24060', latitude: 37.23, longitude: -80.42, seconds });
  return f;
}

test('new-stock timer ignores sales of old available stock and trains once at the threshold', async t => {
  const f = await setup(t);
  f.observe(4); f.observe(3, 1);
  f.observe(15, 1); f.observe(14, 1); f.observe(13, 1); f.observe(12, 1);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 1);
  f.observe(11, 1); f.observe(11);
  const samples = f.db.prepare('SELECT open_minutes FROM restock_batches ORDER BY id').all().map(row => row.open_minutes);
  assert.deepEqual(samples, [1, 4]);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 2);
});

test('a sold-out observation can qualify as the first sale of a clean new batch', async t => {
  const f = await setup(t); f.observe(3); f.observe(0, 2);
  assert.equal(f.appData.intelligence.timing('100').averageOpenMinutes, 2);
  const events = f.db.prepare('SELECT kind FROM events ORDER BY id').all().map(row => row.kind);
  assert.deepEqual(events, ['stock_increase', 'sold_out']);
});

test('overlapping deliveries, missing hours, and monitoring gaps never train clean timing samples', async t => {
  const f = await setup(t);
  f.observe(12); f.observe(17, 1); f.observe(16, 1);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 0);
  assert.equal(f.db.prepare('SELECT reason FROM restock_batches ORDER BY id DESC').get().reason, 'overlapping_deliveries');
  f.observe(0, 1); f.observe(5, 1); f.observe(4, 10);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 0);
  f.observe(0, 1); f.db.exec('DELETE FROM store_hours'); f.observe(8, 1); f.observe(7, 1);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 0);
});

test('an off/on baseline creates no retroactive increase but the next real increase alerts once', async t => {
  const f = await setup(t); f.observe(8, 10);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].status, 'unknown');
  f.observe(12, 1); f.observe(12);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='stock_increase'").get().n, 1);
});

test('store averages pool clean samples across products and retained aggregates outlive visible history', async t => {
  const f = await setup(t); f.observe(4); f.observe(3, 2);
  const other = loadCatalog().find(product => product.upc !== UPC).upc;
  await f.appData.saveSettings(ALICE, { products: [UPC, other] });
  const job = { ...f.job, upc: other };
  f.inventory.ingest(job, [store(0)]); f.inventory.ingest(job, [store(4)]);
  f.advance(4 * 60_000); f.inventory.ingest(job, [store(3)]);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 2);
  assert.equal(f.appData.intelligence.timing('100').averageOpenMinutes, 3);
  f.advance(8 * DAY); pruneDatabase(f.db, f.clock(), f.config.historyTtlMs);
  assert.equal(f.appData.history('100').history.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM restock_batches').get().n, 0);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 2);
});

test('2:00 prediction with a 20-minute drive produces exactly one 1:35 warning, including while paused', async t => {
  const f = await setup(t); f.seed(); f.travel(); f.observe(12);
  await f.appData.saveSettings(ALICE, { alerts: { paused: true } });
  const expected = Date.parse('2026-10-12T14:00:00-04:00');
  f.until(expected - 25 * 60_000 - 1, 12); f.appData.intelligence.sweep(f.appData);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='approaching'").get().n, 0);
  f.advance(1); f.appData.intelligence.sweep(f.appData); f.appData.intelligence.sweep(f.appData);
  const events = f.db.prepare("SELECT * FROM events WHERE kind='approaching'").all();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].payload_json);
  assert.equal(payload.departureAt, new Date(expected - 25 * 60_000).toISOString());
  assert.equal(payload.predictedAt, new Date(expected).toISOString());
  assert.equal(payload.notificationsPaused, true);
  assert.match(payload.address, /100 Test Street/);
  f.reopen(); f.appData = new AppData({ ...f, catalog: loadCatalog() });
  f.appData.intelligence.sweep(f.appData);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='approaching'").get().n, 1);
});

test('prediction updates are recomputed and never issue a second warning for the same account/batch', async t => {
  const f = await setup(t); f.seed(); f.travel(); f.observe(12);
  f.until(f.clock() + 35 * 60_000, 12); f.appData.intelligence.sweep(f.appData);
  f.db.prepare('UPDATE store_timing SET total_minutes=270,squared_minutes=24300 WHERE store_id=?').run('100');
  f.until(f.clock() + 30 * 60_000, 12); f.appData.intelligence.sweep(f.appData);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='approaching'").get().n, 1);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].forecast.expectedAt, '2026-10-12T18:30:00.000Z');
});

test('passing the prediction keeps back stock yellow and marks the estimate unconfirmed', async t => {
  const f = await setup(t); f.seed(); f.observe(12);
  f.until(f.clock() + 65 * 60_000, 12);
  const stock = f.appData.store(ALICE, '100').inventory[0];
  assert.equal(stock.status, 'back'); assert.equal(stock.forecast.state, 'expected_unconfirmed');
});

test('sale, exclusion, disabled alert, missing ETA, or a late restart suppress departure warnings', async t => {
  for (const reason of ['sale', 'excluded', 'disabled', 'no_eta', 'late']) {
    await t.test(reason, async t => {
      const f = await setup(t); f.seed(); f.observe(12);
      if (reason !== 'no_eta') f.travel();
      if (reason === 'excluded') f.appData.saveStorePreferences(ALICE, '100', { excluded: true });
      if (reason === 'disabled') await f.appData.saveSettings(ALICE, { alerts: { approaching: false } });
      if (reason === 'sale') f.observe(11, 1);
      f.until(Date.parse(`2026-10-12T13:${reason === 'late' ? '40' : '35'}:00-04:00`), reason === 'sale' ? 11 : 12);
      f.appData.intelligence.sweep(f.appData);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='approaching'").get().n, 0);
    });
  }
});

test('approaching warnings require adequate samples and honor personal product selection', async t => {
  const f = await setup(t); f.seed(60, 1); f.travel(); f.observe(12);
  await f.appData.saveSettings(BOB, { zip: '24060', products: [] });
  f.until(f.clock() + 35 * 60_000, 12); f.appData.intelligence.sweep(f.appData);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='approaching'").get().n, 0);
  assert.equal(f.appData.store(ALICE, '100').inventory[0].forecast.confidence, 'low');
  f.db.prepare('UPDATE store_timing SET samples=3,total_minutes=180,squared_minutes=10800').run();
  f.appData.intelligence.sweep(f.appData);
  assert.deepEqual(f.db.prepare("SELECT discord_id FROM events WHERE kind='approaching'").all().map(row => row.discord_id), [ALICE]);
});

test('saved drive estimates are account-scoped, expire, and cannot target a different ZIP or arbitrary store', async t => {
  const f = await setup(t); f.travel();
  assert.equal(f.appData.store(ALICE, '100').travelEstimate.seconds, 1200);
  assert.equal(f.appData.store(BOB, '100').travelEstimate, null);
  assert.throws(() => f.appData.saveTravel(ALICE, '100', { zip: '00000', latitude: 37.23, longitude: -80.42, seconds: 1 }), { code: 'INVALID_TRAVEL_ESTIMATE' });
  assert.throws(() => f.appData.saveTravel(ALICE, '100', { zip: '24060', latitude: 0, longitude: 0, seconds: 1 }), { code: 'INVALID_TRAVEL_ESTIMATE' });
  assert.throws(() => f.appData.saveTravel(ALICE, '100', { zip: '24060', latitude: 37.23, longitude: -80.42, seconds: 1, discordId: BOB }), { code: 'INVALID_TRAVEL_ESTIMATE' });
  assert.equal(f.appData.travelCandidates(ALICE).length, 0);
  f.advance(6 * 60 * 60_000); f.observe(0);
  assert.equal(f.appData.travelCandidates(ALICE).length, 1);
  f.advance(DAY); assert.equal(f.appData.store(ALICE, '100').travelEstimate, null);
});


test('a changed schedule or lost coverage invalidates an active timing sample', async t => {
  const f = await setup(t); f.observe(12);
  const changed = normalizeHours({ ...providerHours, storeHours: { ...providerHours.storeHours, Monday: '09:00-22:00' } }, store(0));
  f.db.prepare('UPDATE store_hours SET schedule_json=?').run(JSON.stringify(changed));
  f.appData.intelligence.sweep(f.appData); f.observe(11, 1);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 0);
  f.observe(0, 1); f.observe(12, 1);
  await f.appData.saveSettings(ALICE, { products: [] }); f.appData.intelligence.sweep(f.appData);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM restock_batches WHERE state='pending'").get().n, 0);
});

test('legacy and new inbox events display addresses instead of store numbers', async t => {
  const f = await setup(t); f.observe(12);
  const row = f.db.prepare('SELECT * FROM events').get();
  assert.equal(eventPayload(f.db, row).address, '100 Test Street, Blacksburg, VA, 24060');
  const legacy = { payload_json: JSON.stringify({ storeId: '100', body: 'Dollar General #100: 12 → 11.' }) };
  const payload = eventPayload(f.db, legacy);
  assert.equal(payload.body, '12 → 11.'); assert.match(payload.address, /100 Test Street/);
});
