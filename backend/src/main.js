import { loadConfig } from './config.js';
import { openDatabase, pruneDatabase } from './database.js';
import { createDiscordClient } from './discord.js';
import { createServer } from './server.js';

process.umask(0o077);
try {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  pruneDatabase(db, Date.now(), config.historyTtlMs);
  const { server } = createServer({ config, db, discord: createDiscordClient(config) });
  const cleanup = setInterval(() => {
    try { pruneDatabase(db, Date.now(), config.historyTtlMs); }
    catch { console.error('Database cleanup failed; inspect storage availability.'); }
  }, 60_000);
  cleanup.unref();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanup);
    server.close(() => {
      db.close();
      process.exitCode = 0;
    });
    server.closeIdleConnections();
    setTimeout(() => { server.closeAllConnections(); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.on('error', () => {
    console.error('Server could not listen. Check HOST and PORT.');
    clearInterval(cleanup);
    db.close();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Takeoff backend foundation listening on port ${config.port}.`);
    if (!config.allowedIds.size) console.log('Discord allowlist is empty: all account access is denied.');
    console.log('Monitoring and remote push are not connected in this milestone.');
  });
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
}
