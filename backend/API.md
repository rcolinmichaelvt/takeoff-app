# Takeoff API v1

The base URL is the private service's public HTTPS origin. Authentication controls access; the hostname and API paths are not secrets. All responses use `Cache-Control: no-store`. Bodies are JSON objects limited to 16 KiB. Compressed request bodies are rejected. Native requests omit `Origin`; the server does not provide cross-origin browser access.

## Native sign-in sequence

1. Create a P-256 signing key for this installation. The supplied iPhone implementation uses a Secure Enclave key on physical hardware and device-only Keychain protection; its simulator build uses a development software key. Retain it across ordinary sign-outs. Send only its SPKI PEM public key to the backend. Do not put a shared secret in the app.
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
7. Store the returned token pair atomically with device-only Keychain protection. The supplied client restores the pair on launch and rotates it as a unit. Neither token, the verifier, nor the private key belongs in `UserDefaults`, crash reports, URLs, analytics, or logs.

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

The server verifies ECDSA using SHA-256 over this message. With CryptoKit, use `signature(for: messageData)` and transmit `signature.derRepresentation`; do not hash twice or send the 64-byte raw representation. Public keys must be standard P-256 SubjectPublicKeyInfo PEM. The returned `keyId` is lowercase hex SHA-256 of the SPKI DER bytes. The client exports CryptoKit's `publicKey.pemRepresentation` in that SPKI format.

Timestamp tolerance is two minutes in either direction. Every accepted nonce is persisted and cannot be reused for that installation. Generate a fresh nonce and signature for each retry, even after a 409 or 429. Client clock errors should prompt checking automatic date/time; do not disable signature verification.

This is a versioned Takeoff request-signing protocol, not a claim of App Attest or hardware validation. See [SECURITY.md](SECURITY.md).

## Device transfer

A login with a different installation key returns HTTP 409, code `DEVICE_TRANSFER_REQUIRED`. Display the transfer prompt. Only after the user accepts, retry exchange with `transferExistingDevice: true` and a fresh nonce/signature. The still-valid login code may be reused for that retry because the earlier failed exchange did not consume it.

An accepted transfer immediately revokes previous sessions and refresh tokens and starts a six-hour cooldown. A further transfer during that period returns HTTP 429 `DEVICE_TRANSFER_COOLDOWN`, `Retry-After`, and `error.details.retryAfterSeconds`. Start a fresh Discord sign-in when attempting again after the cooldown; do not retain the two-minute handoff code for hours. The first registration is not a transfer. Returning to the same installation does not restart the cooldown. Signing out does not erase it.

A public key cannot be reassigned to another Discord account. The supplied first client keeps one account identity per installed app/backend origin; it does not offer a multi-account switcher. Use the same Discord account when signing back into that installation.

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
| GET | `/v1/settings` | Saved ZIP, center, products, alert preferences |
| PUT | `/v1/settings` | Partial settings update for this account |
| GET | `/v1/monitor/status` | Shared worker state and capability flags |
| GET | `/v1/travel-estimates/needed` | Up to 250 eligible nearby destinations needing this account's drive estimate |
| PUT | `/v1/travel-estimates/100` | Save an account-specific drive estimate |
| GET | `/v1/stores?scope=nearby` | Store observations and this account's notes/preferences |
| GET | `/v1/stores/100` | Store detail, all observed catalog products |
| PUT | `/v1/stores/100/preferences` | Private note, favorite, exclusion |
| PUT | `/v1/stores/100/public-note` | Moderator-only public note |
| GET | `/v1/stores/100/history` | Seven-day stock history |
| GET | `/v1/events?limit=50&before=123` | This user's retained inbox, newest first |
| POST | `/v1/events/123/read` | Mark this user's event as read |

All rows after logout in the table also require an access token and installation signature. `GET /v1/me` reports `monitoring` from server configuration, `inventory: true`, `predictions: true`, `trips: true`, `remotePush: false`, and `appAttestRequired: false`. Monitoring enabled is configuration state, not proof of a successful provider request.

Inbox `limit` is 1–100, default 50. Omit `before` for the first page and use the returned `nextCursor` for older pages. A response has `events: [{id, kind, payload, createdAt, readAt}]` and `nextCursor` (or null). Only the last seven days are visible. Cross-account event IDs return 404 on mark-read. No client-facing endpoint can manufacture events; the worker generates them from inventory changes matching the account's selections and preferences. The current catalog is manually maintained in `catalog.json` and loaded on startup.

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

## App settings and inventory

`PUT /v1/settings` accepts any subset of:

```json
{
  "zip": "24060",
  "products": ["196214158801"],
  "alerts": {
    "firstDecrease": true,
    "soldOut": true,
    "approaching": true,
    "stockIncrease": false,
    "anyDecrease": false,
    "paused": false
  }
}
```

The default alerts are shown above. ZIP is exactly five ASCII digits, including leading zeros. The server resolves its coordinate; client coordinates and radius changes are not accepted. Products must be unique UPCs in the curated catalog. An empty array removes that account's monitoring demand. Omitting a field preserves its value; null does not delete the ZIP. Partial `alerts` fields merge with existing values. Authorization is checked again after asynchronous ZIP lookup.

Settings responses contain `{zip, center: {latitude, longitude, label}, radiusMiles: 25, products, alerts}`. Before onboarding, `zip` and `center` are null. The `approaching` preference enables eligible departure-warning inbox events. These require a clean pending batch, usable store hours, medium/high confidence, and a recent per-account drive estimate. `paused` will suppress notification delivery; eligible changes remain in the inbox with `payload.notificationsPaused: true`.

`GET /v1/stores` supports `scope=nearby|covered`, `favorites=true|false`, a decimal-string `after` store-ID cursor, and `limit=1..250` (default 200). It returns `{stores, nextCursor, serverTime}`. Nearby uses distance from the saved ZIP center, at most 25 miles. Covered includes existing observations from other subscribed areas; abandoned coverage is retained as unknown. Favoriting does not create polling in another region. Excluded stores remain in API results with an `excluded` flag; the app hides them by default and the worker skips their alerts for that account.

Each store has `id`, `retailer`, `name`, `address`, `city`, `state`, nullable `postalCode`, `phone`, `latitude`, `longitude`, `coordinateSource`, and `distanceMiles`; plus account-specific `favorite`, `excluded`, `privateNote`, shared `publicNote`, and `inventory`. `coordinateSource` is `dg`, `census`, or null. Distance is straight-line miles. Apple Maps driving time is requested on the iPhone from the saved ZIP center, on demand and one eligible candidate per foreground refresh cycle. Estimates are saved only for that account; see below.

Inventory rows contain `{upc, title, quantity, status, stale, observedAt, lastIncreaseAt, lastDecreaseAt}`. Timestamps are UTC ISO 8601 strings; increase/decrease can be null. Status is `available`, `back`, `out`, or `unknown`. More than nine minutes without a fresh observation, or no current subscription covering that store/product, yields `unknown` and `stale: true` while retaining quantity. A missing product row means no observation, not zero.

A first positive observation is unknown; a successful zero is out. An increase marks new stock pending. If older known available stock remains, status stays available until total quantity reaches the pending new quantity. Crossing below that threshold signals new stock is likely selling: 3 available + 12 new = 15, then 14/13 available, 12 back, 11 available. A final zero is sold out and takes priority over a first-sale notification. Milestone 3 tracks separate delivery observations and excludes overlapping/uncertain batches from timing samples. Forecasts never change shelf status. A monitoring gap resets pending inference.

`PUT /v1/stores/:id/preferences` accepts optional `favorite`, `excluded` booleans and `privateNote` text (up to 2,000 UTF-16 code units). `PUT /v1/stores/:id/public-note` requires moderator access and `{note: "..."}` with the same limit. Empty text clears that note. Both return the updated store and do not accept a client-supplied owner ID.

`GET /v1/stores/:id/history` accepts `before` (positive integer ID) and `limit=1..100` (default 50). It returns `{history, nextCursor}` newest first. Rows contain `id`, `upc`, `title`, nullable `previousQuantity`, `quantity`, `status`, `kind`, and `createdAt`. Kinds include `baseline`, `resumed`, `stock_increase`, `decrease`, `first_decrease`, and `sold_out`. Only the last seven days are visible. Unchanged quantities do not create repetitive history entries.

`GET /v1/monitor/status` returns `{enabled, activeSearches, lastSuccessAt, delayedSearches, predictionsAvailable: true, remotePushAvailable: false}`. Metrics describe the shared worker. Missing rows and provider failures preserve previous inventory; they do not generate sold-out events.


## Milestone 3 timing and travel

Store responses add `timing: {sampleCount, averageOpenMinutes, spreadOpenMinutes, confidence, lastSampleAt, hoursStatus, openingHours, patterns}`. `confidence` is `learning|low|medium|high`; it is a heuristic, not a probability. `openingHours` is null or `{timezone, updatedAt, days: [{day, hours}]}` containing the regular schedule. `patterns` holds `{weekday, day, samples, averageOpenMinutes}` for observed clean-batch arrival weekdays (Monday=1). Aggregates remain after seven-day detailed records expire.

Each inventory row adds nullable `forecast: {batchId, startedAt, pendingQuantity, expectedAt, confidence, sampleCount, state, reason}`. `expectedAt` is null during learning or uncertainty. `state` is `pending|expected_unconfirmed`; `reason` describes why no estimate is available. Baseline/legacy/gap data never fabricates a clean sample. See the [upgrade guide](../docs/MILESTONE_3_UPGRADE.md) for timing rules, confidence thresholds, schedule freshness, and exclusions.

`GET /v1/travel-estimates/needed` returns `{candidates: [{storeId, zip, origin: {latitude, longitude}, destination: {latitude, longitude}}]}`. Candidates must be in this account's saved area, actively covered for a followed product, not excluded, and lack an estimate refreshed within six hours. Pending stores sort first. Monitoring and this account's approaching preference must be enabled.

`PUT /v1/travel-estimates/:id` accepts `{zip, latitude, longitude, seconds}` with integer seconds 1–14400. ZIP must still match this account; coordinates must still match that store; it must be an eligible nearby covered store. No owner ID, custom origin, timestamp, or predicted time is accepted. The server timestamps the saved result. This endpoint is limited to 10 writes/minute/account and also uses normal signed-request limits. A supplied value is an untrusted client estimate affecting only its own account, never shared model training or another user's routing. The response is `{saved: true}`.

Store responses add nullable `travelEstimate: {seconds, updatedAt, source: "apple_maps_device"}` for the requesting account only. A changed ZIP/destination or age over 24 hours invalidates it. No straight-line distance is labeled as driving time.

New stock events use separate `payload.address` and quantity-only `payload.body`. Older numbered bodies are enriched/stripped on read when a store record is available, without changing their read state. `approaching` payloads add `batchId`, `predictedAt`, `departureAt`, `driveSeconds`, `driveUpdatedAt`, `confidence`, and `notificationsPaused`. They are historical snapshots, not guaranteed current predictions. Live store detail returns the latest estimate. At most one approaching event per account/batch is persisted; a sold batch, stale stock, missing hours/ETA, excluded store, unfollowed product, removed account, or disabled toggle cannot create a new eligible event. Late warnings beyond the two-minute scheduling grace are skipped. There is no average-reached event and no APNs delivery in this milestone.

## Milestone 4: hours and trips

Inventory store records carry `hrsMon` through `hrsSun`, such as `0800:2200`. The server validates all seven fields, derives the store timezone from its coordinates when necessary, and caches the schedule before recording a new arrival. Hours refresh with normal stock polling, including zero-stock results. Partial or invalid schedules suppress timing predictions but preserve stock observations. No separate store-info request runs. Previously valid hours without a replacement expire after 72 hours.

Every trip endpoint requires the active installation signature and uses the authenticated account as owner. JSON remains limited to 16 KiB. Trip writes/previews share a limit of 20 per minute per account; the global signed-request limit also applies.

| Method | Path | Request / response |
| --- | --- | --- |
| GET | `/v1/trip` | `{version, trip}`; `trip` is null before saving or after clearing |
| POST | `/v1/trip/preview` | `{products, storeIds?}`; returns `{trip, candidates}` without saving |
| POST | `/v1/trip/preview` | With `zip, origin, departureAt, legs`, validate a measured preview without changing its order |
| PUT | `/v1/trip` | Save the measured preview with `version`; returns `{version, trip}` |
| POST | `/v1/trip/clear` | `{version}`; clear only this account's route and increment the version |

Products must be nonempty, approved, and followed by this account. Omit `storeIds` to suggest up to ten fresh likely-for-sale stores; supply a unique list to edit and geographically reorder it. Candidates include nearby, nonexcluded available stores and back-stock stores with medium/high forecasts. Selecting none in a preview returns only candidates. It cannot save an empty trip. Use clear instead.

A measured preview includes the preview's ZIP, origin and departure time, and exactly one leg for each ordered store ID:

```json
{
  "storeId": "14838",
  "from": {"latitude": 39.15, "longitude": -77.4},
  "to": {"latitude": 39.1446, "longitude": -77.4135},
  "seconds": 600,
  "meters": 4200
}
```

These are example values, not a real measured route. `seconds` is an integer from 1–14400; `meters` is finite and 0–1000000. Coordinates must exactly match the saved origin and successive current store coordinates. Departure must be within the previous 15 minutes (30 seconds future tolerance); total travel plus five-minute stop allowances must fit within 12 hours. A client-reported drive is untrusted and affects only its owner's route. It does not change inventory, public forecasts, or another user's estimates.

The response plan includes `zip, origin, products, departureAt, checkedAt, stopMinutes: 5, maxStops: 10, totalDriveSeconds, needsReplan, canOpen` and ordered `stops`. Each stop has its account-specific `store`, `arrivalAt`, `driveSeconds`, `distanceMeters`, `state`, `eligible`, `warnings`, and `expectedAt`. Read recomputes eligibility from current stock, coverage, exclusions, followed products, ZIP, hours, and predictions. Saving requires all stops eligible. Back stock stays yellow and needs a confident estimate by arrival; sold-out, unknown, stale or closed-at-arrival stops cannot be saved or handed off. Missing hours on otherwise available stock produces a warning. A previously saved invalid stop remains visible for removal.

`INVALID_TRIP` is HTTP 400. `TRIP_CHANGED`, `TRIP_UNAVAILABLE`, and `TRIP_NOT_READY` are HTTP 409; refresh and review the route. The client checks again immediately before opening Maps. `needsReplan` becomes true after 15 minutes. Successful saving replaces the single active trip atomically; failed edits leave it intact. Version checks also prevent a stale response from reviving a cleared trip.

`alerts.tripChanges` defaults true and can be changed with the existing settings API. For 12 hours after departure, the worker persists `trip_change` inbox events on meaningful stock/eligibility changes or forecast shifts of at least five minutes. Comparison state survives redeploys. Excluded stores, no-longer-followed products, changed ZIPs, and revoked accounts do not generate those alerts. Pause retains eligible inbox events. Quantities can change without changing route eligibility; ordinary inventory alert preferences cover those changes. No background app polling or APNs is added.
