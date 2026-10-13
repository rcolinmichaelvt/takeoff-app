import path from 'node:path';

function ids(value = '') {
  const result = new Set(value.split(',').map(s => s.trim()).filter(Boolean));
  if ([...result].some(id => !/^\d{17,20}$/.test(id))) {
    throw new Error('Discord allowlists must contain numeric user IDs of 17–20 digits.');
  }
  return result;
}

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const base = new URL(env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && local && !production))) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (loopback HTTP is allowed in development).');
  }
  const callback = new URL(env.APP_CALLBACK_URL || 'takeoff://auth/callback');
  if (callback.protocol !== 'takeoff:' || callback.hostname !== 'auth' ||
      callback.pathname !== '/callback' || callback.search || callback.hash || callback.username || callback.password) {
    throw new Error('APP_CALLBACK_URL must be takeoff://auth/callback.');
  }
  if (!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID || '') ||
      typeof env.DISCORD_CLIENT_SECRET !== 'string' || env.DISCORD_CLIENT_SECRET.trim().length < 20) {
    throw new Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in the server environment.');
  }
  const allowedIds = ids(env.ALLOWED_DISCORD_IDS);
  const moderatorIds = ids(env.MODERATOR_DISCORD_IDS);
  if ([...moderatorIds].some(id => !allowedIds.has(id))) {
    throw new Error('Every moderator must also appear in ALLOWED_DISCORD_IDS.');
  }
  const dataDir = path.resolve(env.DATA_DIR || './data');
  // An ephemeral production filesystem would undo revocations and transfer cooldowns.
  if (production) {
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount || dataDir !== path.resolve(mount)) {
      throw new Error('Production requires a mounted Railway volume and DATA_DIR equal to RAILWAY_VOLUME_MOUNT_PATH.');
    }
  }
  return {
    production,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    port: integer(env.PORT, 3000, 1, 65535, 'PORT'),
    proxyHops: integer(env.TRUST_PROXY_HOPS, 0, 0, 3, 'TRUST_PROXY_HOPS'),
    dataDir,
    publicBaseUrl: base.origin,
    discordRedirectUri: `${base.origin}/v1/auth/discord/callback`,
    appCallbackUrl: callback.href,
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET,
    allowedIds,
    moderatorIds,
    accessTtlMs: 15 * 60_000,
    sessionTtlMs: 30 * 24 * 60 * 60_000,
    flowTtlMs: 5 * 60_000,
    loginCodeTtlMs: 2 * 60_000,
    transferCooldownMs: 6 * 60 * 60_000,
    historyTtlMs: 7 * 24 * 60 * 60_000,
    proofWindowMs: 2 * 60_000,
  };
}
