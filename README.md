# Takeoff

A private Dollar General monitoring backend and a SwiftUI iPhone app.

**Milestone 4 source is ready for local iPhone testing.** It includes the Xcode project, Discord sign-in, a saved ZIP and curated product selections, map/list views, store details, favorites/exclusions, private and moderator notes, a seven-day history/inbox, and the supporting server worker/API.

The backend polls only subscribed ZIP/product pairs, keeps DG credentials and classification on the server, and preserves data on the existing Railway volume. Shelf inference follows the agreed old-stock/new-stock threshold. Restock batches now learn store-specific opening-hours averages, confidence, and arrival-day patterns. Railway schedules approaching-time inbox events from forecasts and per-account drive estimates. Store hours are captured directly from the inventory response (`hrsMon`–`hrsSun`). Trips suggest an editable one-way order, check Apple Maps drive times and arrival warnings, save privately, and hand off to Apple Maps. The physical iPhone client uses a Secure Enclave signing key and device-only Keychain session storage.

**APNs, App Attest, TestFlight distribution, and payments are later milestones.** This build refreshes while open and retrieves missed alerts on reopening. It does not send phone push notifications.

## Start here

1. [Upgrade your existing Railway service](docs/MILESTONE_4_UPGRADE.md).
2. [Open the project and run it in Xcode](docs/XCODE_TESTING.md).
3. Set the HTTPS URL in `ios/Takeoff/AppConfiguration.swift`, choose your Personal Team/bundle ID, and run the **Takeoff** scheme on your iPhone.

Open **`ios/Takeoff.xcodeproj`** directly. There is no blank-project setup or package installation step for the app.

## Included source

| Folder | Purpose |
| --- | --- |
| `backend/` | Node 24 API, Discord access, persistent SQLite data, DG worker, curated catalog, tests and deployment files |
| `ios/` | SwiftUI app, Xcode project, assets, request-signing/callback XCTest cases |
| `docs/` | Railway upgrade, Xcode guide, agreed milestones and validation notes |

Install **Node.js 24.x** and run the backend checks:

```sh
cd backend
node --version
npm ci --ignore-scripts
npm test
```

The backend pins `geo-tz` and `@js-temporal/polyfill` for store timezones and calendar arithmetic; Railway installs them during the Docker build. If Node says `bad option: --test`, the Terminal is still using an old Node installation; fix that version before continuing. Xcode uses Swift and does not need Node to compile the app.

## References and validation

- [API contract](backend/API.md)
- [Fresh backend setup and recovery](backend/SETUP.md)
- [Security boundaries](backend/SECURITY.md)
- [Approved milestones](docs/PRODUCT_PLAN.md)
- [Validation and remaining device checks](docs/VALIDATION.md)

The inventory-hours fix is tested against the public store fields supplied by the owner. Backend checks cover schema upgrades, signed trip endpoints, route eligibility, private persistence, and deduplicated trip-change events. Swift grammar was checked; Xcode compilation, live MapKit estimates, and multi-stop handoff still need the owner's iPhone test. See the upgrade guide. This update has not been pushed or deployed to your running service.

Keep the app's source in a private repository. The original monitor's public Git history contained session credentials; use fresh DG values in Railway and transfer sanitized files without that old Git history. The root `dgMonitor.js` remains the separate legacy Discord monitor. After validating the app worker, stop the old monitor as described in the upgrade guide.
