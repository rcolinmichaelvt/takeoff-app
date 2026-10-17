# Takeoff 0.4.1: current-location trips and stock/coverage fixes

This update follows Milestone 4. It implements only the four requested changes. Calendar events, community reports and other retailer features are proposals in [FUTURE_FEATURES.md](FUTURE_FEATURES.md), not implemented features. Paid Apple membership can wait.

## Apply the files

Download and unzip `takeoff-milestone-4-1-update.zip`. Merge its contents into your existing app repository, replacing matching files. Do not replace an entire folder in Finder: keep existing files not present in the update. From the repository root you can use:

```sh
rsync -av ~/Downloads/takeoff-milestone-4-1-update/ ./
```

Adjust the Downloads path if you extracted elsewhere. The package preserves your API URL, signing project, Info.plist, catalog, secrets and database. The APIClient POST-body fix is included. See [MILESTONE_4_1_FILES.md](MILESTONE_4_1_FILES.md) for the exact files.

## Update Railway

Use the same API service and `/data` volume. No new service, variable, credential, paid API or database schema is required; schema remains 4. Retain the current DG monitoring settings and one replica.

Before deployment, use your existing Railway API shell to make a backup on its real volume:

```sh
cd /app
npm run backup -- /data/before-0-4-1.sqlite
```

Use a different filename if that exists and retain a protected off-service copy with your existing backup workflow. Do not run this on your Mac expecting it to back up Railway. Recovery procedures remain in [backend/SETUP.md](../backend/SETUP.md).

On your Mac, from the repository root, run with Node 24:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend test
```

Commit/upload the supplied backend files to your Railway deployment branch and deploy. Check for **Takeoff API v0.4.1** in startup logs. Deploy the backend before running the updated app: new trips now require a current-location origin, so use the new iPhone files with this backend.

Recent positive-quantity decrease records that the older version left unknown or yellow are reclassified on startup if the latest history entry provides that evidence. This does not replay alerts or invent timing samples. Older/missing history and an intervening recorded monitoring gap are not reconstructed. Wait for a fresh poll before judging live labels.

## Rebuild in Xcode

1. Open the existing `ios/Takeoff.xcodeproj`. Keep your Takeoff scheme, Personal Team, bundle ID and connected iPhone.
2. Update one existing property without replacing your Info.plist: select the blue project icon → **TARGETS → Takeoff → Info**. Find **Privacy - Location When In Use Usage Description** (`NSLocationWhenInUseUsageDescription`) and set its value to:

   > Use your location to choose a ZIP and start trips from where you are. Your monitored ZIP stays fixed. Trip starts are saved privately with your route.

3. Press **Command-R**. No new target, capability, source-file membership or Swift package is needed. The location helper is inside the existing LocationPicker.swift file.
4. In Trips, tap **Recalculate** for an old route or **Suggest a route** for a new one. Allow location access while using the app. If previously denied, use **iPhone Settings → Apps → Takeoff → Location → While Using the App**, with Precise Location enabled.
5. To run the 11 native protocol checks on your Mac, select an iPhone simulator and press **Command-U**. For manual simulator trips, supply a simulated location; a simulator does not have a real GPS position.

New routes and every add/remove/recalculate action request a single location reading. The saved ZIP and its 25-mile monitoring area remain fixed. Denied, timed-out, old or excessively approximate readings produce an explanation, with no ZIP-center fallback. The app does not track location continuously or in the background.

Apple Maps starts navigation from its current location. Before handing off, Takeoff checks location again; moving more than 250 meters from the planned start requires Recalculate so arrival times and stop order are checked again. This is still an open route with no return to the start. Store-detail distances and scheduled departure alerts remain based on the saved ZIP; this change applies to Trips.

## Changed stock rule

| Situation | Display |
| --- | --- |
| First positive baseline, no observed decrease | Unknown |
| Positive quantity decreases and some remains | Green: Likely in stock, even if the increase was missed |
| A lower positive live quantity is first seen after an outage | Green; the interrupted interval is excluded from restock timing |
| Another decrease occurs | Refresh the seven-day sale-signal deadline |
| Unchanged polling or an increase | Does not refresh that deadline |
| Seven days pass without another decrease | Remove green; unknown, or yellow if all remaining units are tracked pending stock |
| A successful observation reaches zero | Red: Sold out |
| Coverage ends or observations become stale | Gray: Unknown; retain the last quantity |

Stock remaining at the old-stock/new-stock threshold now stays green after a decrease, as requested. The pending-new-stock counter still runs underneath it: the restock average completes only when quantity falls below that threshold. A baseline decrease can establish availability without fabricating a truck-arrival time. Expiry is enforced when the server reads inventory and by the iPhone while displaying a cached green signal.

This changes the availability label, not your alert switches: ordinary decreases use Any decrease, qualifying new-stock decreases use First decrease, and a zero uses Sold out.

## Coverage and store details

Only allowed accounts' saved ZIP/product selections create monitoring jobs. Identical subscriptions remain shared. Once the final selection disappears, the worker removes that job on reconciliation; a request already in flight is discarded if nobody still subscribes. Cached geography, quantities, private notes and favorites remain in SQLite.

All covered areas (including its favorites query) lists only stores connected to a currently subscribed ZIP/product pair. Another user's overlapping active area can keep a store visible. An active area temporarily missing polls can still appear gray. Stored notes/favorites return when that store is actively covered again. Direct saved store details can still show old data as unknown.

Store details retain weekly hours, relevant increase/decrease dates, predictions and stale-data explanations. They no longer display the timezone, last-check timestamp, hours-update timestamp or drive-estimate-update timestamp. The server still uses timezone and freshness internally.

## Quick device checks

- Build a two-stop trip while somewhere other than your ZIP center. Check the start marker, first drive and Maps start. Recalculate at another location; your monitored ZIP should stay unchanged.
- Deny location and try a route. It should explain the permission issue. Grant access and retry; the first permission dialog should not cancel planning.
- Open store details and expand Regular store hours; no timezone or update-time line should appear.
- After a real positive decrease, check for Likely in stock even without a recorded increase. Automated checks cover the seven-day boundary without waiting a week.
- Switch the last account out of a ZIP. Its unique stores should disappear from All covered areas, and monitor jobs should stop. Overlap supported by another account should remain.

103 backend checks pass in Linux. Swift grammar checks pass; Xcode type checking, signing, permission dialogs, physical location and Apple Maps handoff still require the Mac/iPhone checks above. No live Railway service was modified here.

The free build continues to use foreground refresh and an inbox. Remote APNs delivery and TestFlight are deferred until you choose paid membership. See [Apple's account overview](https://developer.apple.com/help/account/basics/about-your-developer-account) and [membership details](https://developer.apple.com/programs/whats-included/).
