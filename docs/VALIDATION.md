# Milestone 4.1 validation

Checked in Linux with Node.js 24.19.0. **103 backend tests passed.** The owner supplied the actual DG inventory hours shape, which is now covered by regression tests. No running Railway service was changed.

## Completed checks

- `hrsMon`–`hrsSun` compact times from the supplied Poolesville/Germantown response normalize to their correct daily hours and `America/New_York` timezone. Closed overnight time is excluded. Partial, malformed, out-of-range and ambiguous times cannot fabricate a schedule or turn stock into zero.
- Hours arrive in the normal inventory ingestion transaction before a new batch starts; that batch can train a clean timing sample. The separate store-info worker was removed. The read-only diagnostic inspects captured hours without a DG request.
- Any observed decrease with units remaining becomes available, including a positive baseline or a lower live quantity across a gap, without fabricating a timing sample. Green expires exactly seven days after the latest decrease even while successful unchanged polls continue. Zero, stale data, and pending-batch expiry keep their distinct states. Existing recent M4 decrease records are repaired without replaying events.
- Removing the last subscriber removes an area from covered lists and stops polling, including discarding an in-flight response. Active overlap remains visible; private notes, favorites and cached rows survive.
- Explicit finite device origins drive trip order and the first road leg, without changing the monitored ZIP. Missing/invalid origins are rejected; older saved ZIP-origin routes require recalculation.
- Trip suggestions start with fresh likely-for-sale stores and return a deterministic open route. Back-stock candidates need medium/high-confidence estimates no later than measured arrival and keep their warning/yellow shelf state.
- Successive road legs and five-minute stop allowances produce the expected arrival times. Invalid measurements, stale departure times, repeated stores, injected owners and unapproved products are rejected.
- Sold-out, unknown, stale, excluded, monitoring-disabled and closed-at-arrival cases cannot save or hand off a trip. Road estimates expire for handoff after 15 minutes.
- Saved trips and private notes stay account-specific and survive database reopen. Optimistic versions reject old edits and prevent an old request from reviving a cleared plan.
- Signed HTTP trip endpoints reject anonymous access and copied-token requests; one account cannot clear another's trip. Existing request-signing, session/replay/recovery and moderation tests continue to pass.
- Trip-change events deduplicate across sweeps and restart, respect the global switch and pause behavior, and stop when a plan is cleared. The existing stock/inbox events remain independent.
- Schema 3→4 adds the trip table while retaining sessions, settings and hours. Existing frozen schema 2 migration/recovery tests also pass against the latest schema.
- Existing DST, holiday, split-shift, new-stock threshold, overlapping-delivery, forecast confidence, 1:35 PM departure-warning, privacy and retention tests remain in the suite. The obsolete independent store-info worker test was replaced by the inventory-hours integration test.

JavaScript syntax, Swift grammar parsing for all 15 Swift files, and Git whitespace checks passed. All Swift changes use existing Xcode target members, so the incremental update does not replace the project/signing configuration.

## Native tests included, not executed here

The existing `TakeoffTests` target contains **11** tests. In addition to the six previous protocol/model tests, these check ordered Maps waypoints with a current-location start and one-way destination, seven-day signal expiry, invalid/oversized route rejection, backward-compatible alert settings, and trip-preview request encoding. Run Command-U on an iPhone simulator.

Swift grammar parsing does **not** compile or type-check against SwiftUI, MapKit or the iOS SDK. Xcode and a physical iPhone are not available in this workspace. The Trips view, real MapKit travel responses, Maps throttling/cancellation and multi-stop handoff require the owner's Mac/iPhone run. Apple's unified Maps URL documentation was checked; the on-device behavior is not claimed as verified.

## Remaining live checks

1. Deploy to the same Railway service/volume and verify a fresh inventory poll displays real regular hours in store details.
2. Build in Xcode and run the 11 native tests. Verify the new Trips tab.
3. Suggest a two- or three-stop trip, add/remove stops, compare driving times and confirm Maps receives the intended order. Check the ten-stop cap on device when enough stores are eligible.
4. Compare closed-at-arrival and forecast-based yellow-stop warnings with observed conditions. Forecasts remain inferences.
5. Verify live trip-change inbox behavior, private ownership, and persistence after deployment/relaunch.

Suggested order minimizes geographic distance heuristically, not a proven globally optimal driving-time route. The pilot requests a fresh foreground location for each plan, assumes five minutes at earlier stops, and does not continuously track location or automatically advance visited stops. Denial/approximate/old fixes should block with a clear explanation; the permission dialog must not cancel the task. Verify these paths and the 250-meter movement check on device. Apple Maps owns an exported route and Takeoff cannot edit it afterward.

There is no APNs, App Attest, TestFlight, payment integration, Docker build or 100-user load test in this validation. Device-reported road estimates affect only the owner's route; they do not update the shared stock/restock model. See [MILESTONE_4_1_UPGRADE.md](MILESTONE_4_1_UPGRADE.md) for deployment, Xcode, diagnostics and live acceptance steps.

The update archive is checked against its file manifest and preserves API configuration, signing settings, Info.plist, catalog, secrets and databases. The location purpose text must be edited as directed in the guide. Calendar and community proposals are documentation only.
