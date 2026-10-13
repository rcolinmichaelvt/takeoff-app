import fs from 'node:fs';
import { transaction } from './database.js';

export function importCache(db, filename, now = Date.now()) {
  if (fs.statSync(filename).size > 20 * 1024 * 1024) throw new Error('Cache import exceeds the 20 MiB limit.');
  const input = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!input || typeof input !== 'object' || !input.state || Array.isArray(input.state) || typeof input.state !== 'object') {
    throw new Error('Expected a legacy monitor cache containing state.');
  }
  let observations = 0;
  for (const [upc, stores] of Object.entries(input.state)) {
    if (!/^\d{8,14}$/.test(upc) || !stores || Array.isArray(stores) || typeof stores !== 'object') throw new Error('Invalid UPC or stores in cache.');
    for (const [storeId, record] of Object.entries(stores)) {
      if (!/^\d{1,12}$/.test(storeId) || !record || !Number.isFinite(record.qty) || record.qty < 0) throw new Error('Invalid inventory record.');
      observations++;
    }
  }
  // Archive only these fields. Legacy elapsed-time averages are not operating-hours
  // averages and must never silently train the forthcoming business-hours model.
  const snapshot = { lastSaved: input.lastSaved || null, state: input.state,
    legacyTiming: input.timing || null, timingBasis: 'elapsed-clock-time',
    shelfStatus: 'unknown', observationSource: 'legacy-import' };
  transaction(db, () => {
    const existing = db.prepare('SELECT 1 FROM monitor_snapshots WHERE name = ?').get('legacy-dg');
    if (existing) throw new Error('Legacy cache was already imported. Refusing to overwrite it.');
    db.prepare('INSERT INTO monitor_snapshots (name, payload_json, imported_at) VALUES (?, ?, ?)')
      .run('legacy-dg', JSON.stringify(snapshot), now);
  });
  return { products: Object.keys(input.state).length, observations, lastSaved: snapshot.lastSaved };
}
