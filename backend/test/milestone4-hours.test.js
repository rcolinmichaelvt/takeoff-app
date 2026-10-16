import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, device, login, ALICE } from './helpers.js';
import { AppData } from '../src/app-data.js';
import { Inventory } from '../src/inventory.js';
import { createMonitor } from '../src/monitor.js';
import { normalizeStores } from '../src/dg-provider.js';
import { normalizeHours, inventoryHoursFields, openMinutes } from '../src/hours.js';
import { loadCatalog } from '../src/catalog.js';

const UPC = '196214158801';
// Public store fields from the owner's real inventory response (no session data).
const raw = (quantity = 0) => ({ storeNumber: 14838, address: '19718 Fisher Ave', city: 'Poolesville', state: 'MD',
  zipCode: '20837', latitude: 39.1446, longitude: -77.4135, phoneNumber: '2404891840', distance: 2.1,
  hrsMon: '0800:2200', hrsTue: '0800:2200', hrsWed: '0800:2200', hrsThu: '0800:2200',
  hrsFri: '0800:2200', hrsSat: '0800:2200', hrsSun: '0800:2200', productQTY: quantity });

test('real inventory compact hours normalize to Eastern time, including the two supplied closing times', () => {
  const first = raw();
  const second = { ...first, storeNumber: 18669, latitude: 39.1711, longitude: -77.2616,
    ...Object.fromEntries(inventoryHoursFields.map(k => [k, '0800:2100'])) };
  for (const [store, closing] of [[first, 1320], [second, 1260]]) {
    const result = normalizeHours(store, store);
    assert.equal(result.timezone, 'America/New_York');
    assert.deepEqual(result.weekly, Array.from({length: 7}, () => [[480, closing]]));
  }
  assert.equal(openMinutes(normalizeHours(first, first), Date.parse('2026-10-12T21:00:00-04:00'),
    Date.parse('2026-10-13T09:00:00-04:00')), 120);
});

test('compact hours reject partial, invalid and ambiguous values without rejecting valid stock', () => {
  for (const value of ['', null, '2500:2600', '0861:2200', '0000:0000']) {
    const info = { ...raw(8), hrsMon: value };
    assert.equal(normalizeHours(info, info), null);
    assert.equal(normalizeStores({ stores: [info] })[0].quantity, 8);
  }
  const missing = raw(); delete missing.hrsSun;
  assert.equal(normalizeHours(missing, missing), null);
  assert.deepEqual(normalizeHours({ ...raw(), hrsMon: '2200:0200' }, raw()).weekly[0], [[1320, 1560]]);
  assert.deepEqual(normalizeHours({ ...raw(), hrsMon: 'Closed' }, raw()).weekly[0], []);
});

async function setup(t) {
  const f = fixture(t); await login(f, device());
  f.advance(Date.parse('2026-10-12T13:00:00-04:00') - f.clock()); f.config.monitor.enabled = true;
  f.db.prepare('INSERT INTO zip_regions VALUES (?,?,?,?,?)').run('20837', 39.1446, -77.4135, 'Poolesville, MD', f.clock());
  f.appData = new AppData({ ...f, catalog: loadCatalog(), geography: { async resolveZip() {} } });
  await f.appData.saveSettings(ALICE, { zip: '20837', products: [UPC], alerts: { anyDecrease: true } });
  f.inventory = new Inventory(f); f.job = f.appData.jobs().values().next().value;
  f.observe = (qty, changes = {}) => f.inventory.ingest(f.job, normalizeStores({ stores: [{ ...raw(qty), ...changes }] }));
  return f;
}

test('inventory caches hours before the new batch starts and needs no store-info request', async t => {
  const f = await setup(t); f.observe(0); f.observe(12);
  const monitor = createMonitor({ ...f, provider: { async fetchInventory() { return normalizeStores({ stores: [raw(12)] }); } } });
  await monitor.tick();
  assert.equal(f.appData.store(ALICE, '14838').timing.openingHours.days[0].hours, '08:00–22:00');
  f.advance(120000); f.observe(11);
  assert.equal(f.appData.intelligence.timing('14838').averageOpenMinutes, 2);
  f.observe(11, { hrsMon: 'bad' });
  assert.equal(f.appData.store(ALICE, '14838').timing.hoursStatus, 'unavailable');
  assert.equal(f.appData.store(ALICE, '14838').inventory[0].quantity, 11);
});

test('a decrease after an unknown restart baseline stays unknown and never trains a fabricated restock', async t => {
  const f = await setup(t); f.observe(0); f.advance(10 * 60_000); f.observe(10);
  f.advance(60_000); f.observe(9);
  assert.equal(f.appData.store(ALICE, '14838').inventory[0].status, 'unknown');
  assert.equal(f.appData.intelligence.timing('14838').sampleCount, 0);
  assert.deepEqual(f.db.prepare('SELECT kind FROM events').all().map(e => e.kind), ['decrease']);
});
