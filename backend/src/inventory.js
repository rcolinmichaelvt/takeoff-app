import { transaction } from './database.js';
import { milesBetween } from './geography.js';
import { storeAddress } from './event-display.js';
import { DAY, normalizeHours } from './hours.js';

export const AVAILABILITY_TTL_MS = 7 * DAY;

// Availability is a recent sale signal; timing still uses the new-batch threshold.
// Read-time expiry also applies when no poll happens at the seven-day boundary.
export function inventoryStatus(stock, now) {
  if (stock.quantity === 0) return 'out';
  if (stock.status !== 'available') return stock.status;
  if (Number.isFinite(stock.last_decrease_at) && stock.last_decrease_at <= now &&
      now - stock.last_decrease_at < AVAILABILITY_TTL_MS) return 'available';
  return stock.pending_quantity >= stock.quantity ? 'back' : 'unknown';
}

// Upgrade the old policy's unknown/yellow rows only when the latest recorded change
// proves a positive-quantity decrease. Never infer a sale from a zero or a gap.
export function restoreRecentDecreaseSignals(db, now) {
  db.prepare(`UPDATE inventory SET status='available' WHERE status IN ('unknown','back') AND quantity>0
    AND last_decrease_at>? AND last_decrease_at<=? AND last_decrease_at>=COALESCE(last_increase_at,0)
    AND EXISTS (SELECT 1 FROM inventory_history h WHERE h.store_id=inventory.store_id AND h.upc=inventory.upc
      AND h.created_at=inventory.last_decrease_at AND h.kind='decrease' AND h.quantity>0
      AND h.id=(SELECT MAX(recent.id) FROM inventory_history recent
        WHERE recent.store_id=inventory.store_id AND recent.upc=inventory.upc))`)
    .run(now - AVAILABILITY_TTL_MS, now);
}

// Shelf inference remains independent of predicted timing: no timed green pins.
export function observeInventory(previous, quantity, now, maximumGap = 9 * 60_000) {
  const fresh = previous && now >= previous.observed_at && now - previous.observed_at <= maximumGap;
  const next = { quantity, status: quantity === 0 ? 'out' : 'unknown', pending: 0,
    lastIncrease: previous?.last_increase_at ?? null, lastDecrease: previous?.last_decrease_at ?? null,
    kind: previous ? 'resumed' : 'baseline', event: null };
  if (!fresh) {
    // A lower live quantity is still a sale signal after a gap; 'resumed'
    // invalidates batch timing so this cannot train a fabricated arrival time.
    if (previous && quantity > 0 && quantity < previous.quantity) {
      next.status = 'available'; next.lastDecrease = now; next.event = 'decrease';
    }
    return next;
  }
  next.pending = previous.pending_quantity;
  next.status = inventoryStatus(previous, now);
  next.kind = null;
  const delta = quantity - previous.quantity;
  if (delta > 0) {
    next.lastIncrease = now;
    next.pending += delta;
    next.kind = next.event = 'stock_increase';
    next.status = quantity === next.pending || previous.status === 'back' || previous.quantity === 0
      ? 'back' : next.status === 'available' ? 'available' : 'unknown';
  } else if (delta < 0) {
    next.lastDecrease = now;
    next.status = 'available';
    next.kind = next.event = 'decrease';
    if (next.pending > 0 && quantity < next.pending) {
      next.pending = 0;
      next.status = 'available';
      next.kind = next.event = 'first_decrease';
    }
  }
  if (quantity === 0) {
    next.status = 'out'; next.pending = 0;
    if (previous.quantity > 0) next.kind = next.event = 'sold_out';
  }
  return next;
}

export class Inventory {
  constructor({ db, config, appData, clock = Date.now }) { Object.assign(this, { db, config, appData, clock }); }

  ingest(job, stores) {
    const now = this.clock();
    // Re-check active coverage after the network call; a departed last user must
    // not cause newly returned data or alerts to revive that subscription.
    if (!this.appData.jobs().has(`${job.zip}:${job.upc}`)) return;
    const subscribers = this.appData.subscriptions();
    transaction(this.db, () => {
      for (const store of stores) {
        const distance = milesBetween(job, store) ?? store.distance;
        if (distance !== null && distance > 25) continue;
        this.db.prepare(`INSERT INTO stores (id,address,city,state,postal_code,phone,latitude,longitude,coordinate_source,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,city=excluded.city,
          state=excluded.state,postal_code=excluded.postal_code,phone=excluded.phone,
          latitude=CASE WHEN stores.address<>excluded.address OR stores.city<>excluded.city OR stores.state<>excluded.state THEN excluded.latitude ELSE COALESCE(excluded.latitude,stores.latitude) END,
          longitude=CASE WHEN stores.address<>excluded.address OR stores.city<>excluded.city OR stores.state<>excluded.state THEN excluded.longitude ELSE COALESCE(excluded.longitude,stores.longitude) END,
          coordinate_source=CASE WHEN stores.address<>excluded.address OR stores.city<>excluded.city OR stores.state<>excluded.state THEN excluded.coordinate_source ELSE COALESCE(excluded.coordinate_source,stores.coordinate_source) END,
          geocode_after=CASE WHEN stores.address<>excluded.address OR stores.city<>excluded.city OR stores.state<>excluded.state THEN 0 ELSE stores.geocode_after END,
          updated_at=excluded.updated_at`).run(store.id, store.address, store.city, store.state, store.postalCode || null,
          store.phone || null, store.latitude, store.longitude, store.latitude === null ? null : 'dg', now);
        this.db.prepare(`INSERT INTO area_inventory (zip,store_id,upc,distance,seen_at) VALUES (?,?,?,?,?)
          ON CONFLICT(zip,store_id,upc) DO UPDATE SET distance=excluded.distance,seen_at=excluded.seen_at`)
          .run(job.zip, store.id, job.upc, distance, now);
        if (store.hoursInfo !== undefined) {
          const location = this.db.prepare('SELECT latitude,longitude FROM stores WHERE id=?').get(store.id);
          const schedule = normalizeHours(store.hoursInfo, location);
          this.db.prepare(`INSERT INTO store_hours (store_id,schedule_json,updated_at,next_fetch_at,last_error)
            VALUES (?,?,?,?,?) ON CONFLICT(store_id) DO UPDATE SET schedule_json=excluded.schedule_json,
            updated_at=excluded.updated_at,next_fetch_at=excluded.next_fetch_at,last_error=excluded.last_error`)
            .run(store.id, schedule ? JSON.stringify(schedule) : null, schedule ? now : null, now + DAY,
              schedule ? null : 'INVENTORY_HOURS_UNRECOGNIZED');
        }
        const previous = this.db.prepare('SELECT * FROM inventory WHERE store_id=? AND upc=?').get(store.id, job.upc);
        const next = observeInventory(previous, store.quantity, now, this.config.monitor.staleAfterMs);
        this.appData.intelligence.observe(store.id, job.upc, previous, next, now);
        this.db.prepare(`INSERT INTO inventory (store_id,upc,quantity,status,pending_quantity,observed_at,last_increase_at,last_decrease_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(store_id,upc) DO UPDATE SET quantity=excluded.quantity,status=excluded.status,
          pending_quantity=excluded.pending_quantity,observed_at=excluded.observed_at,
          last_increase_at=excluded.last_increase_at,last_decrease_at=excluded.last_decrease_at`)
          .run(store.id, job.upc, store.quantity, next.status, next.pending, now, next.lastIncrease, next.lastDecrease);
        if (next.kind && (next.kind !== 'resumed' || previous.quantity !== store.quantity || previous.status !== next.status)) {
          this.db.prepare(`INSERT INTO inventory_history (store_id,upc,previous_quantity,quantity,status,kind,created_at)
            VALUES (?,?,?,?,?,?,?)`).run(store.id, job.upc, previous?.quantity ?? null, store.quantity, next.status, next.kind, now);
        }
        if (next.event) this.notify(subscribers, job.upc, store, previous.quantity, next, now);
      }
    });
  }

  notify(subscribers, upc, store, oldQuantity, next, now) {
    const location = this.db.prepare('SELECT latitude,longitude FROM stores WHERE id=?').get(store.id);
    const option = { stock_increase: 'stockIncrease', decrease: 'anyDecrease', first_decrease: 'firstDecrease', sold_out: 'soldOut' }[next.event];
    const title = this.appData.products.get(upc)?.title || upc;
    const labels = { stock_increase: 'Stock increased', decrease: 'Stock decreased', first_decrease: 'New stock likely for sale', sold_out: 'Sold out' };
    for (const member of subscribers) {
      if (!member.products.includes(upc) || !member.alerts[option]) continue;
      const regionRecord = this.db.prepare('SELECT distance,seen_at FROM area_inventory WHERE zip=? AND store_id=? AND upc=?')
        .get(member.zip, store.id, upc);
      const distance = milesBetween(member, location) ?? regionRecord?.distance ?? null;
      if (distance === null || distance > 25) continue;
      if (this.db.prepare('SELECT excluded FROM store_preferences WHERE discord_id=? AND store_id=?')
        .get(member.discord_id, store.id)?.excluded) continue;
      this.db.prepare('INSERT INTO events (discord_id,kind,payload_json,created_at) VALUES (?,?,?,?)')
        .run(member.discord_id, next.event, JSON.stringify({ storeId: store.id, upc, title: `${labels[next.event]} · ${title}`,
          address: storeAddress(store), body: `${oldQuantity} → ${store.quantity}.`, quantity: store.quantity,
          notificationsPaused: member.alerts.paused }), now);
    }
  }
}
