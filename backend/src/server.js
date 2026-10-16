import http from 'node:http';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AppError, requireCondition } from './errors.js';
import { AuthService } from './auth.js';
import { RateLimiter } from './rate-limit.js';
import { loadCatalog } from './catalog.js';
import { createGeography } from './geography.js';
import { AppData } from './app-data.js';
import { eventPayload } from './event-display.js';

const BODY_LIMIT = 16 * 1024;

export function clientIp(req, proxyHops) {
  const direct = req.socket.remoteAddress || 'unknown';
  if (!proxyHops) return direct;
  // Railway documents X-Real-IP as the edge-provided client address. Trust it
  // only for an explicitly configured single trusted proxy; never by default.
  const real = req.headers['x-real-ip'];
  if (proxyHops === 1 && typeof real === 'string' && isIP(real)) return real;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const candidate = chain[chain.length - proxyHops];
  return candidate && isIP(candidate) ? candidate : direct;
}

async function readBody(req) {
  requireCondition(!req.headers['content-encoding'], 415, 'UNSUPPORTED_ENCODING', 'Compressed request bodies are not accepted.');
  const length = Number(req.headers['content-length'] || 0);
  requireCondition(Number.isFinite(length) && length <= BODY_LIMIT, 413, 'BODY_TOO_LARGE', 'Request body is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireCondition(size <= BODY_LIMIT, 413, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!raw.length) return { raw, data: {} };
  requireCondition(req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json',
    415, 'JSON_REQUIRED', 'Use application/json.');
  let data;
  try { data = JSON.parse(raw); } catch { throw new AppError(400, 'INVALID_JSON', 'Invalid JSON body.'); }
  requireCondition(data && typeof data === 'object' && !Array.isArray(data), 400, 'INVALID_JSON', 'Expected a JSON object.');
  return { raw, data };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createServer({ config, db, discord, clock = Date.now, logger = console, catalog = loadCatalog(), geography = createGeography({ db, clock }) }) {
  const auth = new AuthService({ config, db, discord, clock });
  const appData = new AppData({ config, db, catalog, geography, clock });
  const limiter = new RateLimiter(clock);
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      requireCondition(req.url.length <= 4096 && req.url.startsWith('/') && !req.url.startsWith('//'),
        400, 'INVALID_URL', 'Invalid request URL.');
      const url = new URL(req.url, config.publicBaseUrl);
      const method = req.method;
      const route = url.pathname;
      if (method === 'GET' && route === '/health/live') return send(res, 200, { status: 'ok' });
      if (method === 'GET' && route === '/health/ready') {
        db.prepare('SELECT 1').get();
        return send(res, 200, { status: 'ready' });
      }
      const ip = clientIp(req, config.proxyHops);
      limiter.take(`ip:${ip}`, 300, 60_000);
      // Native iOS requests have no Origin. Browser requests must be same-origin.
      requireCondition(!req.headers.origin || req.headers.origin === config.publicBaseUrl,
        403, 'ORIGIN_DENIED', 'This browser origin is not allowed.');
      if (method === 'GET' && route === '/v1/auth/discord/callback') {
        limiter.take('oauth:global', 600, 10 * 60_000);
        const location = await auth.callback({ state: url.searchParams.get('state'), code: url.searchParams.get('code'),
          error: url.searchParams.get('error') });
        res.writeHead(303, { Location: location });
        return res.end();
      }
      const { raw, data } = await readBody(req);
      requireCondition(!['GET', 'HEAD'].includes(method) || raw.length === 0, 400, 'INVALID_BODY', 'GET requests must not have a body.');
      const request = { method, target: req.url, body: raw, proof: {
        timestamp: req.headers['x-takeoff-timestamp'], nonce: req.headers['x-takeoff-nonce'],
        signature: req.headers['x-takeoff-signature'],
      } };
      if (method === 'POST' && route === '/v1/auth/discord/start') {
        limiter.take(`signin:${ip}`, 10, 10 * 60_000);
        limiter.take('signin:global', 200, 10 * 60_000);
        return send(res, 200, auth.begin(data));
      }
      if (method === 'POST' && route === '/v1/auth/exchange') {
        limiter.take(`exchange:${ip}`, 30, 60_000);
        return send(res, 200, auth.exchange(data, request));
      }
      if (method === 'POST' && route === '/v1/auth/refresh') {
        limiter.take(`refresh:${ip}`, 60, 60_000);
        return send(res, 200, auth.refresh(data, request));
      }
      requireCondition(/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization || ''),
        401, 'AUTH_REQUIRED', 'Sign in to Takeoff first.');
      const session = auth.authenticate(req.headers.authorization.slice(7), request);
      limiter.take(`user:${session.discord_id}`, 180, 60_000);
      if (method === 'GET' && route === '/v1/me') {
        return send(res, 200, { discordId: session.discord_id, displayName: session.display_name,
          role: config.moderatorIds.has(session.discord_id) ? 'moderator' : 'member',
          deviceName: session.device_name, nextDeviceTransferAt: new Date(session.next_transfer_at).toISOString(),
          capabilities: { monitoring: config.monitor.enabled, inventory: true, predictions: true, remotePush: false, appAttestRequired: false },
        });
      }
      if (method === 'GET' && route === '/v1/catalog') return send(res, 200, { products: catalog });
      if (method === 'GET' && route === '/v1/settings') return send(res, 200, appData.settings(session.discord_id));
      if (method === 'PUT' && route === '/v1/settings') {
        limiter.take(`settings:${session.discord_id}`, 20, 60_000);
        const result = await appData.saveSettings(session.discord_id, data, () => auth.assertActive(session));
        return send(res, 200, result);
      }
      if (method === 'GET' && route === '/v1/monitor/status') return send(res, 200, appData.monitoringStatus());
      if (method === 'GET' && route === '/v1/travel-estimates/needed') {
        return send(res, 200, { candidates: appData.travelCandidates(session.discord_id) });
      }
      const travelRoute = route.match(/^\/v1\/travel-estimates\/(\d{1,12})$/);
      if (method === 'PUT' && travelRoute) {
        limiter.take(`travel:${session.discord_id}`, 10, 60_000);
        return send(res, 200, appData.saveTravel(session.discord_id, travelRoute[1], data));
      }
      if (method === 'GET' && route === '/v1/stores') {
        requireCondition([...url.searchParams.keys()].every(k => ['scope', 'after', 'limit', 'favorites'].includes(k)),
          400, 'INVALID_INPUT', 'Invalid store filter.');
        return send(res, 200, appData.stores(session.discord_id, Object.fromEntries(url.searchParams)));
      }
      const storeRoute = route.match(/^\/v1\/stores\/(\d{1,12})(?:\/(preferences|public-note|history))?$/);
      if (storeRoute) {
        const [, id, action] = storeRoute;
        if (method === 'GET' && !action) return send(res, 200, appData.store(session.discord_id, id));
        if (method === 'PUT' && action === 'preferences') return send(res, 200, appData.saveStorePreferences(session.discord_id, id, data));
        if (method === 'PUT' && action === 'public-note') return send(res, 200, appData.savePublicNote(session.discord_id, id, data));
        if (method === 'GET' && action === 'history') {
          requireCondition([...url.searchParams.keys()].every(k => ['before', 'limit'].includes(k)), 400, 'INVALID_INPUT', 'Invalid history filter.');
          return send(res, 200, appData.history(id, Object.fromEntries(url.searchParams)));
        }
      }
      if (method === 'POST' && route === '/v1/auth/logout') {
        auth.logout(session);
        return send(res, 200, { signedOut: true });
      }
      if (method === 'GET' && route === '/v1/events') {
        const limit = Number(url.searchParams.get('limit') || 50);
        const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 &&
          Number.isSafeInteger(before) && before > 0 && [...url.searchParams.keys()].every(k => ['limit', 'before'].includes(k)),
        400, 'INVALID_INPUT', 'Use a limit from 1–100 and a positive before cursor.');
        const rows = db.prepare(`SELECT id, kind, payload_json, created_at, read_at FROM events
          WHERE discord_id = ? AND created_at > ? AND id < ? ORDER BY id DESC LIMIT ?`)
          .all(session.discord_id, clock() - config.historyTtlMs, before, limit + 1);
        const more = rows.length > limit;
        const selected = rows.slice(0, limit);
        return send(res, 200, { events: selected.map(row => ({ id: row.id, kind: row.kind,
          payload: eventPayload(db, row), createdAt: new Date(row.created_at).toISOString(),
          readAt: row.read_at === null ? null : new Date(row.read_at).toISOString() })),
        nextCursor: more ? selected.at(-1).id : null });
      }
      const readMatch = route.match(/^\/v1\/events\/([1-9]\d*)\/read$/);
      if (method === 'POST' && readMatch) {
        const eventId = Number(readMatch[1]);
        requireCondition(Number.isSafeInteger(eventId), 400, 'INVALID_INPUT', 'Invalid event ID.');
        const updated = db.prepare(`UPDATE events SET read_at = COALESCE(read_at, ?)
          WHERE id = ? AND discord_id = ? AND created_at > ?`)
          .run(clock(), eventId, session.discord_id, clock() - config.historyTtlMs);
        requireCondition(updated.changes === 1, 404, 'NOT_FOUND', 'Event not found.');
        return send(res, 200, { markedRead: true });
      }
      throw new AppError(404, 'NOT_FOUND', 'Endpoint not found.');
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const known = error instanceof AppError;
      const status = known ? error.status : 500;
      if (!known) logger.error({ requestId, code: 'INTERNAL_ERROR' });
      if (status === 429 && error.details?.retryAfterSeconds) res.setHeader('Retry-After', String(error.details.retryAfterSeconds));
      send(res, status, { error: { code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'Something went wrong. Please try again.',
        ...(known && error.details ? { details: error.details } : {}), requestId } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 500;
  return { server, auth, appData, geography };
}
