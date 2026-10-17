import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Temporal } from '@js-temporal/polyfill';
import { requireCondition, AppError } from './errors.js';
import { transaction } from './database.js';
import { milesBetween } from './geography.js';
import { DAY, localDate } from './hours.js';

export const CALENDAR_BODY_LIMIT = 2 * 1024 * 1024;
export const calendarDefaults = Object.freeze({ showModerator: true, showPrivate: true, showPredictions: true, favoritesOnly: true });
const iso = value => new Date(value).toISOString();
const invalid = condition => requireCondition(condition, 400, 'INVALID_CALENDAR_EVENT', 'Check the event details, dates, and image, then try again.');
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
let imageWork = 0;
sharp.cache({ memory: 16, files: 0, items: 20 });
sharp.concurrency(1);

export async function normalizeCalendarImage(value) {
  invalid(typeof value === 'string' && value.length > 0 && value.length <= 2_000_000 &&
    value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value));
  requireCondition(imageWork < 2, 429, 'IMAGE_BUSY', 'Image processing is busy. Try again shortly.');
  imageWork++;
  try {
    const bytes = Buffer.from(value, 'base64');
    invalid(bytes.length <= 1_500_000 && bytes.toString('base64') === value);
    // Reject non-raster formats before asking the image decoder to inspect them.
    invalid(bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    const pipeline = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const meta = await pipeline.metadata();
    invalid(['jpeg', 'png'].includes(meta.format) && (meta.pages || 1) === 1);
    const { data, info } = await pipeline.rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    invalid(data.length <= 800_000);
    // Sharp's output defaults strip EXIF/GPS and other input metadata.
    return { data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_CALENDAR_IMAGE', 'Choose a readable JPEG or PNG image.');
  } finally { imageWork--; }
}

export class CalendarEvents {
  constructor(app) { this.app = app; this.db = app.db; this.clock = app.clock; }
  isModerator(id) { return this.app.config.moderatorIds.has(id); }
  options(id) {
    const row = this.db.prepare('SELECT options_json FROM calendar_preferences WHERE discord_id=?').get(id);
    return { ...calendarDefaults, ...(row ? JSON.parse(row.options_json) : {}) };
  }
  saveOptions(id, input) {
    invalid(Object.entries(input).every(([k, v]) => Object.hasOwn(calendarDefaults, k) && typeof v === 'boolean'));
    const options = { ...this.options(id), ...input };
    this.db.prepare(`INSERT INTO calendar_preferences VALUES (?,?) ON CONFLICT(discord_id)
      DO UPDATE SET options_json=excluded.options_json`).run(id, JSON.stringify(options));
    return options;
  }
  row(id) {
    return this.db.prepare(`SELECT e.*,z.latitude,z.longitude,EXISTS(SELECT 1 FROM calendar_images i WHERE i.event_id=e.id) has_image
      FROM calendar_events e LEFT JOIN zip_regions z ON z.zip=e.zip WHERE e.id=?`).get(id);
  }
  canRead(id, row) {
    if (row.visibility === 'private') return row.owner_id === id;
    if (this.isModerator(id) || !row.zip) return true;
    const center = this.app.settings(id).center;
    const distance = center ? milesBetween(center, row) : null;
    return distance !== null && distance <= 25;
  }
  canEdit(id, row) { return row.visibility === 'private' ? row.owner_id === id : this.isModerator(id); }
  get(id, eventId) {
    const row = this.row(eventId);
    requireCondition(row && this.canRead(id, row), 404, 'NOT_FOUND', 'Calendar event not found.');
    return this.view(id, row, row.starts_at, row.ends_at);
  }
  view(id, row, start, end) {
    return { id: row.id, occurrenceId: `${row.id}:${start}`, source: row.visibility,
      title: row.title, description: row.description, retailer: row.retailer, location: row.location, zip: row.zip,
      startsAt: iso(start), endsAt: iso(end), seriesStartsAt: iso(row.starts_at), seriesEndsAt: iso(row.ends_at),
      timezone: row.timezone, recurrence: row.recurrence, repeatUntil: row.repeat_until ? iso(row.repeat_until) : null,
      version: row.version, canEdit: this.canEdit(id, row), hasImage: Boolean(row.has_image), updatedAt: iso(row.updated_at) };
  }
  async save(id, eventId, input, assertAuthorized = () => {}) {
    const keys = ['version', 'visibility', 'title', 'description', 'retailer', 'location', 'zip', 'startsAt', 'endsAt',
      'timezone', 'recurrence', 'repeatUntil', 'imageBase64', 'removeImage'];
    invalid(Object.keys(input).every(k => keys.includes(k)) && Number.isSafeInteger(input.version) && input.version >= 0);
    const existing = eventId ? this.row(eventId) : null;
    if (eventId) requireCondition(existing && this.canEdit(id, existing), 404, 'NOT_FOUND', 'Calendar event not found.');
    invalid(['private', 'moderator'].includes(input.visibility) && (!existing || existing.visibility === input.visibility));
    requireCondition(input.visibility !== 'moderator' || this.isModerator(id), 403, 'MODERATOR_REQUIRED', 'Only moderators can publish shared calendar events.');
    for (const [key, limit] of [['title', 120], ['description', 3000], ['retailer', 60], ['location', 250]]) {
      invalid(typeof input[key] === 'string' && input[key].length <= limit && !input[key].includes('\0'));
    }
    invalid(input.title.trim().length > 0 && typeof input.timezone === 'string');
    try { Temporal.Now.zonedDateTimeISO(input.timezone); } catch { invalid(false); }
    const start = stamp(input.startsAt), end = stamp(input.endsAt);
    invalid(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 7 * DAY &&
      start >= this.clock() - 366 * DAY && start <= this.clock() + 366 * DAY);
    invalid(['none', 'weekly'].includes(input.recurrence));
    const repeatUntil = input.recurrence === 'weekly' ? stamp(input.repeatUntil) : null;
    invalid(input.recurrence === 'none' ? input.repeatUntil == null : Number.isFinite(repeatUntil) && repeatUntil >= start && repeatUntil <= start + 183 * DAY);
    invalid(input.zip == null || input.zip === '' || typeof input.zip === 'string' && /^\d{5}$/.test(input.zip));
    invalid(input.removeImage === undefined || typeof input.removeImage === 'boolean');
    invalid(!(input.imageBase64 !== undefined && input.removeImage));
    requireCondition(input.imageBase64 === undefined || input.visibility === 'moderator' && this.isModerator(id),
      403, 'MODERATOR_REQUIRED', 'Images are available on moderator calendar posts.');
    const zip = input.zip || null;
    if (zip) await this.app.geography.resolveZip(zip);
    const image = input.imageBase64 === undefined ? null : await normalizeCalendarImage(input.imageBase64);
    assertAuthorized();
    requireCondition(input.visibility !== 'moderator' || this.isModerator(id), 403, 'MODERATOR_REQUIRED', 'Only moderators can publish shared calendar events.');
    return transaction(this.db, () => {
      const current = eventId ? this.row(eventId) : null;
      if (eventId) requireCondition(current && this.canEdit(id, current), 404, 'NOT_FOUND', 'Calendar event not found.');
      requireCondition(input.version === (current?.version || 0), 409, 'CALENDAR_CHANGED', 'This event changed. Reopen it before editing.');
      if (!eventId) {
        const count = this.db.prepare('SELECT COUNT(*) n FROM calendar_events WHERE owner_id=?').get(id).n;
        requireCondition(count < (this.isModerator(id) ? 500 : 100), 409, 'CALENDAR_LIMIT', 'Delete an old event before adding another.');
      }
      const key = eventId || randomUUID(), now = this.clock();
      this.db.prepare(`INSERT INTO calendar_events
        (id,owner_id,visibility,title,description,retailer,location,zip,starts_at,ends_at,timezone,recurrence,repeat_until,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
        retailer=excluded.retailer,location=excluded.location,zip=excluded.zip,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
        timezone=excluded.timezone,recurrence=excluded.recurrence,repeat_until=excluded.repeat_until,version=excluded.version,updated_at=excluded.updated_at`)
        .run(key, current?.owner_id || id, input.visibility, input.title.trim(), input.description.trim(), input.retailer.trim(),
          input.location.trim(), zip, start, end, input.timezone, input.recurrence, repeatUntil, (current?.version || 0) + 1, current?.created_at || now, now);
      if (image) this.db.prepare(`INSERT INTO calendar_images VALUES (?,?,?,?) ON CONFLICT(event_id)
        DO UPDATE SET jpeg=excluded.jpeg,width=excluded.width,height=excluded.height`).run(key, image.data, image.width, image.height);
      if (input.removeImage) this.db.prepare('DELETE FROM calendar_images WHERE event_id=?').run(key);
      return this.get(id, key);
    });
  }
  remove(id, eventId, input) {
    invalid(Object.keys(input).length === 1 && Number.isSafeInteger(input.version));
    const row = this.row(eventId);
    requireCondition(row && this.canEdit(id, row), 404, 'NOT_FOUND', 'Calendar event not found.');
    requireCondition(row.version === input.version, 409, 'CALENDAR_CHANGED', 'This event changed. Reopen it before deleting.');
    this.db.prepare('DELETE FROM calendar_events WHERE id=?').run(eventId);
    return { deleted: true };
  }
  image(id, eventId) {
    this.get(id, eventId);
    const row = this.db.prepare('SELECT jpeg,width,height FROM calendar_images WHERE event_id=?').get(eventId);
    requireCondition(row, 404, 'NOT_FOUND', 'Image not found.');
    return { base64: Buffer.from(row.jpeg).toString('base64'), width: row.width, height: row.height };
  }
  list(id, query) {
    invalid(Object.keys(query).every(k => ['from', 'to', 'after'].includes(k)));
    const from = Number(query.from), to = Number(query.to);
    invalid(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to && to - from <= 62 * DAY &&
      from >= this.clock() - 400 * DAY && to <= this.clock() + 400 * DAY);
    let cursor = null;
    if (query.after) {
      try { cursor = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8')); } catch { invalid(false); }
      invalid(Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[0]) && typeof cursor[1] === 'string' && cursor[1].length < 80);
    }
    const options = this.options(id), entries = [];
    const rows = this.db.prepare(`SELECT e.*,z.latitude,z.longitude,EXISTS(SELECT 1 FROM calendar_images i WHERE i.event_id=e.id) has_image
      FROM calendar_events e LEFT JOIN zip_regions z ON z.zip=e.zip
      WHERE (e.visibility='moderator' OR e.owner_id=?) AND e.starts_at<? AND
      (e.ends_at>? OR e.recurrence='weekly' AND e.repeat_until+e.ends_at-e.starts_at>?)`).all(id, to, from, from);
    for (const row of rows) {
      if (!this.canRead(id, row) || row.visibility === 'private' && !options.showPrivate || row.visibility === 'moderator' && !options.showModerator) continue;
      const firstStart = Temporal.Instant.fromEpochMilliseconds(row.starts_at).toZonedDateTimeISO(row.timezone);
      const firstEnd = Temporal.Instant.fromEpochMilliseconds(row.ends_at).toZonedDateTimeISO(row.timezone);
      for (let n = 0; n < 28; n++) {
        const start = firstStart.add({ weeks: n });
        let end = firstEnd.add({ weeks: n });
        // A nonexistent spring-forward start may move beyond a valid local end.
        // Keep that occurrence positive using the original elapsed duration.
        if (end.epochMilliseconds <= start.epochMilliseconds) end = start.add({ milliseconds: row.ends_at - row.starts_at });
        if (start.epochMilliseconds >= to || n && start.epochMilliseconds > row.repeat_until) break;
        if (end.epochMilliseconds > from) entries.push(this.view(id, row, start.epochMilliseconds, end.epochMilliseconds));
        if (row.recurrence === 'none') break;
      }
    }
    entries.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0));
    const filtered = cursor ? entries.filter(e => Date.parse(e.startsAt) > cursor[0] || Date.parse(e.startsAt) === cursor[0] && e.occurrenceId > cursor[1]) : entries;
    const selected = filtered.slice(0, 200), last = selected.at(-1);
    return { events: selected, nextCursor: filtered.length > 200 ? Buffer.from(JSON.stringify([Date.parse(last.startsAt), last.occurrenceId])).toString('base64url') : null,
      predictions: cursor ? [] : this.predictions(id, from, to, options), preferences: options, serverTime: iso(this.clock()) };
  }
  predictions(id, from, to, options) {
    if (!options.showPredictions || !this.app.config.monitor.enabled) return [];
    const settings = this.app.settings(id), covered = this.app.coverage(), grouped = new Map();
    for (const row of this.app.storeRows(id)) {
      if (row.excluded || options.favoritesOnly && !row.favorite) continue;
      const store = this.app.storeView(row, settings, covered);
      if (store.distanceMiles == null || store.distanceMiles > 25) continue;
      for (const item of store.inventory) {
        const forecast = item.forecast, at = Date.parse(forecast?.expectedAt);
        if (!settings.products.includes(item.upc) || item.status !== 'back' || item.stale || item.quantity <= 0 ||
          !Number.isFinite(at) || at < this.clock() || at < from || at >= to || !['medium', 'high'].includes(forecast.confidence)) continue;
        const key = `${store.id}:${localDate(at, store.timing.openingHours.timezone)}`;
        const entry = grouped.get(key) || { id: key, storeId: store.id, address: [store.address, store.city, store.state].filter(Boolean).join(', '),
          expectedAt: iso(at), confidence: forecast.confidence, titles: [] };
        entry.titles.push(item.title);
        if (forecast.confidence === 'medium') entry.confidence = 'medium';
        if (at < Date.parse(entry.expectedAt)) entry.expectedAt = iso(at);
        grouped.set(key, entry);
      }
    }
    return [...grouped.values()].sort((a, b) => a.expectedAt.localeCompare(b.expectedAt) || a.id.localeCompare(b.id));
  }
}
