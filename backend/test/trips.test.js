import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, device, login, ALICE, BOB } from './helpers.js';
import { AppData } from '../src/app-data.js';
import { Inventory } from '../src/inventory.js';
import { loadCatalog } from '../src/catalog.js';
import { orderStops, MAX_TRIP_STOPS } from '../src/trips.js';
import { normalizeHours, inventoryHoursFields } from '../src/hours.js';
const UPC = '196214158801';
const origin = { latitude: 37.24, longitude: -80.41 };
const hoursInfo = Object.fromEntries(inventoryHoursFields.map(k => [k, '0800:2200']));
const store = (id, quantity) => ({ id, quantity, address: `${id} Test Street`, city: 'Blacksburg', state: 'VA',
  postalCode: '24060', phone: '555-0100', latitude: 37.23, longitude: -80.42 + (Number(id) - 100) * .01, distance: 1, hoursInfo });
async function setup(t) {
  const f = fixture(t); await login(f, device()); await login(f, device(), BOB);
  f.advance(Date.parse('2026-10-12T13:00:00-04:00') - f.clock()); f.config.monitor.enabled = true;
  f.db.prepare('INSERT INTO zip_regions VALUES (?,?,?,?,?)').run('24060', 37.23, -80.42, 'Blacksburg, VA', f.clock());
  f.appData = new AppData({ ...f, catalog: loadCatalog(), geography: { async resolveZip() {} } });
  for (const id of [ALICE, BOB]) await f.appData.saveSettings(id, { zip: '24060', products: [UPC] });
  f.inventory = new Inventory(f); f.job = f.appData.jobs().values().next().value;
  f.observe = (id, qty) => f.inventory.ingest(f.job, [store(id, qty)]);
  for (const qty of [0, 5, 4]) for (const id of ['100', '101', '102']) f.observe(id, qty);
  f.trips = f.appData.trips;
  f.input = (ids = ['100', '101'], seconds = 600) => {
    const { trip } = f.trips.preview(ALICE, { origin, products: [UPC], storeIds: ids });
    return { version: f.trips.get(ALICE).version, products: [UPC], storeIds: trip.stops.map(s => s.store.id),
      departureAt: trip.departureAt, zip: trip.zip, origin: trip.origin,
      legs: trip.stops.map((stop, index) => ({ storeId: stop.store.id, seconds, meters: 1000,
        from: index ? trip.stops[index - 1].store : trip.origin, to: stop.store })) };
  };
  return f;
}

test('suggestion is a deterministic open route without a return-to-start stop', () => {
  const origin = { latitude: 0, longitude: 0 };
  const points = [3, 1, 2].map(n => ({ id: String(n), latitude: 0, longitude: n }));
  assert.deepEqual(orderStops(origin, points).map(s => s.id), ['1', '2', '3']);
  assert.equal(MAX_TRIP_STOPS, 10);
});

test('only fresh for-sale stores start a trip; forecasts stay optional and exclusions stay out', async t => {
  const f = await setup(t); f.observe('100', 0); f.observe('101', 0); f.observe('101', 7);
  const preview = f.trips.preview(ALICE, { origin, products: [UPC] });
  assert.deepEqual(preview.trip.stops.map(s => s.store.id), ['102']);
  assert.equal(preview.trip.canOpen, false);
  f.appData.saveStorePreferences(ALICE, '102', { excluded: true });
  assert.equal(f.trips.preview(ALICE, { origin, products: [UPC] }).trip.stops.length, 0);
});

test('saved trips are private, persist across reopen, and use successive road legs plus stop time', async t => {
  const f = await setup(t); f.appData.saveStorePreferences(ALICE, '100', { privateNote: 'private' });
  const saved = f.trips.save(ALICE, f.input());
  assert.equal(saved.version, 1); assert.equal(saved.trip.canOpen, true);
  assert.equal(saved.trip.stops[0].arrivalAt, '2026-10-12T17:10:00.000Z');
  assert.equal(saved.trip.stops[1].arrivalAt, '2026-10-12T17:25:00.000Z');
  assert.equal(saved.trip.totalDriveSeconds, 1200);
  assert.equal(f.trips.get(BOB).trip, null);
  assert.equal(f.trips.preview(BOB, { origin, products: [UPC] }).candidates.find(s => s.id === '100').privateNote, '');
  f.reopen();
  const app = new AppData({ ...f, catalog: loadCatalog() });
  assert.equal(app.trips.get(ALICE).trip.stops.length, 2);
});

test('editing rejects stale versions, injected owners, invalid measurements, unknown products and repeated stores', async t => {
  const f = await setup(t), input = f.input(); f.trips.save(ALICE, input);
  assert.throws(() => f.trips.save(ALICE, input), { code: 'TRIP_CHANGED' });
  for (const patch of [{ discordId: BOB }, { products: ['unapproved'] }, { storeIds: ['100', '100'] },
    { zip: '00000' }, { origin: { latitude: 0, longitude: 0 } }, { legs: [] }]) {
    assert.throws(() => f.trips.save(ALICE, { ...f.input(), ...patch }), { code: 'INVALID_TRIP' });
  }
  const bad = f.input(); bad.legs[0].seconds = -1;
  assert.throws(() => f.trips.save(ALICE, bad), { code: 'INVALID_TRIP' });
  const old = f.input(); f.advance(16 * 60_000);
  assert.throws(() => f.trips.save(ALICE, old), { code: 'INVALID_TRIP' });
});

test('sold-out, excluded, unknown and stale stops cannot be saved or handed off', async t => {
  for (const reason of ['out', 'excluded', 'unknown', 'stale', 'disabled']) await t.test(reason, async t => {
    const f = await setup(t), input = f.input(); f.trips.save(ALICE, input);
    if (reason === 'out') f.observe('100', 0);
    if (reason === 'excluded') f.appData.saveStorePreferences(ALICE, '100', { excluded: true });
    if (reason === 'unknown') f.db.prepare("UPDATE inventory SET status='unknown' WHERE store_id='100'").run();
    if (reason === 'stale') f.advance(10 * 60_000);
    if (reason === 'disabled') f.config.monitor.enabled = false;
    assert.equal(f.trips.get(ALICE).trip.canOpen, false);
    assert.throws(() => f.trips.save(ALICE, { ...input, version: 1 }), { code: reason === 'disabled' ? 'TRIP_UNAVAILABLE' : 'TRIP_NOT_READY' });
  });
});

test('back stock needs a confident forecast ready by road arrival; it stays yellow with a warning', async t => {
  const f = await setup(t); f.observe('100', 0);
  f.db.prepare('INSERT INTO store_timing VALUES (?,1,3,180,10800,?)').run('100', f.clock());
  f.observe('100', 12);
  assert.throws(() => f.trips.save(ALICE, f.input(['100'], 600)), { code: 'TRIP_NOT_READY' });
  const saved = f.trips.save(ALICE, f.input(['100'], 3600));
  assert.equal(saved.trip.stops[0].state, 'expected');
  assert.match(saved.trip.stops[0].warnings.join(' '), /still in back/);
  assert.equal(saved.trip.stops[0].store.inventory[0].status, 'back');
  f.db.prepare('UPDATE store_timing SET samples=1,total_minutes=60,squared_minutes=3600').run();
  assert.equal(f.trips.get(ALICE).trip.canOpen, false);
});

test('arrival checks handle closed stores and road estimates expire without pretending the stock sold out', async t => {
  const f = await setup(t), input = f.input(['100']);
  const schedule = normalizeHours({ ...hoursInfo, hrsMon: '0800:1305' }, store('100', 0));
  f.db.prepare('UPDATE store_hours SET schedule_json=? WHERE store_id=?').run(JSON.stringify(schedule), '100');
  assert.throws(() => f.trips.save(ALICE, input), { code: 'TRIP_NOT_READY' });
  assert.match(f.trips.preview(ALICE, (({ version, ...r }) => r)(input)).trip.stops[0].warnings.join(' '), /closed/);
  f.observe('100', 4); f.trips.save(ALICE, input);
  f.advance(16 * 60_000); f.observe('100', 4); f.observe('100', 0); f.observe('100', 5); f.observe('100', 4);
  const trip = f.trips.get(ALICE).trip;
  assert.equal(trip.needsReplan, true); assert.equal(trip.canOpen, false);
  assert.equal(trip.stops[0].state, 'available');
});

test('trip changes deduplicate across sweeps and restarts, honor the switch and pause, and stop after clearing', async t => {
  const f = await setup(t); f.trips.save(ALICE, f.input());
  await f.appData.saveSettings(ALICE, { alerts: { paused: true } });
  f.observe('100', 0); f.trips.sweep(); f.trips.sweep();
  let events = f.db.prepare("SELECT * FROM events WHERE kind='trip_change'").all();
  assert.equal(events.length, 1); assert.equal(events[0].discord_id, ALICE);
  assert.equal(JSON.parse(events[0].payload_json).notificationsPaused, true);
  f.reopen(); f.appData = new AppData({ ...f, catalog: loadCatalog() }); f.trips = f.appData.trips;
  f.trips.sweep();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='trip_change'").get().n, 1);
  await f.appData.saveSettings(ALICE, { alerts: { tripChanges: false } });
  f.db.prepare("UPDATE inventory SET quantity=0,status='out' WHERE store_id='101'").run(); f.trips.sweep();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='trip_change'").get().n, 1);
  const result = f.trips.clear(ALICE, { version: 1 });
  assert.equal(result.trip, null); assert.equal(result.version, 2);
  assert.throws(() => f.trips.clear(ALICE, { version: 1 }), { code: 'TRIP_CHANGED' });
});

test('schema 3 upgrade retains timing, settings and sessions when adding the empty trip table', async t => {
  const f = await setup(t);
  f.db.exec('DROP TABLE calendar_images; DROP TABLE calendar_events; DROP TABLE calendar_preferences; DROP TABLE active_trips; PRAGMA user_version=3;'); f.reopen();
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM active_trips').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM store_hours').get().n, 3);
});

test('device origin drives stop order and first leg without moving monitoring coverage', async t => {
  const f = await setup(t), start = { latitude: 37.23, longitude: -80.39 };
  const before = [...f.appData.jobs().keys()];
  const preview = f.trips.preview(ALICE, { origin: start, products: [UPC] });
  assert.equal(preview.trip.stops[0].store.id, '102');
  assert.deepEqual(preview.trip.origin, start);
  assert.equal(preview.trip.originSource, 'device');
  const saved = f.trips.save(ALICE, f.input());
  assert.deepEqual(saved.trip.origin, origin);
  assert.equal(saved.trip.canOpen, true);
  assert.deepEqual([...f.appData.jobs().keys()], before);
  assert.equal(f.appData.settings(ALICE).center.longitude, -80.42);
});

test('missing or invalid current locations cannot silently fall back to the ZIP', async t => {
  const f = await setup(t);
  for (const start of [undefined, null, { latitude: 91, longitude: 0 }, { latitude: 37, longitude: Infinity },
    { latitude: '37', longitude: -80 }, { latitude: 37, longitude: -80, discordId: BOB }]) {
    assert.throws(() => f.trips.preview(ALICE, { origin: start, products: [UPC] }), { code: 'INVALID_TRIP_ORIGIN' });
  }
});

test('legacy ZIP-based saved trips require recalculation and stock expiry invalidates a new route', async t => {
  const f = await setup(t); f.trips.save(ALICE, f.input());
  const row = f.trips.record(ALICE), data = JSON.parse(row.trip_json); delete data.originSource;
  f.db.prepare('UPDATE active_trips SET trip_json=? WHERE discord_id=?').run(JSON.stringify(data), ALICE);
  assert.equal(f.trips.get(ALICE).trip.needsReplan, true);
  assert.equal(f.trips.get(ALICE).trip.canOpen, false);
  assert.match(f.trips.get(ALICE).trip.stops[0].warnings.join(' '), /current location/);
  f.trips.save(ALICE, f.input());
  f.db.prepare('UPDATE inventory SET last_decrease_at=?').run(f.clock() - 7 * 24 * 3600_000);
  assert.equal(f.trips.get(ALICE).trip.canOpen, false);
});
