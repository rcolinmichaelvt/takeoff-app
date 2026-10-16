import { Inventory } from './inventory.js';
import { milesBetween } from './geography.js';

export function createMonitor({ db, config, appData, provider, geography, clock = Date.now, logger = console }) {
  const inventory = new Inventory({ db, config, appData, clock });
  const controller = new AbortController();
  let timer, running, geocodeTimer, geocoding, stopped = false, started = false, pauseUntil = 0, geocodeAfter = 0;
  let predictionTimer, requestAfter = 0;
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
  const predictionTick = () => {
    if (!stopped) { appData.intelligence.sweep(appData); appData.trips.sweep(); }
  };
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
  return { tick, geocodeTick, predictionTick, reconcile, inventory,
    start() {
      if (config.monitor.enabled && !started && !stopped) {
        started = true;
        timer = setTimeout(loop, 0); timer.unref();
        if (config.monitor.geocodeStores) { geocodeTimer = setTimeout(geocodeLoop, 0); geocodeTimer.unref(); }
        predictionTimer = setInterval(() => {
          try { predictionTick(); } catch { logger.warn({ code: 'PREDICTION_TICK_FAILED' }); }
        }, 15_000); predictionTimer.unref();
      }
    },
    async stop() {
      stopped = true; clearTimeout(timer); clearTimeout(geocodeTimer); clearInterval(predictionTimer);
      controller.abort(); provider.close?.();
      await Promise.allSettled([running, geocoding].filter(Boolean));
    },
  };
}
