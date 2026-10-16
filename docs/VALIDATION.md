# Milestone 3 validation

Validated in a Linux workspace using **Node.js 24.19.0**. No running Railway service was changed. The owner reports the Milestone 2 iPhone login, saved settings, observed quantities, private/moderator note permissions, favorites, and redeployment persistence passed. Stock-down inbox events worked; the missing increase happened while monitoring was off.

## Completed automated checks

**74 backend tests pass**, including all previous account/security/API/recovery checks. From `backend`:

```sh
npm ci --ignore-scripts
npm test
```

Milestone 3 coverage includes:

- The original available/new-stock threshold sequence; the new-batch timer ends at 12→11, not while older available units sell down from 15 to 12.
- Separate batch records, overlapping-delivery exclusion, missing/changed hours, monitoring gaps, stock-up preferences, sold-out first-sale sampling, cross-product store averages, and retained aggregates after detailed history expires.
- Closed overnight hours, short holiday hours, date-specific closures, split shifts, actual spring/fall daylight-saving changes, invalid schedules/timezones, ambiguous DST boundaries, and exact-closing predictions moving to the next opening.
- The approved 2 PM prediction / 20-minute drive / 1:35 PM warning; unchanged or revised predictions cannot duplicate a previously sent warning across restarts. Passing a prediction never turns yellow stock green.
- Suppression after a sale, exclusion, disabled toggle, missing drive estimate, insufficient confidence, stale coverage, changed schedule, or a late scheduling opportunity. Pause retains eligible inbox events.
- Signed HTTP travel-estimate endpoints reject anonymous/copied-token requests, injected owner IDs, changed ZIPs, and changed coordinates. Another account cannot read the saved estimate or receive its warning.
- Address enrichment for old inbox rows and address fields on new rows.
- Store-hours fetching runs independently of inventory polling, caches results, and invalidates unrecognized schedules without converting inventory to zero.
- A frozen snapshot of the delivered schema 2 upgrades to schema 3 with a functioning pre-upgrade login, settings, notes, favorites, inventory, and history. No old pending stock is invented as a timing sample. A pre-upgrade schema 2 backup still passes safe restore preparation and invalidates old sessions.

The actual `src/main.js` entry point was started against a temporary database with monitoring disabled. Both health endpoints and graceful SIGTERM shutdown passed without external provider calls. JavaScript syntax, Swift grammar parsing, and Git whitespace checks passed. The unchanged Xcode project already includes every edited Swift file; no new native source membership or entitlement is needed.

The modified existing app files and core inventory/monitor source in the connected `takeoff-app` repository were compared with the delivered Milestone 2 base before packaging; those checked files matched. Files containing local signing/environment/catalog choices are excluded from the incremental update.

## Native checks included, not run here

The existing `TakeoffTests` target now contains six XCTest cases: signed-request interoperability, callback validation, stale-data shelf status, partial settings encoding, prediction decoding without a shelf-state change, and old inbox decoding. Run **Command-U** on an iPhone simulator. They do not sign in or call Railway.

**Swift syntax parsing is not an Xcode compiler or SDK type check.** No Xcode, iOS SDK, or physical device is available in this workspace. The updated SwiftUI views, foreground MapKit ETA requests, background cancellation, saved estimates, and display contrast require the owner's Mac/iPhone run.

## Remaining live checks and limits

- **DG hours response:** DG's public directory code confirmed `/omni/api/store/info/{id}` and the `storeinfo` envelope. The authenticated field shape was not available here. Tests use synthetic provider schedules, not a captured successful live hours response. Confirm one real store's hours; if normalization fails, run the read-only `npm run inspect-hours -- STORE_NUMBER` diagnostic in Railway and adapt the parser to that public hours format. No usable schedule means no fabricated forecast.
- **Real learned timing:** existing M2 stock/history remains intact, but old elapsed-time averages and unfinished M2 batches are not training data. New clean observations must accumulate before estimates/warnings become useful. Confidence is a sample-count/variability/recency heuristic, not a statistically calibrated probability or an independent-truck count.
- **Drive estimates:** the free build uses account-specific Apple Maps estimates obtained while the app is active. The server expires them after 24 hours. Traffic changes, Maps throttling, missing coordinates, or a newly discovered destination with no estimate can suppress departure warnings. No paid server routing account was configured.
- **Deployment:** the Dockerfile now installs pinned dependencies. An actual Docker/Railway build must occur in the user's deployment. The same persistent volume and one replica remain required.
- **Capacity:** the 100-user target was not load-tested. Provider quota/latency, unique ZIP/product coverage, geocoding and hours availability, SQLite load, and foreground Maps throttling affect operation. Normal cadence is not a throughput guarantee.
- **Notifications:** eligible missed alerts are persisted to the inbox. No APNs, App Attest, TestFlight, multi-store route planner, or membership payments are implemented by this update.

Use [MILESTONE_3_UPGRADE.md](MILESTONE_3_UPGRADE.md) for file merge, backup, Railway, Xcode, diagnostics, and live acceptance steps.
