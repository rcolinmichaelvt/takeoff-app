import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { createDGProvider } from '../src/dg-provider.js';
import { normalizeHours } from '../src/hours.js';

// Read-only diagnostic. Never print credentials, headers, full provider responses,
// or user records. The output is limited to public store hours and field names.
const id = process.argv[2];
if (!/^\d{1,12}$/.test(id || '')) { console.error('Usage: npm run inspect-hours -- STORE_NUMBER'); process.exitCode = 1; }
else {
  let provider, db;
  try {
    const config = loadConfig();
    provider = createDGProvider(config);
    const info = await provider.fetchStoreInfo(id);
    db = new DatabaseSync(path.join(config.dataDir, 'takeoff.sqlite'), { readOnly: true });
    const store = db.prepare('SELECT latitude,longitude FROM stores WHERE id=?').get(id) || {};
    const safe = (value, depth = 0) => {
      if (depth > 5) return '[nested]';
      if (typeof value === 'string') return value.slice(0, 400);
      if (Array.isArray(value)) return value.slice(0, 40).map(v => safe(v, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/token|secret|cookie|authorization|customer|guid|user/i.test(key)).slice(0, 40)
        .map(([key, v]) => [key, safe(v, depth + 1)]));
      return value;
    };
    const hoursFields = Object.fromEntries(Object.entries(info)
      .filter(([key]) => /hours|opening|closing|timezone|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(key))
      .map(([key, value]) => [key, safe(value)]));
    console.log(JSON.stringify({ storeId: id, fields: Object.keys(info), hoursFields,
      coordinatesAvailable: store.latitude != null && store.longitude != null, normalized: normalizeHours(info, store) }, null, 2));
  } catch (error) { console.error(error.code || 'Store hours diagnostic failed. Check this service’s configuration.'); process.exitCode = 1; }
  finally { provider?.close(); db?.close(); }
}
