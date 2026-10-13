import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { importCache } from '../src/import-cache.js';

process.umask(0o077);
const filename = process.argv[2];
if (!filename) {
  console.error('Usage: npm run import-cache -- /path/to/current/dg-stock-cache.json');
  process.exitCode = 1;
} else {
  let db;
  try {
    const directory = path.resolve(process.env.DATA_DIR || './data');
    db = openDatabase(directory);
    const result = importCache(db, filename);
    console.log(JSON.stringify({ imported: true, ...result }));
    console.log('Archived for migration. Legacy elapsed-time averages will not be used as opening-hours predictions.');
  } catch (error) {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  } finally { db?.close(); }
}
