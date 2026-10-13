import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { AuthService } from '../src/auth.js';
import { randomToken, challengeFor, signingMessage } from '../src/crypto.js';

export const ALICE = '123456789012345678';
export const BOB = '223456789012345678';
export const OUTSIDER = '323456789012345678';

export function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}

export function signedRequest(dev, { method = 'GET', target = '/v1/me', data, token = '', now = Date.now(), nonce = randomToken() } = {}) {
  const request = { method, target, body: Buffer.from(data === undefined ? '' : JSON.stringify(data)),
    proof: { timestamp: String(Math.floor(now / 1000)), nonce } };
  request.proof.signature = sign('sha256', Buffer.from(signingMessage({ ...request,
    timestamp: request.proof.timestamp, nonce, token })), dev.privateKey).toString('base64url');
  return request;
}

export function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takeoff-test-'));
  let now = Date.now();
  const config = loadConfig({ DATA_DIR: directory, PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    DISCORD_CLIENT_ID: '423456789012345678', DISCORD_CLIENT_SECRET: 'not-a-real-secret-fixture-only',
    ALLOWED_DISCORD_IDS: `${ALICE},${BOB}`, MODERATOR_DISCORD_IDS: ALICE });
  const discord = {
    authorizationUrl(state) { return `https://discord.com/oauth2/authorize?state=${state}`; },
    async getIdentity(code) { return { id: code, displayName: code === ALICE ? 'Alice' : 'Bob' }; },
  };
  const f = { config, discord, directory, db: openDatabase(directory),
    clock: () => now, advance: ms => { now += ms; } };
  f.auth = new AuthService({ db: f.db, config, discord, clock: f.clock });
  f.reopen = () => {
    f.db.close();
    f.db = openDatabase(directory);
    f.auth = new AuthService({ db: f.db, config, discord, clock: f.clock });
  };
  t.after(() => { f.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return f;
}

export async function loginChallenge(f, dev, identity = ALICE) {
  const codeVerifier = randomToken();
  const start = f.auth.begin({ publicKey: dev.publicKey, codeChallenge: challengeFor(codeVerifier), deviceName: 'Test iPhone' });
  const callback = new URL(await f.auth.callback({ state: start.state, code: identity }));
  return { loginCode: callback.searchParams.get('login_code'), codeVerifier };
}

export async function login(f, dev, identity = ALICE, transferExistingDevice = false) {
  const data = { ...await loginChallenge(f, dev, identity), transferExistingDevice };
  return f.auth.exchange(data, signedRequest(dev, { method: 'POST', target: '/v1/auth/exchange', data, now: f.clock() }));
}

export function authenticate(f, dev, token, overrides = {}) {
  return f.auth.authenticate(token, signedRequest(dev, { now: f.clock(), token, ...overrides }));
}
