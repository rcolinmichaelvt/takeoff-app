import { requireCondition } from './errors.js';
import { transaction } from './database.js';
import { milesBetween } from './geography.js';

export const defaultAlerts = Object.freeze({ firstDecrease: true, soldOut: true, approaching: true,
  stockIncrease: false, anyDecrease: false, paused: false });
export const iso = value => value == null ? null : new Date(value).toISOString();

export class AppData {
  constructor({ db, config, catalog, geography, clock = Date.now }) {
    Object.assign(this, { db, config, catalog, geography, clock });
    this.products = new Map(catalog.map(p => [p.upc, p]));
  }

  settings(discordId) {
    const row = this.db.prepare(`SELECT p.*,z.latitude,z.longitude,z.label FROM preferences p
      LEFT JOIN zip_regions z ON z.zip = p.zip WHERE discord_id = ?`).get(discordId);
    return { zip: row?.zip || null, center: row?.zip ? { latitude: row.latitude, longitude: row.longitude, label: row.label } : null,
      radiusMiles: 25, products: row ? JSON.parse(row.products_json) : [],
      alerts: { ...defaultAlerts, ...(row ? JSON.parse(row.alerts_json) : {}) } };
  }

  async saveSettings(discordId, input, assertStillAuthorized = () => {}) {
    requireCondition(Object.keys(input).every(k => ['zip', 'products', 'alerts'].includes(k)),
      400, 'INVALID_INPUT', 'Only ZIP, product selections, and alert preferences can be changed here.');
    if (input.products !== undefined) requireCondition(Array.isArray(input.products) &&
      input.products.length <= this.catalog.length && input.products.every(p => typeof p === 'string' && this.products.has(p)) &&
      new Set(input.products).size === input.products.length,
    400, 'INVALID_PRODUCTS', 'Choose products from the approved catalog.');
    if (input.alerts !== undefined) requireCondition(input.alerts && typeof input.alerts === 'object' && !Array.isArray(input.alerts) &&
      Object.entries(input.alerts).every(([key, value]) => Object.hasOwn(defaultAlerts, key) && typeof value === 'boolean'),
    400, 'INVALID_INPUT', 'Invalid notification preferences.');
    if (input.zip !== undefined) await this.geography.resolveZip(input.zip);
    assertStillAuthorized();
    // Re-read after an asynchronous ZIP lookup so unrelated concurrent changes survive.
    return transaction(this.db, () => {
      const current = this.settings(discordId);
      this.db.prepare(`INSERT INTO preferences (discord_id,zip,products_json,alerts_json,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(discord_id) DO UPDATE SET zip=excluded.zip,products_json=excluded.products_json,
        alerts_json=excluded.alerts_json,updated_at=excluded.updated_at`).run(discordId,
        input.zip ?? current.zip, JSON.stringify(input.products ?? current.products),
        JSON.stringify({ ...current.alerts, ...input.alerts }), this.clock());
      return this.settings(discordId);
    });
  }

  subscriptions() {
    const rows = this.db.prepare(`SELECT p.*,z.latitude,z.longitude FROM preferences p
      JOIN zip_regions z ON z.zip = p.zip`).all();
    return rows.filter(row => this.config.allowedIds.has(row.discord_id))
      .map(row => ({ ...row, products: JSON.parse(row.products_json).filter(upc => this.products.has(upc)),
        alerts: { ...defaultAlerts, ...JSON.parse(row.alerts_json) } }));
  }

  jobs() {
    const jobs = new Map();
    for (const member of this.subscriptions()) for (const upc of member.products) {
      jobs.set(`${member.zip}:${upc}`, { zip: member.zip, upc, latitude: member.latitude, longitude: member.longitude });
    }
    return jobs;
  }

  coverage() {
    const jobs = this.jobs(), covered = new Set();
    for (const row of this.db.prepare('SELECT zip,store_id,upc,seen_at FROM area_inventory').all()) {
      if (jobs.has(`${row.zip}:${row.upc}`) && this.clock() - row.seen_at <= this.config.monitor.staleAfterMs) {
        covered.add(`${row.store_id}:${row.upc}`);
      }
    }
    return covered;
  }

  storeView(row, preferences, covered) {
    const inventory = this.db.prepare('SELECT * FROM inventory WHERE store_id = ? ORDER BY upc').all(row.id)
      .filter(item => this.products.has(item.upc)).map(item => {
        const stale = !covered.has(`${row.id}:${item.upc}`) || this.clock() - item.observed_at > this.config.monitor.staleAfterMs;
        return { upc: item.upc, title: this.products.get(item.upc).title, quantity: item.quantity,
          status: stale ? 'unknown' : item.status, stale, observedAt: iso(item.observed_at),
          lastIncreaseAt: iso(item.last_increase_at), lastDecreaseAt: iso(item.last_decrease_at) };
      });
    let distance = preferences.center ? milesBetween(preferences.center, row) : null;
    if (distance === null && preferences.zip) distance = this.db.prepare(`SELECT MIN(distance) d FROM area_inventory
      WHERE store_id = ? AND zip = ?`).get(row.id, preferences.zip)?.d ?? null;
    return { id: row.id, retailer: 'dg', name: `Dollar General #${row.id}`, address: row.address,
      city: row.city, state: row.state, postalCode: row.postal_code, phone: row.phone,
      latitude: row.latitude, longitude: row.longitude, coordinateSource: row.coordinate_source,
      distanceMiles: distance, favorite: Boolean(row.favorite), excluded: Boolean(row.excluded),
      privateNote: row.private_note || '', publicNote: row.public_note || '', inventory };
  }

  storeRows(discordId, id = null) {
    return this.db.prepare(`SELECT s.*,p.favorite,p.excluded,p.private_note,n.note public_note FROM stores s
      LEFT JOIN store_preferences p ON p.store_id=s.id AND p.discord_id=?
      LEFT JOIN public_notes n ON n.store_id=s.id WHERE (? IS NULL OR s.id=?) ORDER BY s.id`)
      .all(discordId, id, id);
  }

  stores(discordId, { scope = 'nearby', after = '', limit = '200', favorites = 'false' } = {}) {
    requireCondition(['nearby', 'covered'].includes(scope) && typeof after === 'string' && /^(\d{1,12})?$/.test(after) &&
      Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 250 && ['true', 'false'].includes(favorites),
    400, 'INVALID_INPUT', 'Invalid store scope or cursor.');
    const preferences = this.settings(discordId), covered = this.coverage();
    const rows = this.storeRows(discordId).filter(row => row.id > after && (favorites !== 'true' || row.favorite));
    const selected = [];
    for (const row of rows) {
      const store = this.storeView(row, preferences, covered);
      if (!store.inventory.length) continue;
      if (scope === 'nearby' && (store.distanceMiles === null || store.distanceMiles > 25)) continue;
      selected.push(store);
      if (selected.length > Number(limit)) break;
    }
    const more = selected.length > Number(limit), stores = selected.slice(0, Number(limit));
    return { stores, nextCursor: more ? stores.at(-1).id : null, serverTime: iso(this.clock()) };
  }

  store(discordId, id) {
    const row = this.storeRows(discordId, id)[0];
    requireCondition(row, 404, 'NOT_FOUND', 'Store not found.');
    return this.storeView(row, this.settings(discordId), this.coverage());
  }

  saveStorePreferences(discordId, id, input) {
    requireCondition(this.db.prepare('SELECT 1 FROM stores WHERE id=?').get(id), 404, 'NOT_FOUND', 'Store not found.');
    requireCondition(Object.keys(input).every(k => ['favorite', 'excluded', 'privateNote'].includes(k)) &&
      ['favorite', 'excluded'].every(k => input[k] === undefined || typeof input[k] === 'boolean') &&
      (input.privateNote === undefined || typeof input.privateNote === 'string' && input.privateNote.length <= 2000),
    400, 'INVALID_INPUT', 'Notes must be at most 2,000 characters and store options must be true or false.');
    const old = this.db.prepare('SELECT * FROM store_preferences WHERE discord_id=? AND store_id=?').get(discordId, id);
    this.db.prepare(`INSERT INTO store_preferences (discord_id,store_id,favorite,excluded,private_note,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(discord_id,store_id) DO UPDATE SET favorite=excluded.favorite,
      excluded=excluded.excluded,private_note=excluded.private_note,updated_at=excluded.updated_at`).run(discordId, id,
      Number(input.favorite ?? Boolean(old?.favorite)), Number(input.excluded ?? Boolean(old?.excluded)),
      input.privateNote ?? old?.private_note ?? '', this.clock());
    return this.store(discordId, id);
  }

  savePublicNote(discordId, id, input) {
    requireCondition(this.config.moderatorIds.has(discordId), 403, 'MODERATOR_REQUIRED', 'Only moderators can change public notes.');
    requireCondition(this.db.prepare('SELECT 1 FROM stores WHERE id=?').get(id), 404, 'NOT_FOUND', 'Store not found.');
    requireCondition(Object.keys(input).every(k => k === 'note') && typeof input.note === 'string' && input.note.length <= 2000,
      400, 'INVALID_INPUT', 'Public notes must be at most 2,000 characters.');
    this.db.prepare(`INSERT INTO public_notes (store_id,note,updated_by,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(store_id) DO UPDATE SET note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(id, input.note, discordId, this.clock());
    return this.store(discordId, id);
  }

  history(id, { before = String(Number.MAX_SAFE_INTEGER), limit = '50' } = {}) {
    requireCondition(this.db.prepare('SELECT 1 FROM stores WHERE id=?').get(id), 404, 'NOT_FOUND', 'Store not found.');
    requireCondition(Number.isSafeInteger(Number(before)) && Number(before) > 0 &&
      Number.isInteger(Number(limit)) && Number(limit) > 0 && Number(limit) <= 100,
    400, 'INVALID_INPUT', 'Invalid history cursor.');
    const rows = this.db.prepare(`SELECT * FROM inventory_history WHERE store_id=? AND created_at>? AND id<?
      ORDER BY id DESC LIMIT ?`).all(id, this.clock() - this.config.historyTtlMs, Number(before), Number(limit) + 1);
    const items = rows.slice(0, Number(limit)).map(row => ({ id: row.id, upc: row.upc,
      title: this.products.get(row.upc)?.title || row.upc, previousQuantity: row.previous_quantity, quantity: row.quantity,
      status: row.status, kind: row.kind, createdAt: iso(row.created_at) }));
    return { history: items, nextCursor: rows.length > Number(limit) ? items.at(-1).id : null };
  }

  monitoringStatus() {
    const health = this.db.prepare('SELECT MAX(last_success_at) success FROM monitor_jobs').get();
    const failing = this.db.prepare('SELECT COUNT(*) n FROM monitor_jobs WHERE last_error IS NOT NULL').get().n;
    return { enabled: this.config.monitor.enabled, activeSearches: this.jobs().size,
      lastSuccessAt: iso(health.success), delayedSearches: failing, predictionsAvailable: false, remotePushAvailable: false };
  }
}
