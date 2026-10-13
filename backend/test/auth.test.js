import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { fixture, device, login, loginChallenge, signedRequest, authenticate, ALICE, BOB, OUTSIDER } from './helpers.js';
import { hash, randomToken, challengeFor } from '../src/crypto.js';

test('Discord identity, PKCE, and a signed installation produce a working session with hashed tokens', async t => {
  const f = fixture(t), dev = device();
  const tokens = await login(f, dev);
  assert.equal(authenticate(f, dev, tokens.accessToken).discord_id, ALICE);
  assert.equal(f.db.prepare('SELECT token_hash FROM access_tokens').get().token_hash, hash(tokens.accessToken));
  assert.equal(f.db.prepare('SELECT token_hash FROM refresh_tokens').get().token_hash, hash(tokens.refreshToken));
  assert.equal(tokens.expiresIn, 900);
});

test('unlisted Discord IDs cannot obtain a login code', async t => {
  const f = fixture(t), dev = device();
  const start = f.auth.begin({ publicKey: dev.publicKey, codeChallenge: challengeFor(randomToken()) });
  const callback = new URL(await f.auth.callback({ state: start.state, code: OUTSIDER }));
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), start.state);
  assert.equal(callback.searchParams.has('login_code'), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM login_codes').get().n, 0);
});

test('OAuth states are one-time, expire, and cannot be invented', async t => {
  const f = fixture(t), dev = device();
  const start = f.auth.begin({ publicKey: dev.publicKey, codeChallenge: challengeFor(randomToken()) });
  await f.auth.callback({ state: start.state, code: ALICE });
  await assert.rejects(f.auth.callback({ state: start.state, code: ALICE }), { code: 'INVALID_OAUTH_STATE' });
  await assert.rejects(f.auth.callback({ state: randomToken(), code: ALICE }), { code: 'INVALID_OAUTH_STATE' });
  const expiring = f.auth.begin({ publicKey: dev.publicKey, codeChallenge: challengeFor(randomToken()) });
  f.advance(f.config.flowTtlMs + 1);
  await assert.rejects(f.auth.callback({ state: expiring.state, code: ALICE }), { code: 'INVALID_OAUTH_STATE' });
});

test('an intercepted callback code needs the original verifier and private key', async t => {
  const f = fixture(t), owner = device(), attacker = device();
  const data = await loginChallenge(f, owner);
  const wrong = { ...data, codeVerifier: randomToken() };
  assert.throws(() => f.auth.exchange(wrong, signedRequest(owner, { method: 'POST', data: wrong, now: f.clock() })), { code: 'INVALID_VERIFIER' });
  assert.throws(() => f.auth.exchange(data, signedRequest(attacker, { method: 'POST', data, now: f.clock() })), { code: 'INVALID_PROOF' });
  const tokens = f.auth.exchange(data, signedRequest(owner, { method: 'POST', data, now: f.clock() }));
  assert.equal(authenticate(f, owner, tokens.accessToken).discord_id, ALICE);
  assert.throws(() => f.auth.exchange(data, signedRequest(owner, { method: 'POST', data, now: f.clock() })), { code: 'INVALID_LOGIN_CODE' });
});

test('a copied access token is unusable with a different installation key', async t => {
  const f = fixture(t), owner = device();
  const tokens = await login(f, owner);
  assert.throws(() => authenticate(f, device(), tokens.accessToken), { code: 'INVALID_PROOF' });
});

test('proofs bind method, URL, body, token and freshness; exact requests cannot be replayed', async t => {
  const f = fixture(t), dev = device();
  const { accessToken } = await login(f, dev);
  const request = signedRequest(dev, { token: accessToken, now: f.clock() });
  for (const modification of [{ method: 'POST' }, { target: '/v1/catalog' }, { body: Buffer.from('{}') }]) {
    assert.throws(() => f.auth.authenticate(accessToken, { ...request, ...modification }), { code: 'INVALID_PROOF' });
  }
  assert.throws(() => f.auth.authenticate(accessToken, signedRequest(dev, { now: f.clock(), token: '' })), { code: 'INVALID_PROOF' });
  f.auth.authenticate(accessToken, request);
  assert.throws(() => f.auth.authenticate(accessToken, request), { code: 'REPLAYED_REQUEST' });
  assert.throws(() => authenticate(f, dev, accessToken, { now: f.clock() - 121_000 }), { code: 'INVALID_PROOF' });
});

test('a new device needs explicit transfer consent; transfer immediately revokes the old session', async t => {
  const f = fixture(t), first = device(), second = device();
  const old = await login(f, first);
  const data = await loginChallenge(f, second);
  assert.throws(() => f.auth.exchange(data, signedRequest(second, { method: 'POST', data, now: f.clock() })), { code: 'DEVICE_TRANSFER_REQUIRED' });
  assert.equal(authenticate(f, first, old.accessToken).discord_id, ALICE);
  const approved = { ...data, transferExistingDevice: true };
  const current = f.auth.exchange(approved, signedRequest(second, { method: 'POST', data: approved, now: f.clock() }));
  assert.equal(current.deviceTransferred, true);
  assert.throws(() => authenticate(f, first, old.accessToken), { code: 'SESSION_REVOKED' });
  const oldRefresh = { refreshToken: old.refreshToken };
  assert.throws(() => f.auth.refresh(oldRefresh, signedRequest(first, { method: 'POST', data: oldRefresh, now: f.clock() })), { code: 'SESSION_REVOKED' });
  assert.equal(authenticate(f, second, current.accessToken).discord_id, ALICE);
});

test('six-hour transfer cooldown survives logout and database restart, and expires at exactly six hours', async t => {
  const f = fixture(t), a = device(), b = device(), c = device();
  await login(f, a);
  const second = await login(f, b, ALICE, true);
  f.auth.logout(authenticate(f, b, second.accessToken));
  f.reopen();
  await assert.rejects(login(f, c, ALICE, true), { code: 'DEVICE_TRANSFER_COOLDOWN' });
  f.advance(f.config.transferCooldownMs - 1);
  await assert.rejects(login(f, a, ALICE, true), { code: 'DEVICE_TRANSFER_COOLDOWN' });
  f.advance(1);
  const third = await login(f, c, ALICE, true);
  assert.equal(authenticate(f, c, third.accessToken).discord_id, ALICE);
});

test('logging back into the same installation does not restart the transfer cooldown', async t => {
  const f = fixture(t), a = device(), b = device();
  await login(f, a);
  await login(f, b, ALICE, true);
  const until = f.db.prepare('SELECT next_transfer_at FROM users').get().next_transfer_at;
  f.advance(60_000);
  await login(f, b);
  assert.equal(f.db.prepare('SELECT next_transfer_at FROM users').get().next_transfer_at, until);
});

test('refresh rotates tokens; replay revokes the family and commits that revocation', async t => {
  const f = fixture(t), dev = device();
  const old = await login(f, dev);
  const data = { refreshToken: old.refreshToken };
  const fresh = f.auth.refresh(data, signedRequest(dev, { method: 'POST', data, now: f.clock() }));
  assert.notEqual(fresh.refreshToken, old.refreshToken);
  assert.equal(authenticate(f, dev, fresh.accessToken).discord_id, ALICE);
  assert.throws(() => f.auth.refresh(data, signedRequest(dev, { method: 'POST', data, now: f.clock() })), { code: 'REFRESH_TOKEN_REUSED' });
  f.reopen();
  assert.throws(() => authenticate(f, dev, fresh.accessToken), { code: 'SESSION_REVOKED' });
});

test('removing a Discord ID blocks existing access and refresh tokens immediately', async t => {
  const f = fixture(t), dev = device();
  const tokens = await login(f, dev);
  f.config.allowedIds.delete(ALICE);
  assert.throws(() => authenticate(f, dev, tokens.accessToken), { code: 'ACCESS_DENIED' });
  const data = { refreshToken: tokens.refreshToken };
  assert.throws(() => f.auth.refresh(data, signedRequest(dev, { method: 'POST', data, now: f.clock() })), { code: 'ACCESS_DENIED' });
});

test('access tokens expire but a valid refresh can renew until the fixed session expiry', async t => {
  const f = fixture(t), dev = device();
  const initial = await login(f, dev);
  f.advance(f.config.accessTtlMs + 1);
  assert.throws(() => authenticate(f, dev, initial.accessToken), { code: 'ACCESS_TOKEN_EXPIRED' });
  const data = { refreshToken: initial.refreshToken };
  const next = f.auth.refresh(data, signedRequest(dev, { method: 'POST', data, now: f.clock() }));
  f.advance(f.config.sessionTtlMs);
  const expired = { refreshToken: next.refreshToken };
  assert.throws(() => f.auth.refresh(expired, signedRequest(dev, { method: 'POST', data: expired, now: f.clock() })), { code: 'SESSION_REVOKED' });
});

test('a key cannot be reassigned to another Discord account', async t => {
  const f = fixture(t), dev = device();
  await login(f, dev);
  await assert.rejects(login(f, dev, BOB), { code: 'KEY_BOUND_TO_ANOTHER_ACCOUNT' });
  assert.equal(f.db.prepare('SELECT discord_id FROM installation_keys').get().discord_id, ALICE);
});

test('private keys and unsupported public key types are rejected', t => {
  const f = fixture(t), dev = device();
  const bad = [dev.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }),
    '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----'];
  for (const publicKey of bad) assert.throws(() => f.auth.begin({ publicKey, codeChallenge: challengeFor(randomToken()) }), { code: 'INVALID_KEY' });
});
