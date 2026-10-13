import { randomUUID } from 'node:crypto';
import { hash, randomToken, challengeFor, checkToken, normalizePublicKey, verifyProof } from './crypto.js';
import { AppError, requireCondition } from './errors.js';
import { transaction } from './database.js';

export class AuthService {
  constructor({ db, config, discord, clock = Date.now }) {
    Object.assign(this, { db, config, discord, clock });
  }

  assertAllowed(discordId) {
    requireCondition(this.config.allowedIds.has(discordId), 403, 'ACCESS_DENIED',
      'This Discord account does not currently have access to Takeoff.');
  }

  begin({ publicKey, codeChallenge, deviceName = 'iPhone' }) {
    const now = this.clock();
    const key = normalizePublicKey(publicKey);
    checkToken(codeChallenge, 'S256 code challenge');
    requireCondition(typeof deviceName === 'string' && deviceName.trim().length >= 1 &&
      deviceName.length <= 60 && !/[\x00-\x1f\x7f]/.test(deviceName),
    400, 'INVALID_INPUT', 'Device name must contain 1–60 printable characters.');
    requireCondition(this.db.prepare('SELECT COUNT(*) AS n FROM oauth_flows WHERE expires_at > ?')
      .get(now).n < 1000, 429, 'AUTH_BUSY', 'Too many sign-in attempts. Please try again shortly.');
    const state = randomToken();
    this.db.prepare(`INSERT INTO oauth_flows
      (state_hash, key_id, public_key, device_name, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(hash(state), key.id, key.pem, deviceName.trim(), codeChallenge, now + this.config.flowTtlMs);
    return { authorizationUrl: this.discord.authorizationUrl(state), state, keyId: key.id, expiresIn: this.config.flowTtlMs / 1000 };
  }

  async callback({ state, code, error }) {
    checkToken(state, 'OAuth state');
    const now = this.clock();
    const flow = transaction(this.db, () => {
      const result = this.db.prepare('SELECT * FROM oauth_flows WHERE state_hash = ?').get(hash(state));
      requireCondition(result && result.expires_at > now, 400, 'INVALID_OAUTH_STATE',
        'This sign-in request is invalid or expired. Start sign-in again.');
      this.db.prepare('DELETE FROM oauth_flows WHERE state_hash = ?').run(hash(state));
      return result;
    });
    const destination = new URL(this.config.appCallbackUrl);
    destination.searchParams.set('state', state);
    if (error) {
      destination.searchParams.set('error', 'access_denied');
      return destination.href;
    }
    requireCondition(typeof code === 'string' && code.length > 0 && code.length <= 2000,
      400, 'INVALID_INPUT', 'Discord did not return an authorization code.');
    let identity;
    try {
      identity = await this.discord.getIdentity(code);
      this.assertAllowed(identity.id);
    } catch (error) {
      // Return to ASWebAuthenticationSession on expected failures. Only a valid,
      // consumed state can reach this branch; never forward upstream error text.
      if (!['ACCESS_DENIED', 'DISCORD_UNAVAILABLE'].includes(error.code)) throw error;
      destination.searchParams.set('error', error.code === 'ACCESS_DENIED' ? 'access_denied' : 'discord_unavailable');
      return destination.href;
    }
    // The browser sees only a short-lived single-use code. It cannot exchange it
    // without BOTH the original app verifier and the installation private key.
    const loginCode = randomToken();
    this.db.prepare(`INSERT INTO login_codes
      (code_hash, discord_id, display_name, key_id, public_key, device_name, code_challenge, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(loginCode), identity.id, identity.displayName, flow.key_id, flow.public_key,
        flow.device_name, flow.code_challenge, this.clock() + this.config.loginCodeTtlMs);
    destination.searchParams.set('login_code', loginCode);
    return destination.href;
  }

  consumeProof(keyId, publicKey, request, token = '') {
    const now = this.clock();
    const nonce = verifyProof({ publicKey, request, token, now, windowMs: this.config.proofWindowMs });
    // Expiry must outlast the complete validity of even a future-dated request.
    const expires = Number(request.proof.timestamp) * 1000 + this.config.proofWindowMs + 1000;
    const result = this.db.prepare(`INSERT INTO request_nonces (key_id, nonce, expires_at)
      VALUES (?, ?, ?) ON CONFLICT(key_id, nonce) DO NOTHING`).run(keyId, nonce, expires);
    requireCondition(result.changes === 1, 401, 'REPLAYED_REQUEST', 'This signed request was already used.');
  }

  createTokens(session, now) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpires = Math.min(now + this.config.accessTtlMs, session.expires_at);
    this.db.prepare('INSERT INTO access_tokens (token_hash, session_id, expires_at) VALUES (?, ?, ?)')
      .run(hash(accessToken), session.id, accessExpires);
    this.db.prepare('INSERT INTO refresh_tokens (token_hash, session_id, consumed_at) VALUES (?, ?, NULL)')
      .run(hash(refreshToken), session.id);
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: Math.floor((accessExpires - now) / 1000),
      sessionExpiresAt: new Date(session.expires_at).toISOString(), serverTime: new Date(now).toISOString() };
  }

  exchange({ loginCode, codeVerifier, transferExistingDevice = false }, request) {
    checkToken(loginCode, 'login code');
    requireCondition(typeof codeVerifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) &&
      typeof transferExistingDevice === 'boolean', 400, 'INVALID_INPUT', 'Invalid verifier or transfer choice.');
    const now = this.clock();
    const login = this.db.prepare('SELECT * FROM login_codes WHERE code_hash = ?').get(hash(loginCode));
    requireCondition(login && login.expires_at > now, 401, 'INVALID_LOGIN_CODE', 'The login code is invalid or expired.');
    requireCondition(challengeFor(codeVerifier) === login.code_challenge, 401, 'INVALID_VERIFIER',
      'The login verifier does not match the original sign-in request.');
    this.assertAllowed(login.discord_id);
    this.consumeProof(login.key_id, login.public_key, request);

    return transaction(this.db, () => {
      const user = this.db.prepare('SELECT * FROM users WHERE discord_id = ?').get(login.discord_id);
      const transferring = Boolean(user?.active_key_id && user.active_key_id !== login.key_id);
      if (transferring) {
        const remaining = Math.max(0, Math.ceil((user.next_transfer_at - now) / 1000));
        requireCondition(transferExistingDevice, 409, 'DEVICE_TRANSFER_REQUIRED',
          'Move access to this iPhone? The previous device will lose access immediately.',
          { retryAfterSeconds: remaining });
        requireCondition(remaining === 0, 429, 'DEVICE_TRANSFER_COOLDOWN',
          'Device transfers are limited to once every six hours.', { retryAfterSeconds: remaining });
      }
      const existingKey = this.db.prepare('SELECT discord_id FROM installation_keys WHERE key_id = ?').get(login.key_id);
      requireCondition(!existingKey || existingKey.discord_id === login.discord_id,
        409, 'KEY_BOUND_TO_ANOTHER_ACCOUNT', 'Use a new installation key when switching Discord accounts.');
      this.db.prepare(`INSERT INTO users (discord_id, display_name, active_key_id, next_transfer_at, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET
        display_name = excluded.display_name, active_key_id = excluded.active_key_id, updated_at = excluded.updated_at`)
        .run(login.discord_id, login.display_name, login.key_id, now, now);
      if (transferring) this.db.prepare('UPDATE users SET next_transfer_at = ? WHERE discord_id = ?')
        .run(now + this.config.transferCooldownMs, login.discord_id);
      this.db.prepare(`INSERT INTO installation_keys (key_id, discord_id, public_key, device_name, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_id) DO UPDATE SET device_name = excluded.device_name`)
        .run(login.key_id, login.discord_id, login.public_key, login.device_name, now);
      // Even a repeat login on the same installation replaces previous sessions.
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE discord_id = ? AND revoked_at IS NULL')
        .run(now, login.discord_id);
      const session = { id: randomUUID(), expires_at: now + this.config.sessionTtlMs };
      this.db.prepare(`INSERT INTO sessions (id, discord_id, key_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`).run(session.id, login.discord_id, login.key_id, now, session.expires_at);
      this.db.prepare('DELETE FROM login_codes WHERE code_hash = ?').run(hash(loginCode));
      this.db.prepare('INSERT INTO audit_events (discord_id, kind, created_at) VALUES (?, ?, ?)')
        .run(login.discord_id, transferring ? 'device_transferred' : 'signed_in', now);
      return { ...this.createTokens(session, now), user: { discordId: login.discord_id, displayName: login.display_name },
        deviceTransferred: transferring };
    });
  }

  lookupSession(sessionId) {
    return this.db.prepare(`SELECT s.*, u.active_key_id, u.display_name, u.next_transfer_at,
      k.public_key, k.device_name FROM sessions s JOIN users u ON u.discord_id = s.discord_id
      JOIN installation_keys k ON k.key_id = s.key_id WHERE s.id = ?`).get(sessionId);
  }

  assertActive(session) {
    requireCondition(session && session.revoked_at === null && session.expires_at > this.clock() &&
      session.key_id === session.active_key_id, 401, 'SESSION_REVOKED', 'Sign in again on the authorized device.');
    this.assertAllowed(session.discord_id);
  }

  authenticate(token, request) {
    checkToken(token, 'access token');
    const entry = this.db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?').get(hash(token));
    requireCondition(entry && entry.expires_at > this.clock(), 401, 'ACCESS_TOKEN_EXPIRED', 'Refresh the session or sign in again.');
    const session = this.lookupSession(entry.session_id);
    this.assertActive(session);
    this.consumeProof(session.key_id, session.public_key, request, token);
    return session;
  }

  refresh({ refreshToken }, request) {
    checkToken(refreshToken, 'refresh token');
    const entry = this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash(refreshToken));
    requireCondition(entry, 401, 'INVALID_REFRESH_TOKEN', 'Sign in again.');
    const session = this.lookupSession(entry.session_id);
    this.assertActive(session);
    this.consumeProof(session.key_id, session.public_key, request);
    const now = this.clock();
    const result = transaction(this.db, () => {
      if (entry.consumed_at !== null) {
        this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, session.id);
        this.db.prepare('INSERT INTO audit_events (discord_id, kind, created_at) VALUES (?, ?, ?)')
          .run(session.discord_id, 'refresh_replay_revoked', now);
        return { replayed: true };
      }
      this.db.prepare('UPDATE refresh_tokens SET consumed_at = ? WHERE token_hash = ?').run(now, hash(refreshToken));
      return this.createTokens(session, now);
    });
    // Throw AFTER committing the revocation, rather than accidentally rolling it back.
    requireCondition(!result.replayed, 401, 'REFRESH_TOKEN_REUSED', 'This session was revoked. Sign in again.');
    return result;
  }

  logout(session) {
    const now = this.clock();
    transaction(this.db, () => {
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, session.id);
      this.db.prepare('INSERT INTO audit_events (discord_id, kind, created_at) VALUES (?, ?, ?)')
        .run(session.discord_id, 'signed_out', now);
    });
    // Keep active_key_id and next_transfer_at: logout must not bypass the cooldown.
  }
}
