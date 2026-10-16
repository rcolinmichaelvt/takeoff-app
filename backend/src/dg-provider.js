import { validCoordinate } from './geography.js';
import { inventoryHoursFields } from './hours.js';

export class ProviderError extends Error {
  constructor(code, retryMs = 60_000) { super(code); this.code = code; this.retryMs = retryMs; }
}
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const number = value => {
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function normalizeStores(data) {
  if (!data || !Array.isArray(data.stores) || data.stores.length > 2000) throw new ProviderError('DG_INVALID_RESPONSE');
  const seen = new Set();
  return data.stores.map(raw => {
    if (!raw || typeof raw !== 'object') throw new ProviderError('DG_INVALID_RESPONSE');
    const id = String(raw.storeNumber ?? ''), quantity = number(raw.productQTY);
    if (!/^\d{1,12}$/.test(id) || !Number.isSafeInteger(quantity) || quantity < 0 || seen.has(id)) {
      throw new ProviderError('DG_INVALID_RESPONSE');
    }
    seen.add(id);
    const lat = number(raw.latitude ?? raw.lat ?? raw.location?.latitude);
    const lon = number(raw.longitude ?? raw.lng ?? raw.lon ?? raw.location?.longitude);
    const coordinates = validCoordinate(lat, lon);
    const distance = number(raw.distance);
    return { id, quantity, address: text(raw.address), city: text(raw.city, 100), state: text(raw.state, 50),
      postalCode: text(String(raw.zipCode ?? raw.postalCode ?? raw.zip ?? ''), 12), phone: text(raw.phoneNumber, 40),
      latitude: coordinates ? lat : null, longitude: coordinates ? lon : null,
      distance: Number.isFinite(distance) && distance >= 0 ? distance : null,
      ...(inventoryHoursFields.some(key => Object.hasOwn(raw, key)) ? { hoursInfo: Object.fromEntries(
        [...inventoryHoursFields, 'timeZone', 'timezone', 'timeZoneId', 'specialHours', 'holidayHours', 'specialOpeningHoursSpecification']
          .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])) } : {}) };
  });
}

function retryDelay(response) {
  const header = response.headers.get('retry-after');
  if (!header) return 60_000;
  const seconds = Number(header), date = Date.parse(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now();
  return Number.isFinite(delay) ? Math.max(1000, delay) : 60_000;
}

export function createDGProvider(config, fetchImpl = fetch) {
  const c = { ...config.monitor.credentials }, controller = new AbortController();
  let refreshing;
  const headers = () => ({ accept: 'application/json, text/plain, */*', authorization: c.DG_AUTHORIZATION,
    'x-dg-appsessiontoken': c.DG_APP_SESSION_TOKEN, 'x-dg-apptoken': c.DG_APP_TOKEN,
    'x-dg-customerguid': c.DG_CUSTOMER_GUID, 'x-dg-deviceuniqueid': c.DG_DEVICE_UNIQUE_ID,
    'x-dg-partnerapitoken': c.DG_PARTNER_API_TOKEN, 'x-dg-cloud-service': 'true',
    'accept-language': 'en-US,en;q=0.9', Referer: 'https://www.dollargeneral.com/' });
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]);
  const refresh = () => refreshing ||= (async () => {
    try {
      const response = await fetchImpl('https://www.dollargeneral.com/bin/dg/user?refreshCookies=true', {
        method: 'GET', redirect: 'error', signal: signal(), headers: { ...headers(), cookie: c.DG_COOKIE } });
      if (response.status === 429) throw new ProviderError('DG_RATE_LIMITED', retryDelay(response));
      if (!response.ok) throw new ProviderError('DG_AUTH_REQUIRED', 5 * 60_000);
      const data = await response.json();
      if (!data || typeof data.idToken !== 'string' || !data.idToken) throw new ProviderError('DG_AUTH_REQUIRED', 5 * 60_000);
      c.DG_AUTHORIZATION = `Bearer ${data.idToken}`;
      for (const [source, key] of Object.entries({ appSessionToken: 'DG_APP_SESSION_TOKEN', appToken: 'DG_APP_TOKEN',
        customerGuid: 'DG_CUSTOMER_GUID', uniqueDeviceId: 'DG_DEVICE_UNIQUE_ID', partnerApiToken: 'DG_PARTNER_API_TOKEN' })) {
        if (typeof data[source] === 'string' && data[source]) c[key] = data[source];
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('DG_AUTH_REQUIRED', 5 * 60_000);
    }
  })().finally(() => { refreshing = undefined; });
  const requestJSON = async (url, options = {}) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
          response = await fetchImpl(url, { ...options, redirect: 'error', signal: signal(),
            headers: { ...headers(), ...options.headers } });
        } catch { throw new ProviderError('DG_UNAVAILABLE'); }
        if (response.status === 429) throw new ProviderError('DG_RATE_LIMITED', retryDelay(response));
        if ([401, 403].includes(response.status)) {
          if (attempt === 0) { await refresh(); continue; }
          throw new ProviderError('DG_AUTH_REQUIRED', 5 * 60_000);
        }
        if (!response.ok) throw new ProviderError('DG_UNAVAILABLE');
        let data;
        try { data = await response.json(); }
        catch {
          if (attempt === 0) { await refresh(); continue; }
          throw new ProviderError('DG_INVALID_RESPONSE');
        }
        return data;
      }
      throw new ProviderError('DG_UNAVAILABLE');
  };
  return {
    close() { controller.abort(); },
    async fetchInventory(region, upc) {
      return normalizeStores(await requestJSON('https://dggo.dollargeneral.com/omni/api/store/search/inventory', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ latitude: String(region.latitude), longitude: String(region.longitude), radius: '25', upc, offerSourceType: '0' }),
      }));
    },
  };
}
