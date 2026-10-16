export function storeAddress(store) {
  return [store.address, store.city, store.state, store.postalCode ?? store.postal_code].filter(Boolean).join(', ') || 'Address unavailable';
}

// Enrich legacy events on read without altering their original quantities/read state.
export function eventPayload(db, row) {
  const payload = JSON.parse(row.payload_json);
  if (typeof payload.storeId !== 'string') return payload;
  const store = db.prepare('SELECT address,city,state,postal_code FROM stores WHERE id=?').get(payload.storeId);
  const address = payload.address || (store ? storeAddress(store) : 'Address unavailable');
  const body = typeof payload.body === 'string'
    ? payload.body.replace(/^Dollar General #\d+:\s*/, '') : payload.body;
  return { ...payload, address, body };
}
