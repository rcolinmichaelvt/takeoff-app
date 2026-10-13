import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordClient } from '../src/discord.js';

const config = { discordClientId: '423456789012345678',
  discordClientSecret: 'fixture-only-never-a-real-secret',
  discordRedirectUri: 'https://takeoff.example/v1/auth/discord/callback' };
const upstreamToken = 'fixture-only-discord-access-token';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('Discord authorization requests identify only, a fixed redirect, and state without a secret', () => {
  const url = new URL(createDiscordClient(config).authorizationUrl('test-state'));
  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(url.searchParams.get('state'), 'test-state');
  assert.equal(url.searchParams.get('redirect_uri'), config.discordRedirectUri);
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('Discord credentials stay on the server and temporary tokens are revoked after identity lookup', async () => {
  const calls = [];
  const client = createDiscordClient(config, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json({ access_token: upstreamToken, token_type: 'Bearer', scope: 'identify' });
    if (calls.length === 2) return json({ id: '123456789012345678', username: 'fixture', global_name: 'Fixture' });
    return new Response(null, { status: 204 });
  });
  const identity = await client.getIdentity('fixture-code');
  assert.deepEqual(identity, { id: '123456789012345678', displayName: 'Fixture' });
  assert.equal(calls.length, 3);
  const exchange = calls[0];
  assert.equal(exchange.url, 'https://discord.com/api/oauth2/token');
  assert.equal(exchange.options.body.get('client_secret'), config.discordClientSecret);
  assert.equal(exchange.options.body.get('grant_type'), 'authorization_code');
  assert.equal(exchange.options.body.get('redirect_uri'), config.discordRedirectUri);
  assert.equal(exchange.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[1].url, 'https://discord.com/api/v10/users/@me');
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${upstreamToken}`);
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[2].url, 'https://discord.com/api/oauth2/token/revoke');
  assert.equal(calls[2].options.body.get('token'), upstreamToken);
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.signal));
  assert.equal(JSON.stringify(identity).includes(upstreamToken), false);
});

test('upstream errors are sanitized, including when identity lookup fails after token exchange', async () => {
  let calls = 0;
  const client = createDiscordClient(config, async () => {
    calls++;
    if (calls === 1) return json({ access_token: upstreamToken, token_type: 'Bearer', scope: 'identify' });
    if (calls === 2) return json({ sensitive: upstreamToken }, 502);
    return new Response(null, { status: 204 });
  });
  await assert.rejects(client.getIdentity('fixture-code'), error => {
    assert.equal(error.code, 'DISCORD_UNAVAILABLE');
    assert.equal(error.message.includes(upstreamToken), false);
    return true;
  });
  assert.equal(calls, 3);
});

test('revocation failure does not retain a token or prevent a completed identity lookup', async () => {
  let calls = 0;
  const client = createDiscordClient(config, async () => {
    calls++;
    if (calls === 1) return json({ access_token: upstreamToken, token_type: 'bearer', scope: 'identify' });
    if (calls === 2) return json({ id: '123456789012345678', username: 'fixture' });
    throw new Error('Temporary network outage');
  });
  assert.deepEqual(await client.getIdentity('fixture-code'), { id: '123456789012345678', displayName: 'fixture' });
  assert.equal(calls, 3);
});
