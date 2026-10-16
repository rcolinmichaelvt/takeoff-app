import { Inventory } from './inventory.js';
import { milesBetween } from './geography.js';
import { DAY, normalizeHours } from './hours.js';

export function createMonitor({ db, config, appData, provider, geography, clock = Date.now, logger = console }) {
  const inventory = new Inventory({ db, config, appData, clock });
  const controller = new AbortController();
  let timer, running, geocodeTimer, geocoding, stopped = false, started = false, pauseUntil = 0, geocodeAfter = 0;
  let hoursTimer, hoursRunning, predictionTimer, requestAfter = 0;
  const reconcile = () => {
    const active = appData.jobs();
    const add = db.prepare('INSERT INTO monitor_jobs (zip,upc,next_poll_at) VALUES (?,?,?) ON CONFLICT(zip,upc) DO NOTHING');
    for (const job of active.values()) add.run(job.zip, job.upc, clock());
    for (const job of db.prepare('SELECT zip,upc FROM monitor_jobs').all()) {
      if (!active.has(`${job.zip}:${job.upc}`)) db.prepare('DELETE FROM monitor_jobs WHERE zip=? AND upc=?').run(job.zip, job.upc);
    }
    return active;
  };
  const tick = async () => {
    if (!config.monitor.enabled || stopped) return;
    const active = reconcile();
    if (clock() < Math.max(pauseUntil, requestAfter) || !active.size) return;
    const due = db.prepare('SELECT * FROM monitor_jobs WHERE next_poll_at<=? ORDER BY next_poll_at,zip,upc LIMIT 1').get(clock());
    if (due) {
      requestAfter = clock() + config.monitor.minRequestGapMs;
      const job = active.get(`${due.zip}:${due.upc}`);
      try {
        const stores = await provider.fetchInventory(job, job.upc);
        if (stopped) return;
        inventory.ingest(job, stores);
        const fast = db.prepare(`SELECT 1 FROM area_inventory a JOIN inventory i ON i.store_id=a.store_id AND i.upc=a.upc
          WHERE a.zip=? AND a.upc=? AND i.quantity>0 AND i.last_increase_at>? LIMIT 1`)
          .get(job.zip, job.upc, clock() - config.monitor.fastWindowMs);
        const interval = fast ? config.monitor.fastIntervalMs : config.monitor.normalIntervalMs;
        db.prepare(`UPDATE monitor_jobs SET next_poll_at=?,last_success_at=?,last_error=NULL,failures=0 WHERE zip=? AND upc=?`)
          .run(clock() + interval, clock(), job.zip, job.upc);
      } catch (error) {
        if (stopped) return;
        const code = ['DG_RATE_LIMITED', 'DG_AUTH_REQUIRED', 'DG_INVALID_RESPONSE', 'DG_UNAVAILABLE'].includes(error.code) ? error.code : 'DG_UNAVAILABLE';
        const delay = Math.max(error.retryMs || 60_000, Math.min(15 * 60_000, 30_000 * 2 ** Math.min(due.failures, 5)));
        pauseUntil = clock() + delay; // Account-wide backoff, not one retry per ZIP.
        db.prepare('UPDATE monitor_jobs SET next_poll_at=?,last_error=?,failures=failures+1 WHERE zip=? AND upc=?')
          .run(pauseUntil, code, job.zip, job.upc);
        logger.warn({ code, retrySeconds: Math.ceil(delay / 1000) });
      }
    }
  };
  const hoursTick = async () => {
    if (stopped || !config.monitor.enabled || !provider.fetchStoreInfo || clock() < Math.max(pauseUntil, requestAfter)) return;
    const active = appData.jobs();
    const store = db.prepare(`SELECT s.* FROM stores s LEFT JOIN store_hours h ON h.store_id=s.id
      WHERE COALESCE(h.next_fetch_at,0)<=? ORDER BY COALESCE(h.next_fetch_at,0),s.id`).all(clock()).find(row =>
      db.prepare('SELECT zip,upc FROM area_inventory WHERE store_id=?').all(row.id).some(a => active.has(`${a.zip}:${a.upc}`)));
    if (!store) return;
    requestAfter = clock() + config.monitor.minRequestGapMs;
    db.prepare(`INSERT INTO store_hours (store_id,next_fetch_at) VALUES (?,?) ON CONFLICT(store_id)
      DO UPDATE SET next_fetch_at=excluded.next_fetch_at`).run(store.id, clock() + 6 * 60 * 60_000);
    try {
      const info = await provider.fetchStoreInfo(store.id);
      if (stopped) return;
      const stillActive = appData.jobs();
      if (!db.prepare('SELECT zip,upc FROM area_inventory WHERE store_id=?').all(store.id).some(a => stillActive.has(`${a.zip}:${a.upc}`))) return;
      const location = db.prepare('SELECT latitude,longitude FROM stores WHERE id=?').get(store.id);
      const schedule = normalizeHours(info, location);
      db.prepare('UPDATE store_hours SET schedule_json=?,updated_at=?,last_error=?,next_fetch_at=? WHERE store_id=?')
        .run(schedule ? JSON.stringify(schedule) : null, schedule ? clock() : null,
          schedule ? null : 'STORE_HOURS_UNRECOGNIZED', clock() + (schedule ? DAY : 6 * 60 * 60_000), store.id);
      if (!schedule) logger.warn({ code: 'STORE_HOURS_UNRECOGNIZED', storeId: store.id });
    } catch (error) {
      const code = ['DG_RATE_LIMITED', 'DG_AUTH_REQUIRED'].includes(error.code) ? error.code : 'STORE_HOURS_UNAVAILABLE';
      db.prepare('UPDATE store_hours SET last_error=? WHERE store_id=?').run(code, store.id);
      if (code === 'DG_RATE_LIMITED' || code === 'DG_AUTH_REQUIRED') pauseUntil = Math.max(pauseUntil, clock() + (error.retryMs || 60_000));
      logger.warn({ code, storeId: store.id });
    }
  };
  const predictionTick = () => { if (!stopped) appData.intelligence.sweep(appData); };
  const geocodeTick = async () => {
    if (!config.monitor.enabled || stopped || !config.monitor.geocodeStores || clock() < geocodeAfter) return;
    const active = appData.jobs();
    if (active.size) {
      const store = db.prepare(`SELECT s.* FROM stores s WHERE s.latitude IS NULL AND s.address<>'' AND s.city<>'' AND s.state<>''
        AND s.geocode_after<=? ORDER BY s.geocode_after,s.updated_at DESC`).all(clock()).find(candidate =>
        db.prepare('SELECT zip,upc FROM area_inventory WHERE store_id=?').all(candidate.id)
          .some(area => active.has(`${area.zip}:${area.upc}`)));
      if (store) {
        geocodeAfter = clock() + 10_000;
        db.prepare('UPDATE stores SET geocode_after=? WHERE id=?').run(clock() + 24 * 60 * 60_000, store.id);
        try {
          const coordinates = await geography.locateStore(store, controller.signal);
          if (stopped || !coordinates) return;
          const regions = db.prepare(`SELECT DISTINCT z.*,a.upc FROM area_inventory a JOIN zip_regions z ON z.zip=a.zip WHERE a.store_id=?`)
            .all(store.id).filter(region => appData.jobs().has(`${region.zip}:${region.upc}`));
          // Reject a geocoder match outside every region that returned this store.
          if (regions.some(region => milesBetween(region, coordinates) <= 25)) {
            db.prepare(`UPDATE stores SET latitude=?,longitude=?,coordinate_source='census' WHERE id=? AND latitude IS NULL`)
              .run(coordinates.latitude, coordinates.longitude, store.id);
          }
        } catch { /* A missing map coordinate never changes a stock observation. */ }
      }
    }
  };
  const loop = async () => {
    if (stopped) return;
    running = tick();
    try { await running; } catch { logger.warn({ code: 'MONITOR_TICK_FAILED' }); }
    finally { running = undefined; }
    if (!stopped) { timer = setTimeout(loop, config.monitor.minRequestGapMs); timer.unref(); }
  };
  const geocodeLoop = async () => {
    if (stopped) return;
    geocoding = geocodeTick();
    try { await geocoding; } catch { logger.warn({ code: 'STORE_GEOCODING_FAILED' }); }
    finally { geocoding = undefined; }
    if (!stopped) { geocodeTimer = setTimeout(geocodeLoop, 10_000); geocodeTimer.unref(); }
  };
  const hoursLoop = async () => {
    if (stopped) return;
    hoursRunning = hoursTick();
    try { await hoursRunning; } catch { logger.warn({ code: 'STORE_HOURS_TICK_FAILED' }); }
    finally { hoursRunning = undefined; }
    if (!stopped) { hoursTimer = setTimeout(hoursLoop, 15_000); hoursTimer.unref(); }
  };
  return { tick, geocodeTick, hoursTick, predictionTick, reconcile, inventory,
    start() {
      if (config.monitor.enabled && !started && !stopped) {
        started = true;
        timer = setTimeout(loop, 0); timer.unref();
        if (config.monitor.geocodeStores) { geocodeTimer = setTimeout(geocodeLoop, 0); geocodeTimer.unref(); }
        hoursTimer = setTimeout(hoursLoop, 2000); hoursTimer.unref();
        predictionTimer = setInterval(() => {
          try { predictionTick(); } catch { logger.warn({ code: 'PREDICTION_TICK_FAILED' }); }
        }, 15_000); predictionTimer.unref();
      }
    },
    async stop() {
      stopped = true; clearTimeout(timer); clearTimeout(geocodeTimer); clearTimeout(hoursTimer); clearInterval(predictionTimer);
      controller.abort(); provider.close?.();
      await Promise.allSettled([running, geocoding, hoursRunning].filter(Boolean));
    },
  };
}
