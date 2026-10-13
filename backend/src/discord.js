import { AppError, requireCondition } from './errors.js';

export function createDiscordClient(config, fetchImpl = fetch) {
  return {
    authorizationUrl(state) {
      const url = new URL('https://discord.com/oauth2/authorize');
      url.search = new URLSearchParams({ client_id: config.discordClientId,
        response_type: 'code', scope: 'identify', redirect_uri: config.discordRedirectUri,
        state, prompt: 'consent' });
      return url.href;
    },
    async getIdentity(code) {
      let token;
      try {
        const response = await fetchImpl('https://discord.com/api/oauth2/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.discordClientId,
            client_secret: config.discordClientSecret, grant_type: 'authorization_code',
            code, redirect_uri: config.discordRedirectUri }),
        });
        if (!response.ok) throw new Error('Discord token exchange failed');
        token = await response.json();
        if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer' ||
            !String(token.scope || '').split(' ').includes('identify')) throw new Error('Invalid token response');
        const identityResponse = await fetchImpl('https://discord.com/api/v10/users/@me', {
          redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        if (!identityResponse.ok) throw new Error('Discord identity lookup failed');
        const identity = await identityResponse.json();
        requireCondition(/^\d{17,20}$/.test(identity.id || '') && typeof identity.username === 'string',
          502, 'DISCORD_UNAVAILABLE', 'Discord returned an invalid account.');
        return { id: identity.id, displayName: (identity.global_name || identity.username).slice(0, 80) };
      } catch {
        // Never log Discord response bodies: they can contain credentials.
        throw new AppError(502, 'DISCORD_UNAVAILABLE', 'Discord sign-in could not be completed. Please start again.');
      } finally {
        // Discord credentials never go to the app or the database.
        // Revocation is best effort; identity lookup is the only permission we need.
        if (token?.access_token) {
          try {
            await fetchImpl('https://discord.com/api/oauth2/token/revoke', {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ client_id: config.discordClientId,
                client_secret: config.discordClientSecret, token: token.access_token,
                token_type_hint: 'access_token' }),
            });
          } catch { /* No token is retained even if Discord is temporarily unavailable. */ }
        }
      }
    },
  };
}
