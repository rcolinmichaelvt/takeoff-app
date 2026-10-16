# Security boundaries

This milestone provides an authenticated API, inventory worker, and native iPhone client. It is not a completed production security review, hardware attestation service, or guarantee that authorized users cannot copy data they can view.

## What stays on the server

Discord's client secret and token exchange stay on the server. No Discord token is sent to the iPhone or stored in the database. The inventory worker keeps DG cookies, refreshed session credentials, inventory requests, and stock classification on the server. DG credentials are required only when monitoring is enabled. Restock batch classification, business-hours timing, learned aggregates, forecasts, and departure-event generation all remain server-side.

The Swift app uses the API base URL, its public app identifiers, an installation signing key, and its own session credentials. It must receive enough store data to display a map, so that returned data can still be observed or copied by an authorized user. Keeping the monitor off the phone protects its implementation and upstream credentials; it does not make screenshots, reverse engineering, or abuse of an authorized account impossible.

## Implemented controls

- Discord OAuth uses one-use expiring state and the `identify` scope. The native callback contains a two-minute handoff code, not an access token. Exchanging it requires the original S256 verifier and installation signature.
- A numeric Discord ID allowlist is enforced at sign-in and on every authenticated request and refresh. Environment changes take effect when the process restarts. An empty allowlist denies everyone.
- Requests are signed with an installation's P-256 key. The signature covers method, exact path/query, exact body, timestamp, nonce, and the access-token hash when present. Nonces persist across restarts.
- One active installation and one active session are maintained per Discord ID. Explicit transfers revoke the preceding sessions immediately. The six-hour transfer deadline survives logout and restart.
- Access tokens expire after at most 15 minutes; refresh tokens rotate inside a fixed 30-day session. Only SHA-256 token hashes are stored. Authenticated refresh-token reuse revokes the session.
- Settings, private notes, favorites, exclusions, and inbox reads/updates use the authenticated account rather than a client-supplied user ID. Authorized members intentionally share stock observations and moderator notes across covered areas. Only configured moderator IDs can edit public notes. History and inbox queries are limited to seven days.
- The API limits body size and request rates and returns sanitized errors. It does not log credentials, request bodies, or OAuth URLs. Rate-limit proxy headers are ignored unless explicitly trusted.
- SQLite is stored outside the source tree on a persistent Railway volume in production. Production startup refuses an absent/mismatched configured mount. Transactions cover session changes, imports, and recovery invalidation.
- Drive estimates are signed, validated against the current saved ZIP/store coordinates, timestamped by the server, and private to the authenticated account. A modified client can falsify its own drive duration, but cannot train the shared model or change another account's estimate. These inputs do not attest to a genuine Apple Maps result.
- Backups use SQLite's online backup API. Prepared restore copies invalidate existing sessions and challenge codes to avoid reviving old tokens.

## One installation versus one physical iPhone

The current server enforces **one registered signing key at a time**. It cannot yet prove that a key was created by the real Takeoff binary in real iPhone hardware. A malicious client with both an exportable private key and its session credentials could share that installation identity. A device ID string or obscured API key would not fix this.

The supplied Swift client uses a Secure Enclave key on a physical device and `WhenUnlockedThisDeviceOnly` Keychain storage for local session credentials and the encrypted key reference. Simulator builds use a separately stored software key for development. The key is retained across sign-outs. The API client signs exact transmitted bytes, refuses HTTP redirects, and serializes rotating refreshes; a lost refresh response requires a fresh sign-in. The later paid-developer milestone adds App Attest with server-verified challenges and assertions. Even that is abuse resistance, not an absolute defense against a compromised authorized device. Free Personal Team testing must not be represented as having full attestation.

Device transfer enforcement does not depend on APNs. Push registration/revocation will be attached to the active installation when APNs is implemented. Until then, the backend explicitly reports that remote push is unavailable.

## Existing public credentials

The original repository contained captured DG credentials. Removing them from the current source does not revoke them, erase earlier commits, remove other people's clones, or remove cached copies. Before monitoring cutover, establish a fresh DG website session and replace the affected server credentials. Keep those values in Railway Variables. Rotate any other secret that was exposed; do not assume the webhook or a newly created Discord OAuth secret was exposed unless it actually was.

A private repository protects future access. A clean private repository also avoids carrying the original credential-bearing Git history into the new project. Do not include `.git`, `.env`, cache files, SQLite databases, or backup files in a source download intended for sharing.

## Operational limits

This design uses one Node process and one local SQLite database. Its in-memory rate limits reset on restart; authentication state and revocations do not. Do not add replicas or separate workers sharing copies of this database. A future need for multiple machines calls for a shared database and distributed coordination.

Back up before migrations, restrict infrastructure access, and retain a protected off-service copy. The database and backups are not encrypted by this application; storage-account controls and any platform encryption are separate responsibilities. Do not copy a lone live `.sqlite` file while ignoring its WAL. Never restore stale sessions directly from a raw backup.

The authenticated profile, public key, settings, notes, favorites, latest stock snapshot, and cached geography persist until explicitly removed. Abandoned coverage stops polling and old stock is marked unknown. Inventory history, finished batch details, and inbox events expire after seven days; per-store timing aggregates persist separately; travel estimates are usable for 24 hours and pruned after seven days; audit events after 30 days; session token records after their session's expiry. Data export/account deletion and payment entitlement workflows belong to the later release preparation, not the present app controls.

Infrastructure logging may capture request URLs even when this application does not. Redact OAuth callback query strings and Authorization headers and restrict log access. Never enable indiscriminate body or header logging to debug a real sign-in.

Before admitting paying users, complete the live integration checks, evaluate request volume and provider backoff, verify backup recovery, and review the completed client and inventory API. The existing automated suite tests specific defenses; it does not prove the full eventual application is production ready.

## Trips

Trips are private account data, accessed only through the same signed active-device API. Owners are taken from the session, never a JSON field. Preview/save recheck followed products, ZIP, coordinates, exclusions, fresh coverage, stock inference, hours and predictions. A version counter prevents stale edits from replacing a newer or cleared trip. Maximum ten stops, bounded values/body sizes, and per-account throttling limit work.

Apple Maps measurements arrive from the device and are untrusted. They affect only that account's private arrival estimates; they never train shared restock models or change shelf classification. A modified client can mislead its own trip, which this free build cannot attest. The app sends public store coordinates and the saved ZIP origin to Apple Maps for requested driving estimates and route handoff; no DG credentials or private notes accompany that handoff. A route already opened in Maps is managed by Maps. APNs and App Attest remain Milestone 5.
