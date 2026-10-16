import { Temporal } from '@js-temporal/polyfill';
import geoTZ from 'geo-tz';
import { validCoordinate } from './geography.js';

export const DAY = 24 * 60 * 60_000;
export const HOURS_MAX_AGE = 3 * DAY;
const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const zones = { 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu' };

// Bound the geographic lookup's lazy polygon cache on a small Railway instance.
class BoundedCache extends Map {
  set(key, value) { if (!this.has(key) && this.size >= 16) this.delete(this.keys().next().value); return super.set(key, value); }
}
geoTZ.setCache({ store: new BoundedCache() });
const invalid = () => { throw new Error('STORE_HOURS_INVALID'); };

function dayIndex(value) {
  if (typeof value !== 'string') return -1;
  const label = value.split('/').at(-1).toLowerCase().trim();
  return days.findIndex(day => day === label || day.slice(0, 3) === label);
}

function time(value) {
  if (typeof value !== 'string') return invalid();
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::00)?\s*(am|pm)?$/i);
  if (!match) return invalid();
  let hour = Number(match[1]); const minute = Number(match[2]), period = match[3]?.toLowerCase();
  if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 24 || hour === 24 && minute !== 0)) return invalid();
  if (period) hour = hour % 12 + (period === 'pm' ? 12 : 0);
  return hour * 60 + minute;
}

function ranges(value) {
  if (Array.isArray(value)) return value.flatMap(ranges);
  if (typeof value === 'string') {
    if (/^closed$/i.test(value.trim())) return [];
    if (/^(?:open )?24 hours$/i.test(value.trim())) return [[0, 1440]];
    const pair = value.trim().split(/\s*[-–—]\s*/);
    if (pair.length !== 2) return invalid();
    return pairRange(pair[0], pair[1]);
  }
  if (!value || typeof value !== 'object') return invalid();
  if (value.closed === true || value.isClosed === true) return [];
  if (value.open24Hours === true) return [[0, 1440]];
  return pairRange(value.opens ?? value.open ?? value.openTime ?? value.openingTime,
    value.closes ?? value.close ?? value.closeTime ?? value.closingTime);
}
function pairRange(start, end) {
  const a = time(start), b = time(end);
  // Equal times are ambiguous, not an invented 24-hour opening.
  if (a >= 1440 || a === b) return invalid();
  return [[a, b <= a ? b + 1440 : b]];
}
function sortedRanges(value) {
  const result = ranges(value).sort((a, b) => a[0] - b[0]);
  if (result.length > 8 || result.some((r, i) => i && r[0] < result[i - 1][1])) return invalid();
  return result;
}

/** Normalize only complete, interpretable schedules. Unsupported data fails closed.
 * DG store-info wire formats can change. inspect-hours prints only public hours
 * fields for adapting this boundary without logging request/session credentials.
 */
export function normalizeHours(info, store, lookup = geoTZ.find) {
  try {
    if (!info || typeof info !== 'object') return null;
    const supplied = info.timeZone ?? info.timezone ?? info.timeZoneId;
    let timezone, timezoneSource;
    if (typeof supplied === 'string' && supplied.trim()) {
      timezone = zones[supplied.trim()] || supplied.trim(); timezoneSource = 'dg';
      // Abbreviations such as EST are fixed offsets and must not replace DST rules.
      if (!timezone.includes('/')) return null;
    } else if (validCoordinate(store.latitude, store.longitude)) {
      const matches = lookup(store.latitude, store.longitude);
      if (matches.length !== 1 || matches[0].startsWith('Etc/')) return null;
      timezone = matches[0]; timezoneSource = 'coordinates';
    } else return null;
    Temporal.Now.zonedDateTimeISO(timezone);
    const source = info.storeHours ?? info.hoursOfOperation ?? info.businessHours ?? info.hours ?? info.openingHoursSpecification;
    const weekly = Array.from({ length: 7 }, () => null);
    if (Array.isArray(source)) {
      for (const entry of source) {
        const labels = entry?.dayOfWeek ?? entry?.day ?? entry?.dayName;
        const values = Array.isArray(labels) ? labels : [labels];
        for (const label of values) {
          const index = dayIndex(label);
          if (index < 0 || weekly[index] !== null) return null;
          weekly[index] = sortedRanges(entry.hours ?? entry);
        }
      }
    } else if (source && typeof source === 'object') {
      for (const [day, value] of Object.entries(source)) {
        const index = dayIndex(day);
        if (index >= 0) weekly[index] = sortedRanges(value);
      }
    } else {
      for (let i = 0; i < 7; i++) {
        const key = Object.keys(info).find(k => k.toLowerCase() === `${days[i]}hours`);
        if (key) weekly[i] = sortedRanges(info[key]);
      }
    }
    if (weekly.some(day => day === null)) return null;
    const exceptions = {};
    const special = info.specialHours ?? info.holidayHours ?? info.specialOpeningHoursSpecification ?? [];
    const entries = Array.isArray(special) ? special : Object.entries(special).map(([date, hours]) => ({ date, hours }));
    if (entries.length > 100) return null;
    for (const entry of entries) {
      const start = Temporal.PlainDate.from(entry.date ?? entry.validFrom);
      const end = Temporal.PlainDate.from(entry.date ?? entry.validThrough ?? entry.validFrom);
      if (Temporal.PlainDate.compare(end, start) < 0 || start.until(end).days > 31) return null;
      for (let date = start; Temporal.PlainDate.compare(date, end) <= 0; date = date.add({ days: 1 })) {
        if (Object.hasOwn(exceptions, date.toString())) return null;
        exceptions[date.toString()] = sortedRanges(entry.hours ?? entry);
      }
    }
    return { timezone, timezoneSource, weekly,
      exceptions: Object.fromEntries(Object.entries(exceptions).sort(([a], [b]) => a.localeCompare(b))) };
  } catch { return null; }
}

export function localDate(instant, timezone) {
  return Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(timezone).toPlainDate();
}
function edge(date, minute, timezone) {
  const day = date.add({ days: Math.floor(minute / 1440) });
  return Temporal.ZonedDateTime.from({ timeZone: timezone, year: day.year, month: day.month, day: day.day,
    hour: Math.floor(minute % 1440 / 60), minute: minute % 60 }, { disambiguation: 'reject' }).epochMilliseconds;
}
function intervals(schedule, start, end) {
  const result = [];
  let date = localDate(start, schedule.timezone).subtract({ days: 1 });
  const last = localDate(end, schedule.timezone);
  for (let n = 0; Temporal.PlainDate.compare(date, last) <= 0; n++, date = date.add({ days: 1 })) {
    if (n > 34) throw new Error('Window too long');
    const hours = schedule.exceptions[date.toString()] ?? schedule.weekly[date.dayOfWeek - 1];
    for (const [a, b] of hours) {
      const from = Math.max(start, edge(date, a, schedule.timezone)), to = Math.min(end, edge(date, b, schedule.timezone));
      if (to > from) result.push([from, to]);
    }
  }
  result.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of result) {
    if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(range[1], merged.at(-1)[1]);
    else merged.push(range);
  }
  return merged;
}
export function openMinutes(schedule, start, end) {
  if (!schedule || end < start || end - start > 32 * DAY) return null;
  try { return intervals(schedule, start, end).reduce((total, [a, b]) => total + (b - a) / 60_000, 0); }
  catch { return null; }
}
export function addOpenMinutes(schedule, start, minutes) {
  if (!schedule || !Number.isFinite(minutes) || minutes < 0) return null;
  try {
    let remaining = minutes * 60_000;
    // Visit bounded UTC windows lazily; most forecasts finish in the first one.
    // Each window is clipped, so DST/overnight intervals cannot count twice.
    for (let day = 0; day < 32; day++) {
      for (const [from, to] of intervals(schedule, start + day * DAY, start + (day + 1) * DAY)) {
        if (remaining < to - from) return Math.round(from + remaining);
        remaining -= to - from;
        // If the estimate lands at closing, use the next opening.
      }
    }
  } catch { /* Ambiguous/nonexistent DST boundaries suppress the prediction. */ }
  return null;
}

export function sameSchedule(a, b) {
  if (!a || !b) return false;
  // A more precise source for the same timezone does not change the schedule.
  return JSON.stringify({ ...a, timezoneSource: null }) === JSON.stringify({ ...b, timezoneSource: null });
}

export function scheduleView(schedule, updatedAt) {
  const display = minutes => `${String(Math.floor(minutes % 1440 / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return schedule ? { timezone: schedule.timezone, updatedAt: new Date(updatedAt).toISOString(),
    days: schedule.weekly.map((ranges, index) => ({ day: days[index],
      hours: ranges.length ? ranges.map(([a, b]) => `${display(a)}–${display(b)}${b >= 1440 ? ' (+1 day)' : ''}`).join(', ') : 'Closed' })) } : null;
}
