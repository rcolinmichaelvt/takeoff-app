import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, device, login, ALICE, BOB } from './helpers.js';
import { AppData } from '../src/app-data.js';
import { Inventory, observeInventory, AVAILABILITY_TTL_MS } from '../src/inventory.js';
import { createMonitor } from '../src/monitor.js';
import { loadCatalog } from '../src/catalog.js';

const UPC = '196214158801';
const store = (id, quantity) => ({ id, quantity, address: `${id} Test Street`, city: 'Blacksburg', state: 'VA',
  latitude: 37.23, longitude: -80.42, distance: 1 });
async function setup(t) {
  const f = fixture(t); await login(f, device()); await login(f, device(), BOB);
  f.config.monitor.enabled = true; f.config.monitor.geocodeStores = false;
  for (const zip of ['24060', '24061']) f.db.prepare('INSERT INTO zip_regions VALUES (?,?,?,?,?)')
    .run(zip, 37.23, -80.42, 'Test area', f.clock());
  f.geography = { async resolveZip() {} };
  f.appData = new AppData({ ...f, catalog: loadCatalog() });
  await f.appData.saveSettings(ALICE, { zip: '24060', products: [UPC] });
  f.inventory = new Inventory(f);
  f.job = () => f.appData.jobs().get(`24060:${UPC}`);
  f.observe = quantity => { f.advance(1000); f.inventory.ingest(f.job(), [store('100', quantity)]); };
  f.stock = () => f.appData.store(ALICE, '100').inventory[0];
  return f;
}

test('a sale after a positive baseline sets availability, refreshes its deadline, and never invents a restock sample', async t => {
  const f = await setup(t); f.observe(10);
  assert.equal(f.stock().status, 'unknown');
  f.observe(9); assert.equal(f.stock().status, 'available');
  const firstDecrease = Date.parse(f.stock().lastDecreaseAt);
  f.observe(9); assert.equal(Date.parse(f.stock().lastDecreaseAt), firstDecrease);
  f.observe(8); assert.ok(Date.parse(f.stock().lastDecreaseAt) > firstDecrease);
  assert.equal(f.appData.intelligence.timing('100').sampleCount, 0);
  f.observe(0); assert.equal(f.stock().status, 'out');
  f.observe(5); assert.equal(f.stock().status, 'back');
});

test('a lower positive observation across an outage signals availability but invalidates timing', () => {
  const next = observeInventory({ quantity: 10, status: 'back', pending_quantity: 10, observed_at: 1000 }, 9, 1000 + 600_000);
  assert.equal(next.status, 'available'); assert.equal(next.event, 'decrease');
  assert.equal(next.kind, 'resumed'); assert.equal(next.pending, 0);
});

test('the green signal expires exactly seven days after the latest decrease even without a poll at the boundary', async t => {
  const f = await setup(t); f.observe(10); f.observe(9);
  f.advance(AVAILABILITY_TTL_MS - 1);
  // Represent continuing successful unchanged polls; expiry depends on sale time,
  // not on their refreshed observation timestamps.
  f.db.prepare('UPDATE inventory SET observed_at=?').run(f.clock());
  f.db.prepare('UPDATE area_inventory SET seen_at=?').run(f.clock());
  assert.equal(f.stock().status, 'available');
  f.advance(1);
  assert.equal(f.stock().status, 'unknown'); assert.equal(f.stock().quantity, 9);
  assert.equal(f.stock().stale, false);
  f.observe(8); assert.equal(f.stock().status, 'available');
  f.advance(10 * 60_000); assert.equal(f.stock().status, 'unknown'); assert.equal(f.stock().stale, true);
});

test('expiration can return fully pending stock to yellow without qualifying the new batch as sold', () => {
  const next = observeInventory({ quantity: 12, status: 'available', pending_quantity: 12,
    last_decrease_at: 1000, observed_at: 1000 + AVAILABILITY_TTL_MS - 1 }, 12, 1000 + AVAILABILITY_TTL_MS);
  assert.equal(next.status, 'back'); assert.equal(next.pending, 12); assert.equal(next.event, null);
});

test('existing recent M4 unknown decreases are repaired on reopen without new events or learning', async t => {
  const f = await setup(t); f.observe(10); f.observe(9);
  f.db.prepare("UPDATE inventory SET status='unknown'").run();
  const before = f.db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const app = new AppData({ ...f, catalog: loadCatalog() });
  assert.equal(app.store(ALICE, '100').inventory[0].status, 'available');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n, before);
  assert.equal(app.intelligence.timing('100').sampleCount, 0);
  // An intervening gap invalidates old policy repair.
  f.advance(10 * 60_000); f.observe(9);
  const afterGap = new AppData({ ...f, catalog: loadCatalog() });
  assert.equal(afterGap.store(ALICE, '100').inventory[0].status, 'unknown');
});

test('unselected ZIPs disappear from covered pages; overlap and saved notes survive', async t => {
  const f = await setup(t); f.observe(0);
  f.inventory.ingest(f.job(), [store('200', 2)]);
  f.appData.saveStorePreferences(ALICE, '100', { favorite: true, privateNote: 'Keep this' });
  await f.appData.saveSettings(BOB, { zip: '24061', products: [UPC] });
  f.inventory.ingest(f.appData.jobs().get(`24061:${UPC}`), [store('100', 0)]);
  await f.appData.saveSettings(ALICE, { zip: '24061' });
  assert.equal(f.appData.jobs().has(`24060:${UPC}`), false);
  assert.deepEqual(f.appData.stores(ALICE, { scope: 'covered', limit: '1' }).stores.map(s => s.id), ['100']);
  assert.equal(f.appData.stores(ALICE, { scope: 'covered', limit: '1' }).nextCursor, null);
  assert.equal(f.appData.store(ALICE, '100').privateNote, 'Keep this');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stores').get().n, 2);
  // Still subscribed but temporarily stale is visible as gray, not presented as live.
  f.advance(10 * 60_000);
  assert.equal(f.appData.stores(ALICE, { scope: 'covered' }).stores[0].inventory[0].status, 'unknown');
  await f.appData.saveSettings(ALICE, { products: [] });
  assert.equal(f.appData.stores(ALICE, { scope: 'covered' }).stores.length, 1);
  await f.appData.saveSettings(BOB, { products: [] });
  assert.equal(f.appData.stores(ALICE, { scope: 'covered' }).stores.length, 0);
  assert.equal(f.appData.stores(ALICE, { scope: 'covered', favorites: 'true' }).stores.length, 0);
});

test('an old yellow threshold label is repaired without completing the pending new batch', async t => {
  const f = await setup(t);
  for (const quantity of [0, 4, 3, 15, 12]) f.observe(quantity);
  f.db.prepare("UPDATE inventory SET status='back'").run();
  const app = new AppData({ ...f, catalog: loadCatalog() });
  assert.equal(app.store(ALICE, '100').inventory[0].status, 'available');
  assert.equal(f.db.prepare('SELECT pending_quantity FROM inventory').get().pending_quantity, 12);
});

test('the last subscriber leaving stops polling; an in-flight response cannot revive the ZIP', async t => {
  const f = await setup(t); let finish, calls = 0;
  const monitor = createMonitor({ ...f, logger: { warn() {} }, provider: {
    fetchInventory() { calls++; return new Promise(resolve => { finish = resolve; }); },
  } });
  const pending = monitor.tick();
  await f.appData.saveSettings(ALICE, { products: [] });
  finish([store('100', 8)]); await pending;
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 0);
  f.advance(180_000); await monitor.tick();
  assert.equal(calls, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM monitor_jobs').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM zip_regions').get().n, 2);
  await monitor.stop();
});
