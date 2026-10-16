import { DAY, HOURS_MAX_AGE, openMinutes, addOpenMinutes, localDate, sameSchedule, scheduleView } from './hours.js';
import { storeAddress } from './event-display.js';
import { milesBetween } from './geography.js';
import { transaction } from './database.js';

const iso = value => value == null ? null : new Date(value).toISOString();
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const TRAVEL_MAX_AGE = DAY;
export const TRAVEL_REFRESH_AGE = 6 * 60 * 60_000;

export class Intelligence {
  constructor({ db, config, clock = Date.now }) { Object.assign(this, { db, config, clock }); }

  hours(storeId) {
    const row = this.db.prepare('SELECT * FROM store_hours WHERE store_id=?').get(storeId);
    if (!row?.schedule_json || row.updated_at > this.clock() || this.clock() - row.updated_at > HOURS_MAX_AGE) return null;
    return { schedule: JSON.parse(row.schedule_json), updatedAt: row.updated_at };
  }

  observe(storeId, upc, previous, next, now) {
    const batch = this.db.prepare("SELECT * FROM restock_batches WHERE store_id=? AND upc=? AND state='pending'").get(storeId, upc);
    const end = (reason, state = 'uncertain') => {
      if (batch) this.db.prepare('UPDATE restock_batches SET state=?,reason=?,ended_at=? WHERE id=?').run(state, reason, now, batch.id);
    };
    if (next.kind === 'resumed' || next.kind === 'baseline') { end('monitoring_gap'); return; }
    const hours = this.hours(storeId);
    if (next.event === 'stock_increase') {
      const overlap = !!batch || previous.pending_quantity > 0;
      end('overlapping_deliveries');
      const reason = overlap ? 'overlapping_deliveries' : previous.status === 'unknown' && previous.quantity > 0
        ? 'unknown_prior_stock' : hours ? null : 'hours_unavailable_at_arrival';
      this.db.prepare(`INSERT INTO restock_batches (store_id,upc,quantity,started_at,state,reason,schedule_json)
        VALUES (?,?,?,?,'pending',?,?)`).run(storeId, upc, next.quantity - previous.quantity, now,
        reason, hours ? JSON.stringify(hours.schedule) : null);
      return;
    }
    if (!batch) return;
    // Zero/sold-out can also be the first observation proving new stock sold.
    const qualified = previous.pending_quantity > 0 && next.quantity < previous.pending_quantity && next.pending === 0;
    if (!qualified) return;
    const startSchedule = batch.schedule_json ? JSON.parse(batch.schedule_json) : null;
    const reason = batch.reason || (!hours ? 'hours_unavailable' : !sameSchedule(startSchedule, hours.schedule) ? 'hours_changed' : null);
    const minutes = reason ? null : openMinutes(startSchedule, batch.started_at, now);
    if (reason || minutes === null || minutes <= 0 || now - batch.started_at > 7 * DAY) {
      end(reason || 'insufficient_open_hours'); return;
    }
    const weekday = localDate(batch.started_at, startSchedule.timezone).dayOfWeek;
    this.db.prepare(`INSERT INTO store_timing (store_id,weekday,samples,total_minutes,squared_minutes,last_sample_at)
      VALUES (?,?,1,?,?,?) ON CONFLICT(store_id,weekday) DO UPDATE SET samples=samples+1,
      total_minutes=total_minutes+excluded.total_minutes,squared_minutes=squared_minutes+excluded.squared_minutes,
      last_sample_at=excluded.last_sample_at`).run(storeId, weekday, minutes, minutes * minutes, now);
    this.db.prepare("UPDATE restock_batches SET state='selling',ended_at=?,open_minutes=? WHERE id=?").run(now, minutes, batch.id);
  }

  timing(storeId) {
    const rows = this.db.prepare('SELECT * FROM store_timing WHERE store_id=? ORDER BY weekday').all(storeId);
    const count = rows.reduce((total, r) => total + r.samples, 0);
    const mean = count ? rows.reduce((total, r) => total + r.total_minutes, 0) / count : null;
    const spread = count > 1 ? Math.sqrt(Math.max(0,
      (rows.reduce((total, r) => total + r.squared_minutes, 0) - count * mean ** 2) / (count - 1))) : null;
    const last = count ? Math.max(...rows.map(r => r.last_sample_at)) : null;
    const recent = last !== null && this.clock() - last <= 30 * DAY;
    const confidence = !count ? 'learning' : !recent || count < 3 || spread / Math.max(mean, 1) > 0.75 ? 'low'
      : count >= 8 && spread / Math.max(mean, 1) <= 0.4 ? 'high' : 'medium';
    const hours = this.hours(storeId);
    return { sampleCount: count, averageOpenMinutes: mean, spreadOpenMinutes: spread, confidence,
      lastSampleAt: iso(last), hoursStatus: hours ? 'ready' : 'unavailable',
      openingHours: hours ? scheduleView(hours.schedule, hours.updatedAt) : null,
      patterns: rows.map(row => ({ weekday: row.weekday, day: weekdays[row.weekday - 1], samples: row.samples,
        averageOpenMinutes: row.total_minutes / row.samples })) };
  }

  forecast(storeId, stock, stale, timing = this.timing(storeId)) {
    if (stale || !this.config.monitor.enabled || stock.pending_quantity <= 0) return null;
    const batch = this.db.prepare("SELECT * FROM restock_batches WHERE store_id=? AND upc=? AND state='pending'").get(storeId, stock.upc);
    if (!batch) return null; // M2 pending stock never becomes a fabricated timing sample.
    const hours = this.hours(storeId);
    let reason = batch.reason || (!hours ? 'hours_unavailable' : !sameSchedule(JSON.parse(batch.schedule_json), hours.schedule) ? 'hours_changed' : null);
    if (!reason && !timing.sampleCount) reason = 'learning';
    if (!reason && this.clock() - Date.parse(timing.lastSampleAt) > 90 * DAY) reason = 'old_samples';
    const expected = reason ? null : addOpenMinutes(hours.schedule, batch.started_at, timing.averageOpenMinutes);
    if (!reason && expected === null) reason = 'hours_unavailable';
    return { batchId: batch.id, startedAt: iso(batch.started_at), pendingQuantity: stock.pending_quantity,
      expectedAt: iso(expected), confidence: reason ? 'learning' : timing.confidence, sampleCount: timing.sampleCount,
      state: expected !== null && expected <= this.clock() ? 'expected_unconfirmed' : 'pending', reason };
  }

  travel(discordId, store, zip) {
    if (!zip) return null;
    const row = this.db.prepare('SELECT * FROM travel_estimates WHERE discord_id=? AND store_id=? AND zip=?').get(discordId, store.id, zip);
    if (!row || row.latitude !== store.latitude || row.longitude !== store.longitude || row.updated_at > this.clock() ||
        this.clock() - row.updated_at > TRAVEL_MAX_AGE) return null;
    return { seconds: row.seconds, updatedAt: iso(row.updated_at), source: 'apple_maps_device' };
  }

  sweep(appData) {
    const now = this.clock();
    // Cancel uncertainty even before the next provider response or during backoff.
    const covered = appData.coverage();
    const batches = this.db.prepare(`SELECT b.*,i.quantity stock_quantity,i.pending_quantity,i.observed_at,i.status
      FROM restock_batches b JOIN inventory i ON i.store_id=b.store_id AND i.upc=b.upc WHERE b.state='pending'`).all();
    transaction(this.db, () => {
      for (const batch of batches) {
        if (!covered.has(`${batch.store_id}:${batch.upc}`) || now - batch.observed_at > this.config.monitor.staleAfterMs ||
            now - batch.started_at > 7 * DAY || !this.config.monitor.enabled) {
          this.db.prepare("UPDATE restock_batches SET state='uncertain',reason='monitoring_gap',ended_at=? WHERE id=?").run(now, batch.id);
          continue;
        }
        if (batch.reason) continue;
        const hours = this.hours(batch.store_id);
        if (!hours || !sameSchedule(JSON.parse(batch.schedule_json), hours.schedule)) {
          this.db.prepare("UPDATE restock_batches SET reason=? WHERE id=?").run(hours ? 'hours_changed' : 'hours_unavailable', batch.id);
          continue;
        }
        const timing = this.timing(batch.store_id);
        const forecast = this.forecast(batch.store_id, { ...batch, quantity: batch.stock_quantity }, false, timing);
        if (!forecast?.expectedAt || !['medium', 'high'].includes(forecast.confidence)) continue;
        const store = this.db.prepare('SELECT * FROM stores WHERE id=?').get(batch.store_id);
        for (const member of appData.subscriptions()) {
          if (!member.alerts.approaching || !member.products.includes(batch.upc)) continue;
          const area = this.db.prepare('SELECT distance FROM area_inventory WHERE zip=? AND store_id=? AND upc=?')
            .get(member.zip, store.id, batch.upc);
          const distance = milesBetween(member, store) ?? area?.distance ?? null;
          if (distance === null || distance > 25 || this.db.prepare('SELECT excluded FROM store_preferences WHERE discord_id=? AND store_id=?')
            .get(member.discord_id, store.id)?.excluded) continue;
          const travel = this.travel(member.discord_id, store, member.zip);
          if (!travel) continue;
          const expected = Date.parse(forecast.expectedAt), due = expected - travel.seconds * 1000 - 5 * 60_000;
          // Don't issue a stale departure warning when learning resumes too late.
          if (now < due || now - due > 2 * 60_000 || now >= expected) continue;
          const inserted = this.db.prepare('INSERT INTO approaching_sent (batch_id,discord_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
            .run(batch.id, member.discord_id, now);
          if (!inserted.changes) continue;
          const product = appData.products.get(batch.upc)?.title || batch.upc;
          this.db.prepare("INSERT INTO events (discord_id,kind,payload_json,created_at) VALUES (?,'approaching',?,?)")
            .run(member.discord_id, JSON.stringify({ storeId: store.id, upc: batch.upc, address: storeAddress(store),
              title: `Restock departure warning · ${product}`, body: `About ${Math.ceil(travel.seconds / 60)} minutes from your saved ZIP. Shelf availability is still unconfirmed.`,
              batchId: batch.id, predictedAt: forecast.expectedAt, departureAt: iso(due), driveSeconds: travel.seconds,
              driveUpdatedAt: travel.updatedAt, confidence: forecast.confidence, notificationsPaused: member.alerts.paused }), now);
        }
      }
    });
  }
}
