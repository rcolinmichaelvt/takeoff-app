import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHours, openMinutes, addOpenMinutes } from '../src/hours.js';

// Synthetic provider boundary cases, not captured authenticated DG responses.
const weekly = Object.fromEntries(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(day => [day, '08:00-22:00']));
const info = extra => ({ timeZone: 'America/New_York', storeHours: weekly, ...extra });
const instant = value => Date.parse(value);

test('business time excludes overnight closure and carries predictions to the next opening', () => {
  const hours = normalizeHours(info(), {});
  const start = instant('2026-10-12T21:00:00-04:00'), end = instant('2026-10-13T09:00:00-04:00');
  assert.equal(openMinutes(hours, start, end), 120);
  assert.equal(addOpenMinutes(hours, start, 120), end);
  assert.equal(addOpenMinutes(hours, start, 60), instant('2026-10-13T08:00:00-04:00'));
});

test('spring and fall DST transitions use store-local hours, not a fixed UTC offset', () => {
  const hours = normalizeHours(info({ storeHours: Object.fromEntries(Object.keys(weekly).map(day => [day, '22:00-04:00'])) }), {});
  assert.equal(openMinutes(hours, instant('2026-03-07T22:00:00-05:00'), instant('2026-03-08T04:00:00-04:00')), 300);
  assert.equal(openMinutes(hours, instant('2026-10-31T22:00:00-04:00'), instant('2026-11-01T04:00:00-05:00')), 420);
  const normal = normalizeHours(info(), {});
  assert.equal(addOpenMinutes(normal, instant('2026-03-07T21:00:00-05:00'), 120), instant('2026-03-08T09:00:00-04:00'));
});

test('date-specific closed days and shorter hours override the weekly schedule', () => {
  const hours = normalizeHours(info({ specialHours: [
    { date: '2026-12-25', closed: true }, { date: '2026-12-24', opens: '08:00', closes: '16:00' },
  ] }), {});
  const from = instant('2026-12-24T15:00:00-05:00'), expected = instant('2026-12-26T09:00:00-05:00');
  assert.equal(addOpenMinutes(hours, from, 120), expected);
  assert.equal(openMinutes(hours, from, expected), 120);
});

test('missing days, bad hours, ambiguous zones, or malformed exceptions never assume always open', () => {
  const partial = { ...weekly }; delete partial.Sunday;
  for (const value of [info({ storeHours: partial }), info({ timeZone: 'EST' }), info({ timeZone: 'Not/AZone' }),
    info({ storeHours: { ...weekly, Monday: '25:00-29:00' } }), info({ storeHours: { ...weekly, Monday: '00:00-00:00' } }),
    info({ specialHours: [{ date: '2026-02-30', closed: true }] }), info({ specialHours: [{ text: 'Holiday hours may vary' }] })]) {
    assert.equal(normalizeHours(value, {}), null);
  }
  assert.equal(openMinutes(null, 0, 1), null); assert.equal(addOpenMinutes(null, 0, 60), null);
  assert.equal(normalizeHours({ storeHours: weekly }, { latitude: 35, longitude: -90 }, () => ['America/Chicago', 'America/New_York']), null);
});

test('weekday arrays, 12-hour clocks, split shifts, and geographic timezones normalize', () => {
  const hours = normalizeHours({ storeHours: Object.keys(weekly).map(day => ({ dayOfWeek: day, hours: [
    { open: '8:00 AM', close: '12:00 PM' }, { open: '1:00 PM', close: '10:00 PM' },
  ] })) }, { latitude: 37.23, longitude: -80.42 });
  assert.equal(hours.timezone, 'America/New_York');
  assert.equal(openMinutes(hours, instant('2026-10-12T11:00:00-04:00'), instant('2026-10-12T14:00:00-04:00')), 120);
});

test('nonexistent or ambiguous DST boundary times suppress a forecast', () => {
  const hours = normalizeHours(info({ storeHours: { ...weekly, Sunday: '02:30-22:00' } }), {});
  assert.equal(addOpenMinutes(hours, instant('2026-03-08T00:00:00-05:00'), 60), null);
});
