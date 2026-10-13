# Takeoff API v1

The base URL is the private service's public HTTPS origin. Authentication controls access; the hostname and API paths are not secrets. All responses use `Cache-Control: no-store`. Bodies are JSON objects limited to 16 KiB. Compressed request bodies are rejected. Native requests omit `Origin`; the server does not provide cross-origin browser access.

## Native sign-in sequence

1. Create a P-256 signing key for this installation. In the iPhone implementation, use a Secure Enclave key when available and device-only Keychain protection. Retain it across ordinary sign-outs. Send only its SPKI PEM public key to the backend. Do not put a shared secret in the app.
2. Generate a cryptographically random 32-byte verifier, encoded as unpadded base64url. Compute `base64url(SHA256(UTF8(verifier)))`. Retain the verifier only for this login attempt.
3. `POST /v1/auth/discord/start` with:

   ```json
   {
     "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
     "codeChallenge": "43-character-S256-challenge",
     "deviceName": "My iPhone"
   }
   ```

   The placeholder above illustrates fields, not valid key material. The response contains `authorizationUrl`, `state`, `keyId`, and `expiresIn` (300 seconds). Retain `state` and open the returned Discord URL with `ASWebAuthenticationSession`.

4. Discord redirects to the **server** at `/v1/auth/discord/callback`. The server consumes its one-use state, exchanges Discord's authorization code, requests the `identify` profile, and enforces the allowlist. It never sends the Discord client secret or Discord access token to the app.
5. The server redirects back to `takeoff://auth/callback?state=...&login_code=...`. Validate the exact callback scheme, host, path, and the original state before accepting it. Cancellation/denial returns `error=access_denied`; an expected upstream failure returns `error=discord_unavailable`. An invalid/expired server state is rejected without an app redirect.
6. Send a **signed** `POST /v1/auth/exchange` with `loginCode`, `codeVerifier`, and `transferExistingDevice: false`. The handoff code expires in two minutes and is single-use. It requires both the original verifier and a signature from the original installation key. The S256 protection here covers the Takeoff server-to-app handoff; it does not assume Discord implements a particular native PKCE flow.
7. Store the returned refresh token with device-only Keychain protection. Keep access tokens in memory where practical. Neither token, the verifier, nor the private key belongs in `UserDefaults`, crash reports, URLs, analytics, or logs.

A successful exchange returns `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `expiresIn`, `sessionExpiresAt`, `serverTime`, `user`, and `deviceTransferred`. Access tokens last at most 15 minutes. The session has a fixed 30-day maximum; refreshing does not extend that deadline. A new login replaces the previous session even on the same installation.

## Signed requests

All protected API requests, login exchanges, and refreshes require these headers:

```text
X-Takeoff-Timestamp: Unix seconds as decimal text
X-Takeoff-Nonce: 32 fresh random bytes, unpadded base64url
X-Takeoff-Signature: ECDSA P-256/SHA-256 DER signature, unpadded base64url
```

Protected requests additionally send `Authorization: Bearer ACCESS_TOKEN`. The sign-in start endpoint and the browser OAuth callback are unsigned. Exchange and refresh requests do not send an access-token Authorization header.

Sign the following UTF-8 text, joined with literal LF characters and **no trailing LF**:

```text
takeoff-v1
UPPERCASE_HTTP_METHOD
/exact/path?exact=query&order=preserved
lowercase_hex_sha256_of_exact_body_bytes
timestamp_header_value
nonce_header_value
lowercase_hex_sha256_of_access_token_or_a_single_dash
```

For exchange and refresh, the final line is `-`. The refresh token is already covered by the signed body. For a bodyless GET, hash zero bytes, not `{}`. Encode the JSON once, sign that `Data`, then transmit those exact bytes. Do not reserialize it after signing. Sign the path and query exactly as sent, including percent encoding and query order.

The server verifies ECDSA using SHA-256 over this message. With CryptoKit, use `signature(for: messageData)` and transmit `signature.derRepresentation`; do not hash twice or send the 64-byte raw representation. Public keys must be standard P-256 SubjectPublicKeyInfo PEM. The returned `keyId` is lowercase hex SHA-256 of the SPKI DER bytes. Secure Enclave's public-key export must be converted to that format in the Swift client.

Timestamp tolerance is two minutes in either direction. Every accepted nonce is persisted and cannot be reused for that installation. Generate a fresh nonce and signature for each retry, even after a 409 or 429. Client clock errors should prompt checking automatic date/time; do not disable signature verification.

This is a versioned Takeoff request-signing protocol, not a claim of App Attest or hardware validation. See [SECURITY.md](SECURITY.md).

## Device transfer

A login with a different installation key returns HTTP 409, code `DEVICE_TRANSFER_REQUIRED`. Display the transfer prompt. Only after the user accepts, retry exchange with `transferExistingDevice: true` and a fresh nonce/signature. The still-valid login code may be reused for that retry because the earlier failed exchange did not consume it.

An accepted transfer immediately revokes previous sessions and refresh tokens and starts a six-hour cooldown. A further transfer during that period returns HTTP 429 `DEVICE_TRANSFER_COOLDOWN`, `Retry-After`, and `error.details.retryAfterSeconds`. Start a fresh Discord sign-in when attempting again after the cooldown; do not retain the two-minute handoff code for hours. The first registration is not a transfer. Returning to the same installation does not restart the cooldown. Signing out does not erase it.

Switching Discord accounts requires a different installation key because a public key cannot be reassigned to another account. Preserve account-specific key references securely so switching back does not unnecessarily simulate a new phone.

## Refresh and logout

`POST /v1/auth/refresh` accepts `{"refreshToken":"..."}` with a signature from the session's installation key. The response supplies a replacement access/refresh pair. Save the replacement atomically and discard the old refresh token.

**Serialize refreshes in the Swift client.** Reusing a consumed refresh token with a valid installation signature revokes the entire session. If a refresh response is lost, start Discord sign-in again rather than automatically replaying that refresh token. An exact retransmission with the same nonce is separately rejected as a replay. Other API calls may wait for one in-flight refresh.

`POST /v1/auth/logout` is authenticated and signed, with `{}` or an empty body. It revokes the current session. The client should clear its tokens; retaining its installation key allows the same phone to sign in without being treated as a transfer.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health/live` | Process is serving HTTP; no auth |
| GET | `/health/ready` | Database can be queried; no auth |
| POST | `/v1/auth/discord/start` | Begin a five-minute sign-in flow |
| GET | `/v1/auth/discord/callback` | Discord browser callback; fixed native redirect |
| POST | `/v1/auth/exchange` | Exchange one-use login code; installation signature |
| POST | `/v1/auth/refresh` | Rotate tokens; installation signature |
| POST | `/v1/auth/logout` | Revoke current session; authenticated |
| GET | `/v1/me` | User, role, installation, cooldown, capabilities |
| GET | `/v1/catalog` | `{products: [{retailer, upc, title}]}` |
| GET | `/v1/events?limit=50&before=123` | This user's retained inbox, newest first |
| POST | `/v1/events/123/read` | Mark this user's event as read |

All rows after logout in the table also require an access token and installation signature. `GET /v1/me` currently reports `monitoring: false`, `remotePush: false`, and `appAttestRequired: false` to avoid implying unfinished integrations are active.

Inbox `limit` is 1–100, default 50. Omit `before` for the first page and use the returned `nextCursor` for older pages. A response has `events: [{id, kind, payload, createdAt, readAt}]` and `nextCursor` (or null). Only the last seven days are visible. Cross-account event IDs return 404 on mark-read. No client-facing endpoint can manufacture events; the monitoring worker will generate them later. The current catalog is manually maintained in `catalog.json` and loaded on startup.

## Errors and throttling

```json
{
  "error": {
    "code": "DEVICE_TRANSFER_COOLDOWN",
    "message": "Device transfers are limited to once every six hours.",
    "details": { "retryAfterSeconds": 1800 },
    "requestId": "support-correlation-id"
  }
}
```

| Code | Client behavior |
| --- | --- |
| `ACCESS_TOKEN_EXPIRED` | Perform one serialized refresh |
| `SESSION_REVOKED`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` | Clear tokens and sign in again |
| `ACCESS_DENIED` | Show that this Discord account lacks access |
| `INVALID_PROOF`, `REPLAYED_REQUEST` | Check exact bytes, key, clock, and nonce; do not loop |
| `INVALID_LOGIN_CODE`, `INVALID_OAUTH_STATE` | Restart sign-in |
| `DEVICE_TRANSFER_REQUIRED` | Ask the user whether to transfer |
| `DEVICE_TRANSFER_COOLDOWN` | Display retry time; keep the current phone active |
| `RATE_LIMITED`, `AUTH_BUSY` | Honor retry information and back off |
| `DISCORD_UNAVAILABLE` | Let the user start a new login attempt later |

Limits include 300 API requests/minute per client IP, 180 protected requests/minute per user, 10 login starts/10 minutes per IP, and 200 login starts/10 minutes globally. These are initial single-instance safeguards, not a capacity guarantee for 100 users. Infrastructure request logs must redact authorization headers, bodies, and OAuth callback queries.
