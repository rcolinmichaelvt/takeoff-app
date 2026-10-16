# Takeoff: agreed product and milestones

This plan records the decisions made before implementation. Features described here are requirements unless marked delivered; this file does not imply they already exist in the code.

## Milestones

| Milestone | Deliverable | Acceptance target | Current state |
| --- | --- | --- | --- |
| 1. Backend foundation | Persistent storage, Discord allowlist, signed sessions, one installation, six-hour transfers, catalog/inbox API, backups | Automated auth/recovery checks pass; then real Railway/Discord check | Backend delivered; owner reports Railway is set up |
| 2. First iPhone app | SwiftUI project, sign-in, ZIP/product settings, map/store details, favorites/exclusions, private/public notes, history/inbox; supporting inventory API | Run on the owner's iPhone against Railway; accurate unknown/freshness labels | Owner reports iPhone sign-in, quantities, notes, privacy, favorites, and redeploy persistence passed; missed increase occurred while monitor was off |
| 3. Inventory intelligence | New-stock batch tracking, opening-hours timing, store averages, confidence, patterns, approaching-time events | Agreed threshold examples and store-hours cases pass; compare with live observations | Source implemented; inventory hours now verified against the owner-supplied response; device/live learning checks remain |
| 4. Trips | Suggested stop order, editable routes, arrival warnings, Apple Maps handoff, trip-change handling | Device-tested road estimates and Maps handoff | Source implemented; backend checks pass; Xcode/physical Maps handoff pending |
| 5. Notifications and beta | APNs, device push revocation, App Attest, TestFlight preparation | Physical-device push/revocation and beta testing using paid membership | Planned |

Local app tests can use foreground refresh and the server inbox before Milestone 5. No target date is set. Roughly 100 eventual users is a planning target, not a load test result.

## Location, products, and shared coverage

Each user saves one US ZIP code with a fixed 25-mile radius. Resolve it to a center coordinate on the server. Current location is an optional picker for that ZIP, not continuous tracking. Moving the phone does not silently move the monitored area. Forecast alert driving estimates start from the saved ZIP center.

The operator maintains approved UPCs and titles. Users choose any number of the listed products; they do not type arbitrary titles/UPCs into the app. The catalog begins with the active items in the current DG monitor. No announcements editor or admin dashboard is being built now.

Monitor only areas and products supported by active users' selections. Deduplicate identical ZIP+UPC polls and share store/product snapshots across overlapping regions. Distinct ZIP centers still need their own area queries; unchanged observations do not create duplicate alerts. Members can browse already-covered areas, including coverage created by another member; their own alerts follow their ZIP/product settings. When coverage loses its final subscriber, stop its extra polling and mark old observations stale. Do not imply stale data is current stock.

Retain the existing nominal polling cadence: every three minutes normally, every ten seconds for qualifying recently increased products for up to 72 hours while stock remains, with staggered work. Preserve timeout, error handling, and provider backoff. A provider error is never a zero-stock observation. Multi-area load and any upstream constraints need measurement before a broader rollout.

## Inventory inference

Stock increases indicate scanned-in stock, generally still in the back. A qualifying first decrease indicates that the newly arrived stock is likely being sold. This is an inference, not direct confirmation from a shelf sensor.

When an increase arrives while older stock is already available, older sales do not count as the new batch reaching the floor. The accepted example is:

| Observation | Interpretation | Color |
| --- | --- | --- |
| 3 already available, then +12 → 15 total | Older stock remains available; new batch pending | Green |
| 15 → 14 → 13 | Older stock is selling; new batch unconfirmed | Green |
| 13 → 12 | Older available quantity exhausted; new batch unconfirmed | Yellow |
| 12 → 11 | Quantity crossed the new-batch threshold; new stock is selling | Green |
| A fresh successful observation reaches 0 | Sold out | Red |

The restock timing sample runs from the **new increase** until the first qualifying sale of that new batch. It does not stop on a decrease that merely consumes older available stock. Multiple deliveries, missed observations, and monitoring gaps must retain uncertainty rather than inventing a clean timing sample.

Early monitoring with stock already present has an unknown shelf state: use gray and wording such as “Availability unknown—monitoring started recently.” Old cached observations are also not evidence of present availability. Show quantities separately from inferred shelf status.

## Store timing and predictions

Use store-specific timing pooled across products. Count only the store's opening hours between the increase and qualifying sale; exclude closed overnight time. Retrieve and interpret each store's schedule and timezone, including date-specific changes when the source provides them. Missing/invalid schedules must lower confidence or suppress a prediction instead of assuming the store is always open.

Record sample count and confidence and show restock patterns. Historical averages based on wall-clock time cannot silently become business-hours averages. One week of detailed history is visible to members; store-level model aggregates can be retained separately to learn longer-term patterns without exposing older detailed histories.

The approaching alert time is:

```text
predicted shelf time − estimated drive from saved ZIP center − 5 minutes
```

For a 2:00 PM prediction and a 20-minute drive, notify at **1:35 PM**. This is the approved departure warning. Do not also send a separate average-reached notification. Passing the predicted time does not turn a yellow store green: show “Expected ready—unconfirmed” until a qualifying decrease arrives. Prediction updates, stock changes, and alert deduplication must be handled by the server; timing is an estimate, not a guaranteed notification-delivery deadline.

## Map and store details

Map filters cover all items, specific selected items, and all stores. Tapping a store pin shows that store's products with individual states: yellow for inferred back stock, green for likely available stock, red for observed sold out, gray for unknown/stale status. Use text and symbols as well as color.

Store details include address, phone number, distance, driving time when available, freshness, and relevant last increase/decrease timestamps. Add favorites and excluded stores. User notes are private; moderator notes are visible publicly to authorized members. A moderator role is assigned by Discord ID. No admin control panel is included now.

## Notifications and history

Default-on events are qualifying decrease after increase, sold out, and approaching the predicted departure time. Other supported event types can be toggled. Include a pause-notifications control, no per-store notification settings, and no custom grouped digest. Keep missed alerts in the app inbox for one week. The new app sends no Discord notifications after monitoring cutover.

APNs notifications will originate from server changes. The free local build can show fresh results while open and retrieve missed events when reopened, but cannot receive real APNs pushes with a Personal Team. Local scheduled reminders are optional test behavior and cannot reliably reflect later server changes while the app is closed.

## Routes and trip changes

Start with stores having stock likely for sale. Suggest an efficient one-way order, without returning to the starting point. Let users add and remove stops and recalculate. Back-stock stops are eligible only when predicted ready by arrival and must carry a warning. Do not add sold-out stores.

Plan the route inside Takeoff and hand it to Apple Maps. The first implementation caps trips at ten stops, allows five minutes per earlier stop, and uses the documented unified Maps URL on iOS 18.4+. The ten-stop handoff still requires the target iPhone check. Earlier iOS versions open only the first stop. “Suggested efficient order” does not promise a mathematically optimal route for an unlimited number of stops.

When a planned stop changes, update the trip in Takeoff and notify according to the user's settings/capabilities. The user can return to replan and hand off an updated route. Do not promise automatic mutation of a route already being navigated in Apple Maps.

## Access and release scope

Users sign in with Discord. Begin with a server-side ID allowlist. One active installation is permitted per account; moving access revokes the old installation, with six hours between transfers. No payment integration is needed yet.

Build iPhone-only with SwiftUI and test locally first against Railway. Personal Team is the initial signing setup. The paid-developer milestone adds real remote notifications, stronger application attestation, and TestFlight distribution. Keep DG credentials and monitoring logic on the server.

Deferred: Whop/payment entitlements, announcements and Pokémon update publishing, CVS/Walgreens monitoring, availability reports for retailers such as Target, and admin controls. Barcode scanning is excluded. Additional product ideas require the owner's approval before implementation.

## Milestone 4 implementation choices

Trips start at the saved ZIP center, use selected followed products, and consider fresh stores within that area. Suggestions start with likely-for-sale stores, using nearest-neighbour ordering and bounded 2-opt improvement by geographic distance. Sequential MapKit road estimates check the resulting route; this is not a guarantee of the fastest road route. Optional back-stock stops need medium/high confidence and a predicted time no later than road arrival. Closed-at-arrival stops block saving; missing hours on an otherwise available store produce a warning.

One active trip is stored privately per account, with version checks against stale edits. Editing or recalculating starts a new plan from the saved ZIP, without GPS tracking. Estimates expire for handoff after 15 minutes. The server watches meaningful stop changes for 12 hours after departure, under the Trip changes switch (on by default); pause retains inbox events. A completed/outdated route can be cleared. A valid saved trip remains until replaced or cleared.

Hours come from `hrsMon`–`hrsSun` in normal inventory responses; no separate store-info poll runs. Missing/invalid hours cannot produce invented samples. A fresh decrease after an unknown startup/resume baseline stays unknown, because no new-batch threshold was observed. It may create an ordinary decrease inbox event if enabled, but does not train a restock sample.
