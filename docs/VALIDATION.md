# Milestone 2 validation

Validated in a Linux workspace using **Node.js 24.19.0**. The owner reports the Milestone 1 Railway service is set up. This source update was not deployed to that service here.

## Completed checks

**47 backend tests pass**, using temporary SQLite databases, real P-256 signatures, local HTTP requests, controlled clocks, and simulated provider/Discord responses. Run from `backend`:

```sh
npm test
```

Coverage includes the original account/security/recovery behavior and the new app paths:

- OAuth allowlist, one-use state and handoff, verifier/signature binding, exact request bytes, timestamps, and persistent nonce replay prevention.
- One authorized installation, immediate revocation, six-hour transfer cooldown through logout/restarts, rotating refresh tokens, and authenticated refresh-reuse revocation.
- Settings/catalog validation, leading-zero ZIP handling and caching, partial alert updates, shared subscriptions, account removal, and active-coverage removal.
- Private note/favorite ownership, moderator-only public notes, exclusions, HTTP endpoint authorization, and shared stock visibility without private-data leakage.
- The agreed 3 + 12 = 15 → 14 → 13 → 12 → 11 sequence, baseline uncertainty, gaps/staleness, seven-day history, and no duplicate event for an unchanged overlapping observation.
- Invalid/missing/blank/boolean DG quantities rejected rather than converted into false zero stock; token refresh and provider backoff use sanitized errors.
- A slow address lookup does not block stock polling; a distant geocoder match is rejected.
- Revocation during an asynchronous ZIP lookup prevents the waiting request from saving settings. This check found a stale-session-snapshot issue; the authorization check now rereads the current database session.
- Real schema version 1 → 2 migration preserves accounts, sessions, and transfer cooldowns; online backups and safe restore preparation remain covered.
- A shared, disposable public-key/signature fixture verifies the Node signing contract. The same fixture is supplied to the native test target.

The actual `src/main.js` entry point was started against a temporary database with monitoring disabled. Readiness/liveness and graceful SIGTERM shutdown passed without external requests.

The Xcode project's object references, source membership, Info.plist, shared scheme, and workspace were parsed. The Swift source parsed without syntax errors using a Swift grammar. **These structural checks are not an Xcode compiler/type check.**

## Native checks included, not executed here

The `TakeoffTests` target contains four XCTest cases: signing interoperability, callback-state validation, stale-data behavior, and partial settings encoding. Run **Command-U** on an iPhone simulator from the supplied Takeoff scheme. The tests do not sign in or call Railway.

Physical iPhone code uses Secure Enclave and device-only Keychain storage. Simulator code uses a separate development software key. These platform-specific branches require their respective Xcode/device checks; parser checks do not validate Keychain entitlements or actual hardware behavior.

## Remaining integration checks

- **Xcode build and UI:** no Xcode/iOS SDK is available here. The owner must compile/run on the Mac and verify the UI, browser callback, location picker, Apple Maps display/ETA, secure key persistence, and device transfer.
- **Real DG session:** the existing endpoint/token-refresh approach was ported and tested with controlled responses. No real DG inventory request was sent. Verify quantities and actual returned address/coordinate fields with the owner's working session.
- **Real Discord/Railway:** perform native sign-in and an update/redeploy using the same volume. A health response alone does not validate Discord credentials or DG monitoring.
- **Docker:** Docker is not installed in this workspace; the actual Railway image build remains a deployment check.
- **Third-party geography:** the public ZIP response shape and the official Census API documentation were checked. Availability, address-match coverage, ZIP boundary approximations, and network delays still affect live results.
- **Capacity:** the 100-user target was not load-tested. Unique ZIP+UPC pairs, response latency, rate limits, and geocoding coverage determine throughput. The one-process worker caps concurrency and honors backoff; nominal cadence is not a guarantee at that scale.

## Explicitly outside this milestone

Store-hours timing, separate-delivery timing samples, forecast confidence/patterns, approaching-time events, multi-store routing, live trip updates, APNs, App Attest, payment access, and TestFlight release preparation remain future milestones. The approaching alert preference is saved but produces no prediction event yet. No local reminder or background-polling workaround is claimed.

The package contains source, documentation, and disposable test fixtures. It excludes old Git history, captured credentials, live caches, databases, `.env` secrets, and generated Xcode user/build state. Removing old credentials from delivered source does not revoke those previously exposed in the original public repository.
