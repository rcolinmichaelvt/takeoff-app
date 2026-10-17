import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { fixture, device, login, authenticate, ALICE, BOB } from './helpers.js';
import { AppData } from '../src/app-data.js';
import { Inventory } from '../src/inventory.js';
import { loadCatalog } from '../src/catalog.js';
import { normalizeCalendarImage } from '../src/calendar.js';
import { DAY } from '../src/hours.js';
import { AppError } from '../src/errors.js';
import { prepareRestore } from '../src/recovery.js';

const UPC = '196214158801';
async function setup(t) {
  const f = fixture(t);
  f.advance(Date.parse('2026-10-17T13:00:00-04:00') - f.clock());
  f.dev = device(); f.tokens = await login(f, f.dev); await login(f, device(), BOB);
  for (const [zip, latitude, longitude] of [['24060', 37.23, -80.42], ['90210', 34.10, -118.40]]) {
    f.db.prepare('INSERT INTO zip_regions VALUES (?,?,?,?,?)').run(zip, latitude, longitude, 'Test ZIP', f.clock());
  }
  f.geography = { async resolveZip(zip) { assert.ok(['24060', '90210'].includes(zip)); } };
  f.app = new AppData({ ...f, catalog: loadCatalog() }); f.calendar = f.app.calendar;
  await f.app.saveSettings(BOB, { zip: '24060', products: [UPC] });
  f.input = (changes = {}) => ({ version: 0, visibility: 'moderator', title: 'Saturday restock', description: 'Cards near checkout.',
    retailer: 'Target', location: '123 Test Road', zip: '24060', startsAt: new Date(f.clock() + 3600_000).toISOString(),
    endsAt: new Date(f.clock() + 7200_000).toISOString(), timezone: 'America/New_York', recurrence: 'none', ...changes });
  f.query = (changes = {}) => ({ from: String(f.clock() - DAY), to: String(f.clock() + 30 * DAY), ...changes });
  return f;
}
const picture = async () => (await sharp({ create: { width: 1400, height: 700, channels: 3, background: '#7354d4' } })
  .withExif({ IFD0: { Artist: 'Fixture metadata that must be stripped' } }).png().toBuffer()).toString('base64');

test('moderator events share by area, private events stay owner-only, and calendar ZIPs do not start monitoring', async t => {
  const f = await setup(t), before = [...f.app.jobs().keys()];
  const shared = await f.calendar.save(ALICE, null, f.input());
  const privateEvent = await f.calendar.save(BOB, null, f.input({ visibility: 'private', title: 'My reminder' }));
  const distant = await f.calendar.save(ALICE, null, f.input({ zip: '90210' }));
  const national = await f.calendar.save(ALICE, null, f.input({ zip: null }));
  assert.equal(f.calendar.get(BOB, shared.id).canEdit, false);
  assert.equal(f.calendar.get(BOB, privateEvent.id).canEdit, true);
  assert.throws(() => f.calendar.get(ALICE, privateEvent.id), { code: 'NOT_FOUND' });
  assert.throws(() => f.calendar.get(BOB, distant.id), { code: 'NOT_FOUND' });
  assert.equal(f.calendar.get(BOB, national.id).title, 'Saturday restock');
  assert.deepEqual(new Set(f.calendar.list(BOB, f.query()).events.map(e => e.id)), new Set([shared.id, privateEvent.id, national.id]));
  assert.equal(f.calendar.list(ALICE, f.query()).events.length, 3);
  assert.equal(JSON.stringify(f.calendar.list(BOB, f.query())).includes(ALICE), false);
  assert.deepEqual([...f.app.jobs().keys()], before);
  await assert.rejects(f.calendar.save(BOB, null, f.input()), { code: 'MODERATOR_REQUIRED' });
  await assert.rejects(f.calendar.save(BOB, shared.id, f.input({ version: 1 })), { code: 'NOT_FOUND' });
  assert.throws(() => f.calendar.remove(ALICE, privateEvent.id, { version: 1 }), { code: 'NOT_FOUND' });
});

test('moderator images are normalized, access checked, retained on text edits and removed atomically', async t => {
  const f = await setup(t), input = f.input({ imageBase64: await picture() });
  const event = await f.calendar.save(ALICE, null, input);
  const result = f.calendar.image(BOB, event.id), meta = await sharp(Buffer.from(result.base64, 'base64')).metadata();
  assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 1200); assert.equal(meta.height, 600);
  assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined);
  assert.equal(result.width, 1200); assert.equal(event.hasImage, true);
  const edited = await f.calendar.save(ALICE, event.id, f.input({ version: 1, title: 'Updated' }));
  assert.equal(edited.version, 2); assert.equal(edited.hasImage, true);
  await assert.rejects(f.calendar.save(ALICE, event.id, f.input({ version: 1, removeImage: true })), { code: 'CALENDAR_CHANGED' });
  assert.equal(f.calendar.get(ALICE, event.id).hasImage, true);
  const noImage = await f.calendar.save(ALICE, event.id, f.input({ version: 2, removeImage: true }));
  assert.equal(noImage.hasImage, false); assert.throws(() => f.calendar.image(BOB, event.id), { code: 'NOT_FOUND' });
  const privateEvent = await f.calendar.save(ALICE, null, f.input({ visibility: 'private' }));
  assert.throws(() => f.calendar.image(BOB, privateEvent.id), { code: 'NOT_FOUND' });
  await assert.rejects(f.calendar.save(BOB, null, f.input({ ...input, visibility: 'private' })), { code: 'MODERATOR_REQUIRED' });
  const distant = await f.calendar.save(ALICE, null, { ...input, zip: '90210' });
  assert.throws(() => f.calendar.image(BOB, distant.id), { code: 'NOT_FOUND' });
  f.calendar.remove(ALICE, distant.id, { version: 1 });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM calendar_images WHERE event_id=?').get(distant.id).n, 0);
});

test('image decoder rejects malformed, excessive, non-raster and oversized-pixel inputs', async () => {
  for (const value of ['not base64', Buffer.from('<svg/>').toString('base64'), 'A'.repeat(2_000_004),
    Buffer.from([255, 216, 255, 0]).toString('base64')]) await assert.rejects(normalizeCalendarImage(value), { status: 400 });
  const huge = await sharp({ create: { width: 4100, height: 4000, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(normalizeCalendarImage(huge.toString('base64')), { status: 400 });
});

test('calendar validation rejects injected owners, invalid dates, recurrence, visibility changes and options', async t => {
  const f = await setup(t);
  for (const change of [{ owner_id: BOB }, { startsAt: 'invalid' }, { endsAt: new Date(f.clock()).toISOString() },
    { timezone: 'not-a-timezone' }, { title: ' ' }, { recurrence: 'daily' }, { zip: '123' },
    { recurrence: 'weekly', repeatUntil: new Date(f.clock() + 300 * DAY).toISOString() }, { imageBase64: 'AAAA', removeImage: true }]) {
    await assert.rejects(f.calendar.save(ALICE, null, f.input(change)), { code: 'INVALID_CALENDAR_EVENT' });
  }
  const event = await f.calendar.save(ALICE, null, f.input());
  await assert.rejects(f.calendar.save(ALICE, event.id, f.input({ version: 1, visibility: 'private' })), { code: 'INVALID_CALENDAR_EVENT' });
  for (const query of [{ ...f.query(), to: String(f.clock() + 70 * DAY) }, { ...f.query(), after: 'bad' }, { ...f.query(), userId: BOB }]) {
    assert.throws(() => f.calendar.list(ALICE, query), { code: 'INVALID_CALENDAR_EVENT' });
  }
  assert.throws(() => f.calendar.saveOptions(ALICE, { favoritesOnly: 'false' }), { code: 'INVALID_CALENDAR_EVENT' });
  assert.throws(() => f.calendar.saveOptions(ALICE, { discordId: BOB }), { code: 'INVALID_CALENDAR_EVENT' });
  f.calendar.saveOptions(ALICE, { showModerator: false, favoritesOnly: false });
  assert.equal(f.calendar.list(ALICE, f.query()).events.length, 0);
  assert.equal(f.calendar.options(BOB).favoritesOnly, true);
  assert.equal(f.calendar.list(BOB, f.query()).events.length, 1);
});

test('weekly events retain wall-clock time across DST, with distinct occurrences and bounded pagination', async t => {
  const f = await setup(t);
  await f.calendar.save(ALICE, null, f.input({ startsAt: '2026-10-25T09:00:00-04:00', endsAt: '2026-10-25T10:00:00-04:00',
    recurrence: 'weekly', repeatUntil: '2026-11-08T23:59:59-05:00' }));
  const events = f.calendar.list(BOB, f.query()).events;
  assert.deepEqual(events.map(e => e.startsAt), ['2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-08T14:00:00.000Z']);
  assert.equal(new Set(events.map(e => e.occurrenceId)).size, 3);
  assert.equal(new Set(events.map(e => e.id)).size, 1);
  for (let i = 0; i < 202; i++) await f.calendar.save(ALICE, null, f.input({ title: `Event ${i}` }));
  const page = f.calendar.list(BOB, f.query()), next = f.calendar.list(BOB, f.query({ after: page.nextCursor }));
  assert.equal(page.events.length, 200); assert.equal(next.events.length, 5); assert.equal(next.nextCursor, null);
  assert.equal(new Set([...page.events, ...next.events].map(e => e.occurrenceId)).size, 205);
});

test('a nonexistent DST occurrence shifts only that week, not subsequent weekly occurrences', async t => {
  const f = await setup(t);
  await f.calendar.save(ALICE, null, f.input({ startsAt: '2027-03-07T02:30:00-05:00', endsAt: '2027-03-07T04:00:00-05:00',
    recurrence: 'weekly', repeatUntil: '2027-03-21T23:59:59-04:00' }));
  const events = f.calendar.list(BOB, { from: String(Date.parse('2027-03-01')), to: String(Date.parse('2027-04-01')) }).events;
  assert.deepEqual(events.map(e => e.startsAt), ['2027-03-07T07:30:00.000Z', '2027-03-14T07:30:00.000Z', '2027-03-21T06:30:00.000Z']);
});

test('spring-forward adjustment cannot make a weekly occurrence end before it starts', async t => {
  const f = await setup(t);
  await f.calendar.save(ALICE, null, f.input({ startsAt: '2027-03-07T02:30:00-05:00', endsAt: '2027-03-07T03:00:00-05:00',
    recurrence: 'weekly', repeatUntil: '2027-03-14T23:59:59-04:00' }));
  const events = f.calendar.list(BOB, { from: String(Date.parse('2027-03-14')), to: String(Date.parse('2027-03-15')) }).events;
  assert.equal(events.length, 1);
  assert.equal(Date.parse(events[0].endsAt) - Date.parse(events[0].startsAt), 30 * 60_000);
  assert.equal(events[0].startsAt, '2027-03-14T07:30:00.000Z');
});

test('authorization is rechecked after ZIP lookup or image work before committing a post', async t => {
  const f = await setup(t);
  await assert.rejects(f.calendar.save(ALICE, null, f.input({ imageBase64: await picture() }), () => {
    throw new AppError(401, 'SESSION_REVOKED', 'Sign in again.');
  }), { code: 'SESSION_REVOKED' });
  f.geography.resolveZip = async () => { f.config.moderatorIds.delete(ALICE); };
  await assert.rejects(f.calendar.save(ALICE, null, f.input()), { code: 'MODERATOR_REQUIRED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM calendar_events').get().n, 0);
});

test('calendar predictions group products by store, honor favorite/all options, exclusions and fresh coverage', async t => {
  const f = await setup(t); f.config.monitor.enabled = true;
  const other = loadCatalog().find(p => p.upc !== UPC).upc;
  await f.app.saveSettings(BOB, { products: [UPC, other] });
  const inventory = new Inventory({ ...f, appData: f.app });
  const store = (id, quantity) => ({ id, quantity, address: `${id} Test St`, city: 'Blacksburg', state: 'VA',
    latitude: 37.23, longitude: -80.42, distance: 0, hoursInfo: Object.fromEntries(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => [`hrs${d}`, '0800:2200'])) });
  for (const job of f.app.jobs().values()) {
    inventory.ingest(job, [store('100', 0), store('200', 0)]);
    inventory.ingest(job, [store('100', 4), store('200', 4)]);
  }
  for (const id of ['100', '200']) f.db.prepare('INSERT INTO store_timing VALUES (?,1,3,180,10800,?)').run(id, f.clock());
  assert.equal(f.calendar.list(BOB, f.query()).predictions.length, 0);
  f.app.saveStorePreferences(BOB, '100', { favorite: true });
  const predictions = f.calendar.list(BOB, f.query()).predictions;
  assert.equal(predictions.length, 1); assert.equal(predictions[0].titles.length, 2); assert.equal(predictions[0].confidence, 'medium');
  f.calendar.saveOptions(BOB, { favoritesOnly: false });
  assert.equal(f.calendar.list(BOB, f.query()).predictions.length, 2);
  f.app.saveStorePreferences(BOB, '200', { excluded: true });
  assert.equal(f.calendar.list(BOB, f.query()).predictions.length, 1);
  f.advance(10 * 60_000);
  assert.equal(f.calendar.list(BOB, f.query()).predictions.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM calendar_events').get().n, 0);
});

test('schema 4 upgrade and schema 5 backup retain login and calendar data; restore revokes old access', async t => {
  const f = await setup(t);
  f.db.exec('DROP TABLE calendar_images; DROP TABLE calendar_events; DROP TABLE calendar_preferences; PRAGMA user_version=4;');
  const oldFile = path.join(f.directory, 'before-calendar.sqlite');
  await backup(f.db, oldFile); f.reopen();
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(authenticate(f, f.dev, f.tokens.accessToken).discord_id, ALICE);
  f.app = new AppData({ ...f, catalog: loadCatalog() }); f.calendar = f.app.calendar;
  assert.equal(f.app.settings(BOB).zip, '24060');
  const event = await f.calendar.save(ALICE, null, f.input({ imageBase64: await picture() }));
  f.calendar.saveOptions(BOB, { favoritesOnly: false });
  const saved = path.join(f.directory, 'with-calendar.sqlite'); await backup(f.db, saved);
  for (const [name, input, version] of [['old-prepared.sqlite', oldFile, 4], ['new-prepared.sqlite', saved, 5]]) {
    const destination = path.join(f.directory, name); await prepareRestore(input, destination, f.clock());
    const check = new DatabaseSync(destination, { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(check.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    if (version === 5) {
      assert.equal(check.prepare('SELECT id FROM calendar_events').get().id, event.id);
      assert.ok(check.prepare('SELECT length(jpeg) n FROM calendar_images').get().n > 0);
      assert.equal(JSON.parse(check.prepare('SELECT options_json FROM calendar_preferences').get().options_json).favoritesOnly, false);
    }
    check.close();
  }
  f.reopen(); f.app = new AppData({ ...f, catalog: loadCatalog() });
  assert.equal(f.app.calendar.get(BOB, event.id).hasImage, true);
  assert.equal(f.app.calendar.options(BOB).favoritesOnly, false);
  assert.equal(authenticate(f, f.dev, f.tokens.accessToken).discord_id, ALICE);
});
