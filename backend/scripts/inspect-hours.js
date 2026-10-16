import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { scheduleView, HOURS_MAX_AGE } from '../src/hours.js';

// Read-only: inspect the hours captured by the existing inventory poll. No
// additional DG request, credentials, private notes, or account records.
const id = process.argv[2];
if (!/^\d{1,12}$/.test(id || '')) { console.error('Usage: npm run inspect-hours -- STORE_NUMBER'); process.exitCode = 1; }
else {
  let db;
  try {
    const config = loadConfig();
    db = new DatabaseSync(path.join(config.dataDir, 'takeoff.sqlite'), { readOnly: true });
    const store = db.prepare('SELECT latitude,longitude FROM stores WHERE id=?').get(id);
    const hours = db.prepare('SELECT schedule_json,updated_at,last_error FROM store_hours WHERE store_id=?').get(id);
    const schedule = hours?.schedule_json ? JSON.parse(hours.schedule_json) : null;
    console.log(JSON.stringify({ storeId: id, source: 'monitored_inventory',
      coordinatesAvailable: store?.latitude != null && store?.longitude != null,
      status: !hours ? 'waiting_for_inventory_hours' : !schedule ? 'unrecognized' : (hours.updated_at > Date.now() || Date.now() - hours.updated_at > HOURS_MAX_AGE) ? 'stale' : 'ready',
      lastError: hours?.last_error ?? null, hours: schedule ? scheduleView(schedule, hours.updated_at) : null }, null, 2));
  } catch (error) { console.error(error.code || 'Store hours diagnostic failed. Check this service’s configuration.'); process.exitCode = 1; }
  finally { db?.close(); }
}
