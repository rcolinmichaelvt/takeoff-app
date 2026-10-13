import { loadConfig } from './config.js';
import { openDatabase, pruneDatabase } from './database.js';
import { createDiscordClient } from './discord.js';
import { createServer } from './server.js';
import { createMonitor } from './monitor.js';
import { createDGProvider } from './dg-provider.js';

process.umask(0o077);
try {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  pruneDatabase(db, Date.now(), config.historyTtlMs);
  const { server, appData, geography } = createServer({ config, db, discord: createDiscordClient(config) });
  const monitor = createMonitor({ config, db, appData, geography, provider: createDGProvider(config) });
  const cleanup = setInterval(() => {
    try { pruneDatabase(db, Date.now(), config.historyTtlMs); }
    catch { console.error('Database cleanup failed; inspect storage availability.'); }
  }, 60_000);
  cleanup.unref();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanup);
    await monitor.stop();
    server.close(() => {
      db.close();
      process.exitCode = 0;
    });
    server.closeIdleConnections();
    setTimeout(() => { server.closeAllConnections(); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.on('error', async () => {
    console.error('Server could not listen. Check HOST and PORT.');
    clearInterval(cleanup);
    await monitor.stop();
    db.close();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Takeoff API v0.2 listening on port ${config.port}.`);
    if (!config.allowedIds.size) console.log('Discord allowlist is empty: all account access is denied.');
    monitor.start();
    console.log(config.monitor.enabled ? 'DG monitoring enabled for subscribed ZIP/product pairs.' : 'DG monitoring disabled. Configure server credentials and DG_MONITOR_ENABLED when ready.');
    console.log('Predictions and APNs delivery are not enabled in this milestone.');
  });
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
}
