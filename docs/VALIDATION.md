# Milestone 1 validation

Validated in a Linux workspace with Node.js 24.19.0. No live Dollar General inventory requests, real Discord account logins, Railway deployment, or iOS compilation were performed.

## Automated checks

Run from `backend`:

```sh
npm test
```

The suite has 30 tests using temporary SQLite databases, genuine P-256 signatures, local HTTP requests, controlled clocks, and fake Discord responses. Coverage includes:

- OAuth state expiry and one-use handling; allowlist denial; callback verifier and signing-key requirements.
- Hashed token persistence, expiry, refresh rotation, and revocation on authenticated refresh reuse.
- Request method/path/body/token binding, timestamp checks, nonce replay rejection, and replay records surviving database reopen.
- Explicit device transfers, immediate old-session revocation, six-hour cooldown across logout/restart, and exact cooldown expiry.
- Current-account access checks and private seven-day inbox pagination/mark-read ownership.
- Body limits, malformed input, browser-origin rejection, request throttling, and conservative proxy-header handling.
- Discord HTTP request formats, scope, server-only credentials, sanitized upstream failure, and best-effort temporary-token revocation.
- Database reopen, online backups, safe offline recovery with sessions invalidated, cache import validation, and refusal to overwrite an imported snapshot.
- Production rejection of HTTP base URLs, absent/mismatched volume paths, and invalid allowlist configuration.

The source files also receive Node syntax checks. A separate process smoke check starts the real entry point against a temporary database, queries liveness/readiness, and shuts it down without contacting Discord or DG.

## Not yet validated

- Docker build/run: Docker is not installed in this workspace. The Dockerfile copies the dependency-free Node backend; the actual Railway image build remains a deployment check.
- Real Discord credentials, registered redirects, and a completed native callback: no owner-provided OAuth application or iPhone client is configured yet.
- Actual Railway volume persistence and proxy headers: the service has not been deployed. A live restart test is still required.
- Stock monitoring, store opening hours, ZIP resolution, prediction accuracy, route estimates, APNs, and App Attest: later milestones, not implemented by this API foundation.
- iOS compilation and on-device behavior: no Xcode project is included in Milestone 1, and this workspace cannot run Xcode.
- Capacity for 100 users: not load-tested; real cost and request volume depend on distinct covered areas and followed products.

The source review removed embedded DG credentials from the working legacy file and excluded private runtime data from the delivery. It does not clean the original Git history or revoke exposed credentials. No remote GitHub writes or live infrastructure changes were made while preparing this milestone.
