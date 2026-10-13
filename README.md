# Takeoff

Takeoff is being migrated from the existing Dollar General Discord monitor into a private backend and a SwiftUI iPhone app.

**This delivery is Milestone 1: the backend foundation.** It includes persistent accounts and sessions, Discord sign-in, an ID allowlist, signed installation requests, device transfers with a six-hour cooldown, the curated product catalog, a seven-day alert inbox API, and backup/migration tools. The automated tests use temporary databases and fake Discord responses.

The new backend does **not yet poll Dollar General, generate inventory alerts, send APNs notifications, or include an Xcode project**. The existing monitor remains a separate program. Nothing in this delivery has been deployed to your live Railway service.

## Start here

- [Local and Railway setup](backend/SETUP.md)
- [API and native sign-in contract](backend/API.md)
- [Security boundaries and credentials](backend/SECURITY.md)
- [Approved requirements and milestones](docs/PRODUCT_PLAN.md)
- [Xcode, Personal Team, notifications, and TestFlight](docs/XCODE_TESTING.md)
- [Validation and remaining checks](docs/VALIDATION.md)

## Run the tests

Install Node.js **24.x**, then run these from the repository root:

```sh
cd backend
npm test
```

The backend has no third-party runtime dependencies and does not need the root `node_modules` directory. Its SQLite database is created at runtime, not during the build.

## Repository and deployment safety

The original GitHub repository was public when this work was prepared. Its history contains captured Dollar General session credentials. This version reads those values from server environment variables and excludes live caches, databases, and `.env` files from new commits. That does not remove credentials from earlier commits or undo prior exposure. Obtain fresh credentials before the monitoring migration.

Keep new server work in a **private repository**. A clean private repository avoids copying the original credential-bearing Git history. The original repository's visibility and existing Railway service have not been changed.

`dgMonitor.js` is still the legacy Discord monitor. The local changes to it remove embedded credentials and support a persistent cache path. Deploying that revised file requires the root `.env.example` variables and a persistent volume first. The new backend instead uses `backend/.env.example` and its own volume. See the migration instructions before changing the existing service.
