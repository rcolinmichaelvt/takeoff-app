import { requireCondition } from './errors.js';
import { transaction } from './database.js';
import { milesBetween, validCoordinate } from './geography.js';
import { openMinutes } from './hours.js';
import { storeAddress } from './event-display.js';

export const MAX_TRIP_STOPS = 10;
const STOP_SECONDS = 5 * 60;
const MAX_ROUTE_AGE = 15 * 60_000;
const iso = value => new Date(value).toISOString();
const point = store => ({ latitude: store.latitude, longitude: store.longitude });
const samePoint = (a, b) => a && b && a.latitude === b.latitude && a.longitude === b.longitude;
const requireInput = condition => requireCondition(condition, 400, 'INVALID_TRIP', 'Refresh the trip and choose up to ten eligible stores.');

// An open path: nearest neighbour followed by bounded 2-opt improvements. Road
// estimates are measured separately by MapKit; distance is not claimed as traffic time.
export function orderStops(origin, stores) {
  const pending = [...stores].sort((a, b) => a.id.localeCompare(b.id)), route = [];
  let current = origin;
  while (pending.length) {
    pending.sort((a, b) => milesBetween(current, a) - milesBetween(current, b) || a.id.localeCompare(b.id));
    current = pending.shift(); route.push(current);
  }
  const length = items => items.reduce((sum, item, i) => sum + milesBetween(i ? items[i - 1] : origin, item), 0);
  for (let pass = 0; pass < 10; pass++) {
    let improved = false;
    for (let i = 0; i < route.length - 1; i++) for (let j = i + 1; j < route.length; j++) {
      const candidate = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
      if (length(candidate) + 0.001 < length(route)) { route.splice(0, route.length, ...candidate); improved = true; }
    }
    if (!improved) break;
  }
  return route;
}

export class Trips {
  constructor(appData) { this.app = appData; this.db = appData.db; this.clock = appData.clock; }
  record(id) { return this.db.prepare('SELECT * FROM active_trips WHERE discord_id=?').get(id); }
  context(id) {
    return { settings: this.app.settings(id), covered: this.app.coverage(), rows: this.app.storeRows(id) };
  }
  products(settings, products) {
    requireInput(Array.isArray(products) && products.length > 0 && products.length <= settings.products.length &&
      new Set(products).size === products.length && products.every(p => settings.products.includes(p) && this.app.products.has(p)));
    return products;
  }
  candidate(store, products) {
    if (store.excluded || store.distanceMiles == null || store.distanceMiles > 25 || !validCoordinate(store.latitude, store.longitude)) return false;
    return store.inventory.some(item => products.includes(item.upc) && !item.stale && item.quantity > 0 &&
      (item.status === 'available' || item.status === 'back' && item.forecast?.expectedAt && ['medium', 'high'].includes(item.forecast.confidence)));
  }
  preview(id, input) {
    requireInput(Object.keys(input).every(k => ['products', 'storeIds', 'zip', 'origin', 'legs', 'departureAt'].includes(k)));
    const context = this.context(id), { settings, covered } = context;
    requireCondition(settings.zip && this.app.config.monitor.enabled, 409, 'TRIP_UNAVAILABLE', 'Save a ZIP and enable monitoring before planning a trip.');
    const products = this.products(settings, input.products);
    const stores = context.rows.map(row => this.app.storeView(row, settings, covered));
    const candidates = stores.filter(store => this.candidate(store, products)).sort((a, b) => a.distanceMiles - b.distanceMiles || a.id.localeCompare(b.id));
    let selected;
    if (input.storeIds === undefined) {
      requireInput(input.legs === undefined);
      selected = candidates.filter(s => s.inventory.some(i => products.includes(i.upc) && !i.stale && i.quantity > 0 && i.status === 'available')).slice(0, MAX_TRIP_STOPS);
    } else {
      requireInput(Array.isArray(input.storeIds) && input.storeIds.length <= MAX_TRIP_STOPS &&
        new Set(input.storeIds).size === input.storeIds.length && input.storeIds.every(s => typeof s === 'string' && /^\d{1,12}$/.test(s)));
      selected = input.storeIds.map(id => stores.find(s => s.id === id));
      requireInput(selected.every(Boolean));
      // An edited preview can show a now-invalid stop so it can be removed;
      // only save() admits stops to the persistent navigable trip.
      requireInput(selected.every(s => validCoordinate(s.latitude, s.longitude)));
    }
    let departure = this.clock(), legs = [];
    if (input.legs !== undefined) {
      requireInput(input.zip === settings.zip && samePoint(input.origin, settings.center));
      departure = Date.parse(input.departureAt);
      requireInput(Number.isFinite(departure) && departure <= this.clock() + 30_000 && this.clock() - departure <= MAX_ROUTE_AGE);
      requireInput(Array.isArray(input.legs) && input.legs.length === selected.length);
      let elapsed = 0;
      legs = input.legs.map((leg, index) => {
        const from = index ? selected[index - 1] : settings.center, to = selected[index];
        requireInput(leg && Object.keys(leg).every(k => ['storeId', 'from', 'to', 'seconds', 'meters'].includes(k)) &&
          leg.storeId === to.id && samePoint(leg.from, from) && samePoint(leg.to, to) &&
          Number.isSafeInteger(leg.seconds) && leg.seconds > 0 && leg.seconds <= 14400 &&
          Number.isFinite(leg.meters) && leg.meters >= 0 && leg.meters <= 1_000_000);
        elapsed += leg.seconds + (index ? STOP_SECONDS : 0);
        requireInput(elapsed <= 12 * 3600);
        return { storeId: to.id, from: point(from), to: point(to), seconds: leg.seconds, meters: leg.meters };
      });
    } else selected = orderStops(settings.center, selected);
    const data = { zip: settings.zip, origin: settings.center, products, storeIds: selected.map(s => s.id), legs,
      departureAt: iso(departure), checkedAt: iso(this.clock()) };
    return { data, trip: this.view(id, data, context), candidates: candidates.slice(0, 250) };
  }
  state(store, data, arrival, context) {
    const reasons = [], warnings = [];
    const relevant = store.inventory.filter(i => data.products.includes(i.upc));
    const fresh = relevant.filter(i => !i.stale && i.quantity > 0);
    const available = fresh.some(i => i.status === 'available');
    const predicted = fresh.filter(i => i.status === 'back' && i.forecast?.expectedAt && ['medium', 'high'].includes(i.forecast.confidence));
    let state = available ? 'available' : predicted.length ? 'expected' : fresh.some(i => i.status === 'back') ? 'back' :
      relevant.length && relevant.every(i => !i.stale && i.quantity === 0) ? 'out' : 'unknown';
    if (!this.app.config.monitor.enabled) reasons.push('Monitoring is paused.');
    if (context.settings.zip !== data.zip || !samePoint(context.settings.center, data.origin)) reasons.push('Your saved ZIP changed. Suggest a new route.');
    if (!data.products.every(p => context.settings.products.includes(p) && this.app.products.has(p))) reasons.push('Your followed products changed. Suggest a new route.');
    if (store.excluded) reasons.push('This store is excluded.');
    if (store.distanceMiles == null || store.distanceMiles > 25) reasons.push('This store is outside your saved area.');
    if (!available) {
      if (state === 'out') reasons.push('Selected products are sold out.');
      else if (state === 'unknown') reasons.push('Shelf availability is unknown or observations are stale.');
      else if (!arrival || !predicted.some(i => Date.parse(i.forecast.expectedAt) <= arrival)) reasons.push('New stock is not predicted ready by this arrival.');
      else warnings.push('Stock is still in back. Predicted ready by arrival; shelf availability is unconfirmed.');
    }
    if (!arrival) reasons.push('Check driving times before starting.');
    if (arrival) {
      const hours = this.app.intelligence.hours(store.id);
      if (!hours) warnings.push('Opening hours are unavailable. Check the store before driving.');
      else {
        const minutes = openMinutes(hours.schedule, arrival, arrival + 60_000);
        if (minutes === null) reasons.push('Opening hours cannot be verified for this arrival.');
        else if (minutes <= 0) reasons.push('The store is closed at the estimated arrival.');
      }
    }
    return { state, eligible: reasons.length === 0, warnings: [...reasons, ...warnings],
      expectedAt: predicted.length ? predicted.map(i => i.forecast.expectedAt).sort()[0] : null };
  }
  view(id, data, context = this.context(id)) {
    let elapsed = 0;
    const departure = Date.parse(data.departureAt), roadFresh = this.clock() - Date.parse(data.checkedAt) <= MAX_ROUTE_AGE;
    const stops = data.storeIds.map((id, index) => {
      const row = context.rows.find(s => s.id === id);
      const store = row ? this.app.storeView(row, context.settings, context.covered) : null;
      if (!store) return null;
      const leg = data.legs[index], from = index ? context.rows.find(s => s.id === data.storeIds[index - 1]) : context.settings.center;
      const validLeg = leg?.storeId === id && samePoint(leg.from, from) && samePoint(leg.to, store);
      elapsed += validLeg ? leg.seconds + (index ? STOP_SECONDS : 0) : 0;
      const complete = data.legs.length === data.storeIds.length && data.legs.slice(0, index + 1).every((l, i) =>
        l.storeId === data.storeIds[i] && samePoint(l.to, context.rows.find(s => s.id === l.storeId)) &&
        samePoint(l.from, i ? context.rows.find(s => s.id === data.storeIds[i - 1]) : context.settings.center));
      const arrival = complete ? departure + elapsed * 1000 : null;
      const state = this.state(store, data, arrival, context);
      return { store, arrivalAt: arrival == null ? null : iso(arrival), driveSeconds: validLeg ? leg.seconds : null,
        distanceMeters: validLeg ? leg.meters : null, ...state };
    }).filter(Boolean);
    return { zip: data.zip, origin: data.origin, products: data.products, departureAt: data.departureAt, checkedAt: data.checkedAt,
      stopMinutes: STOP_SECONDS / 60, maxStops: MAX_TRIP_STOPS, stops,
      totalDriveSeconds: data.legs.reduce((sum, leg) => sum + leg.seconds, 0),
      needsReplan: !roadFresh || this.clock() - departure > MAX_ROUTE_AGE,
      canOpen: roadFresh && this.clock() - departure <= MAX_ROUTE_AGE && stops.length > 0 && stops.length === data.storeIds.length && stops.every(s => s.eligible) };
  }
  get(id) {
    const row = this.record(id);
    return { version: row?.version || 0, trip: row?.trip_json ? this.view(id, JSON.parse(row.trip_json)) : null };
  }
  save(id, input) {
    requireInput(Object.keys(input).every(k => ['version', 'products', 'storeIds', 'zip', 'origin', 'legs', 'departureAt'].includes(k)) && input.legs !== undefined);
    const { version, ...request } = input;
    requireInput(Number.isSafeInteger(version) && version >= 0);
    return transaction(this.db, () => {
      requireCondition(version === (this.record(id)?.version || 0), 409, 'TRIP_CHANGED', 'This trip changed. Refresh it before editing.');
      const result = this.preview(id, request);
      requireCondition(result.trip.canOpen, 409, 'TRIP_NOT_READY', 'A stop changed or cannot be reached in time. Review the route warnings.');
      this.db.prepare(`INSERT INTO active_trips (discord_id,version,trip_json,state_json,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(discord_id) DO UPDATE SET version=excluded.version,trip_json=excluded.trip_json,state_json=excluded.state_json,updated_at=excluded.updated_at`)
        .run(id, version + 1, JSON.stringify(result.data), JSON.stringify(this.snapshot(result.trip)), this.clock());
      return this.get(id);
    });
  }
  clear(id, input) {
    requireInput(Object.keys(input).length === 1 && Number.isSafeInteger(input.version) && input.version >= 0);
    return transaction(this.db, () => {
      requireCondition(input.version === (this.record(id)?.version || 0), 409, 'TRIP_CHANGED', 'This trip changed. Refresh it before editing.');
      this.db.prepare(`INSERT INTO active_trips (discord_id,version,trip_json,state_json,updated_at) VALUES (?,?,NULL,'{}',?)
        ON CONFLICT(discord_id) DO UPDATE SET version=excluded.version,trip_json=NULL,state_json='{}',updated_at=excluded.updated_at`)
        .run(id, input.version + 1, this.clock());
      return this.get(id);
    });
  }
  snapshot(trip) {
    return Object.fromEntries(trip.stops.map(s => [s.store.id, { state: s.state, eligible: s.eligible, expectedAt: s.expectedAt,
      products: s.store.inventory.filter(i => trip.products.includes(i.upc)).map(i => `${i.upc}:${i.status}:${i.stale}`).join('|') }]));
  }
  sweep() {
    for (const row of this.db.prepare('SELECT * FROM active_trips WHERE trip_json IS NOT NULL').all()) {
      if (!this.app.config.allowedIds.has(row.discord_id)) continue;
      const data = JSON.parse(row.trip_json);
      if (this.clock() - Date.parse(data.departureAt) > 12 * 3600_000) continue;
      const trip = this.view(row.discord_id, data), previous = JSON.parse(row.state_json), next = this.snapshot(trip);
      const settings = this.app.settings(row.discord_id);
      transaction(this.db, () => {
        for (const stop of trip.stops) {
          const old = previous[stop.store.id], state = next[stop.store.id];
          const shifted = old?.expectedAt !== state.expectedAt && (old?.expectedAt == null || state.expectedAt == null ||
            Math.abs(Date.parse(old.expectedAt) - Date.parse(state.expectedAt)) >= 5 * 60_000);
          const changed = old && (old.state !== state.state || old.eligible !== state.eligible || old.products !== state.products || shifted);
          if (changed && settings.alerts.tripChanges && !stop.store.excluded && data.zip === settings.zip &&
              data.products.some(upc => settings.products.includes(upc))) {
            this.db.prepare("INSERT INTO events (discord_id,kind,payload_json,created_at) VALUES (?,'trip_change',?,?)")
              .run(row.discord_id, JSON.stringify({ storeId: stop.store.id, address: storeAddress(stop.store),
                title: 'Your trip stop changed', body: 'Stock availability or arrival conditions changed. Open Trips to review and replan.',
                notificationsPaused: settings.alerts.paused }), this.clock());
          }
          // Keep the last notified forecast as the comparison point for small shifts.
          if (!changed && old) next[stop.store.id] = old;
        }
        this.db.prepare('UPDATE active_trips SET state_json=? WHERE discord_id=?').run(JSON.stringify(next), row.discord_id);
      });
    }
  }
}
