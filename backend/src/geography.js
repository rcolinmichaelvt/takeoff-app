import { AppError, requireCondition } from './errors.js';

export function validCoordinate(latitude, longitude) {
  return typeof latitude === 'number' && typeof longitude === 'number' &&
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

export function milesBetween(a, b) {
  if (!validCoordinate(a.latitude, a.longitude) || !validCoordinate(b.latitude, b.longitude)) return null;
  const rad = degrees => degrees * Math.PI / 180;
  const dlat = rad(b.latitude - a.latitude), dlon = rad(b.longitude - a.longitude);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dlon / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function createGeography({ db, fetchImpl = fetch, clock = Date.now }) {
  const inFlight = new Map();
  return {
    async resolveZip(zip) {
      requireCondition(typeof zip === 'string' && /^\d{5}$/.test(zip), 400, 'INVALID_ZIP', 'Enter a five-digit US ZIP code.');
      const cached = db.prepare('SELECT * FROM zip_regions WHERE zip = ?').get(zip);
      if (cached) return cached;
      if (inFlight.has(zip)) return inFlight.get(zip);
      const promise = (async () => {
        try {
          const response = await fetchImpl(`https://api.zippopotam.us/us/${zip}`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
          if (response.status === 404) throw new AppError(400, 'ZIP_NOT_FOUND', 'That ZIP code could not be found.');
          if (!response.ok) throw new Error('ZIP service unavailable');
          const body = await response.json(), place = body.places?.[0];
          const latitude = Number(place?.latitude), longitude = Number(place?.longitude);
          if (body['country abbreviation'] !== 'US' || !place || place.latitude == null || place.longitude == null ||
              String(place.latitude).trim() === '' || String(place.longitude).trim() === '' || !validCoordinate(latitude, longitude)) throw new Error('Invalid ZIP response');
          const label = [place['place name'], place['state abbreviation']].filter(v => typeof v === 'string').join(', ').slice(0, 160);
          db.prepare(`INSERT INTO zip_regions (zip,latitude,longitude,label,resolved_at) VALUES (?,?,?,?,?)
            ON CONFLICT(zip) DO NOTHING`).run(zip, latitude, longitude, label || zip, clock());
          return db.prepare('SELECT * FROM zip_regions WHERE zip = ?').get(zip);
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(503, 'ZIP_LOOKUP_UNAVAILABLE', 'ZIP lookup is temporarily unavailable. Please try again.');
        }
      })();
      inFlight.set(zip, promise);
      try { return await promise; } finally { inFlight.delete(zip); }
    },
    async locateStore(store, parentSignal) {
      // Only public store addresses are sent here; never user/device coordinates.
      const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
      url.search = new URLSearchParams({ address: [store.address, store.city, store.state, store.postal_code].filter(Boolean).join(', '),
        benchmark: 'Public_AR_Current', format: 'json' });
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetchImpl(url, { redirect: 'error', signal: parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout });
      if (!response.ok) return null;
      const data = await response.json();
      const matches = data.result?.addressMatches;
      if (!Array.isArray(matches) || matches.length !== 1) return null;
      const { x: longitude, y: latitude } = matches[0].coordinates || {};
      return validCoordinate(latitude, longitude) ? { latitude, longitude } : null;
    },
  };
}
