import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, clientIp } from '../src/server.js';
import { fixture, device, login, signedRequest, ALICE, BOB } from './helpers.js';
import { randomToken, challengeFor } from '../src/crypto.js';

async function httpFixture(t) {
  const f = fixture(t);
  const errors = [];
  const { server, appData } = createServer({ ...f, logger: { error: value => errors.push(value) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  f.get = path => fetch(base + path, { redirect: 'manual' });
  f.post = (path, data, headers = {}) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  f.request = (dev, token, target, data, method = data === undefined ? 'GET' : 'POST') => {
    const signed = signedRequest(dev, { method, target, data, token, now: f.clock() });
    return fetch(base + target, { method, redirect: 'manual', headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
      'X-Takeoff-Timestamp': signed.proof.timestamp, 'X-Takeoff-Nonce': signed.proof.nonce,
      'X-Takeoff-Signature': signed.proof.signature,
    }, ...(data === undefined ? {} : { body: signed.body }) });
  };
  return { ...f, base, errors, appData };
}

test('HTTP OAuth round trip returns a bound session and never redirects tokens to the app', async t => {
  const f = await httpFixture(t), dev = device(), verifier = randomToken();
  const startResponse = await f.post('/v1/auth/discord/start', { publicKey: dev.publicKey, codeChallenge: challengeFor(verifier) });
  assert.equal(startResponse.status, 200);
  const start = await startResponse.json();
  const callback = await f.get(`/v1/auth/discord/callback?state=${start.state}&code=${ALICE}`);
  assert.equal(callback.status, 303);
  const redirect = new URL(callback.headers.get('location'));
  assert.equal(redirect.protocol, 'takeoff:');
  assert.equal(redirect.searchParams.has('access_token'), false);
  assert.equal(redirect.searchParams.get('state'), start.state);
  const exchange = await f.request(dev, '', '/v1/auth/exchange', {
    loginCode: redirect.searchParams.get('login_code'), codeVerifier: verifier,
  });
  assert.equal(exchange.status, 200);
  const token = (await exchange.json()).accessToken;
  const me = await f.request(dev, token, '/v1/me');
  assert.equal(me.status, 200);
  const profile = await me.json();
  assert.equal(profile.discordId, ALICE);
  assert.equal(profile.role, 'moderator');
  assert.equal(profile.capabilities.monitoring, false);
  assert.equal(profile.capabilities.remotePush, false);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.equal(me.headers.get('access-control-allow-origin'), null);
  assert.equal(f.errors.length, 0);
});

test('protected data rejects anonymous requests, copied tokens, and wrong browser origins', async t => {
  const f = await httpFixture(t), dev = device(), tokens = await login(f, dev);
  assert.equal((await f.get('/v1/catalog')).status, 401);
  const stolen = await fetch(f.base + '/v1/catalog', { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  assert.equal(stolen.status, 401);
  assert.equal((await f.request(device(), tokens.accessToken, '/v1/catalog')).status, 401);
  assert.equal((await f.post('/v1/auth/discord/start', {}, { Origin: 'https://untrusted.example' })).status, 403);
  const catalog = await f.request(dev, tokens.accessToken, '/v1/catalog');
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).products.length, 11);
});

test('inbox queries and mark-read operations enforce ownership and the seven-day window', async t => {
  const f = await httpFixture(t), a = device(), b = device();
  const alice = await login(f, a), bob = await login(f, b, BOB);
  const add = f.db.prepare('INSERT INTO events (discord_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)');
  const first = Number(add.run(ALICE, 'sold_out', '{"storeId":"100"}', f.clock()).lastInsertRowid);
  add.run(ALICE, 'first_decrease', '{"storeId":"101"}', f.clock());
  const bobs = Number(add.run(BOB, 'sold_out', '{"storeId":"102"}', f.clock()).lastInsertRowid);
  add.run(ALICE, 'expired', '{}', f.clock() - f.config.historyTtlMs - 1);
  const page = await (await f.request(a, alice.accessToken, '/v1/events?limit=1')).json();
  assert.equal(page.events.length, 1);
  assert.notEqual(page.events[0].id, bobs);
  assert.ok(page.nextCursor);
  const next = await (await f.request(a, alice.accessToken, `/v1/events?before=${page.nextCursor}`)).json();
  assert.deepEqual(next.events.map(e => e.id), [first]);
  assert.equal((await f.request(a, alice.accessToken, `/v1/events/${bobs}/read`, {})).status, 404);
  assert.equal((await f.request(b, bob.accessToken, `/v1/events/${first}/read`, {})).status, 404);
  assert.equal((await f.request(a, alice.accessToken, `/v1/events/${first}/read`, {})).status, 200);
  const updated = await (await f.request(a, alice.accessToken, '/v1/events')).json();
  assert.ok(updated.events.find(e => e.id === first).readAt);
  assert.equal((await f.request(a, alice.accessToken, `/v1/events?userId=${BOB}`)).status, 400);
});

test('HTTP logout immediately disables further API requests', async t => {
  const f = await httpFixture(t), dev = device(), tokens = await login(f, dev);
  assert.equal((await f.request(dev, tokens.accessToken, '/v1/auth/logout', {})).status, 200);
  assert.equal((await f.request(dev, tokens.accessToken, '/v1/me')).status, 401);
});

test('invalid JSON and oversized payloads are bounded and errors do not expose internals', async t => {
  const f = await httpFixture(t);
  const malformed = await fetch(f.base + '/v1/auth/discord/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid',
  });
  assert.equal(malformed.status, 400);
  const error = await malformed.json();
  assert.equal(error.error.code, 'INVALID_JSON');
  assert.equal(Object.hasOwn(error, 'stack'), false);
  const large = await f.post('/v1/auth/discord/start', { padding: 'x'.repeat(20 * 1024) });
  assert.equal(large.status, 413);
});

test('rate-limited sign-in returns Retry-After and ignores spoofed forwarding headers by default', async t => {
  const f = await httpFixture(t), dev = device();
  const body = { publicKey: dev.publicKey, codeChallenge: challengeFor(randomToken()) };
  for (let i = 0; i < 10; i++) assert.equal((await f.post('/v1/auth/discord/start', body,
    { 'X-Forwarded-For': `192.0.2.${i + 1}` })).status, 200);
  const limited = await f.post('/v1/auth/discord/start', body, { 'X-Forwarded-For': '203.0.113.99' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': 'spoofed, 192.0.2.3' } }, 1), '192.0.2.3');
  const edge = { socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-real-ip': '192.0.2.4', 'x-forwarded-for': '203.0.113.99' } };
  assert.equal(clientIp(edge, 0), '127.0.0.1');
  assert.equal(clientIp(edge, 1), '192.0.2.4');
});

test('iPhone API settings, notes, history, and store filters retain authorization over HTTP', async t => {
  const f = await httpFixture(t), a = device(), b = device();
  const alice = await login(f, a), bob = await login(f, b, BOB);
  f.db.prepare('INSERT INTO zip_regions (zip,latitude,longitude,label,resolved_at) VALUES (?,?,?,?,?)')
    .run('24060', 37.23, -80.42, 'Blacksburg, VA', f.clock());
  const request = (path, data, who = 'alice') => f.request(who === 'alice' ? a : b,
    who === 'alice' ? alice.accessToken : bob.accessToken, path, data, data === undefined ? 'GET' : 'PUT');
  const settings = await request('/v1/settings', { zip: '24060', products: ['196214158801'] });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).center.latitude, 37.23);
  assert.equal((await request('/v1/settings', { zip: '24060', products: ['bad'] })).status, 400);
  assert.equal((await (await request('/v1/settings', undefined, 'bob')).json()).zip, null);
  const { Inventory } = await import('../src/inventory.js');
  const inventory = new Inventory(f);
  inventory.ingest(f.appData.jobs().values().next().value, [{ id: '100', quantity: 2, address: 'Test Street',
    city: 'Blacksburg', state: 'VA', latitude: 37.23, longitude: -80.42, distance: 1 }]);
  assert.equal((await request('/v1/stores/100/preferences', { privateNote: 'Private!', favorite: true })).status, 200);
  const other = await (await request('/v1/stores/100', undefined, 'bob')).json();
  assert.equal(other.privateNote, ''); assert.equal(other.favorite, false);
  assert.equal(other.inventory[0].status, 'unknown');
  assert.equal((await request('/v1/stores/100/public-note', { note: 'No' }, 'bob')).status, 403);
  assert.equal((await request('/v1/stores/100/public-note', { note: 'Limit one' })).status, 200);
  assert.equal((await (await request('/v1/stores/100', undefined, 'bob')).json()).publicNote, 'Limit one');
  const favorites = await (await request('/v1/stores?scope=covered&favorites=true')).json();
  assert.deepEqual(favorites.stores.map(s => s.id), ['100']);
  assert.equal((await (await request('/v1/stores?scope=covered&favorites=true', undefined, 'bob')).json()).stores.length, 0);
  const history = await (await request('/v1/stores/100/history')).json();
  assert.equal(history.history[0].kind, 'baseline');
  assert.equal((await request('/v1/stores?userId=123')).status, 400);
  assert.equal((await f.get('/v1/settings')).status, 401);
  assert.equal(f.errors.length, 0);
});
