# Milestone 4: trips and inventory-hours fix

This is an incremental update for your working Milestone 3 app. It fixes the actual DG inventory hours format and adds saved, editable trips with Apple Maps handoff. Your four earlier interface changes remain in place.

## 1. Back up the existing Railway database

From the Mac folder linked to your API service:

```sh
railway status
railway ssh
```

Inside the **existing Takeoff API service**, run:

```sh
cd /app
npm run backup -- /data/before-milestone-4.sqlite
exit
```

Back on your Mac:

```sh
mkdir -p ~/TakeoffBackups
chmod 700 ~/TakeoffBackups
railway service files download /data/before-milestone-4.sqlite ~/TakeoffBackups/before-milestone-4.sqlite
chmod 600 ~/TakeoffBackups/before-milestone-4.sqlite
```

Use another filename if it already exists. Keep the database outside GitHub. Recovery and `prepare-restore` instructions are in [backend/SETUP.md](../backend/SETUP.md).

## 2. Merge the update into your existing repository

Extract `takeoff-milestone-4-update.zip` in Downloads. Open Terminal and `cd` to your existing app repository, containing both `backend` and `ios`. Confirm the paths, then merge:

```sh
pwd
ls backend/package.json ios/Takeoff.xcodeproj/project.pbxproj
rsync -av ~/Downloads/takeoff-milestone-4-update/ ./
```

Only merge once those two paths are found. This is a partial update: use `rsync` to merge files, rather than Finder's Replace Folder action. If you changed other source files yourself after Milestone 3, review those differences before overwriting them.

The package omits `AppConfiguration.swift`, the Xcode project, `Info.plist`, product catalog, `.env`, databases, Git history and dependencies. Your Railway URL, signing settings, catalog and secrets stay where you configured them. There are no new native file-membership steps: the Trips view/model types are in existing target files. The complete manifest is [MILESTONE_4_FILES.md](MILESTONE_4_FILES.md).

## 3. Test and deploy the backend

From the repository:

```sh
cd backend
node --version
npm ci --ignore-scripts
npm test
```

Use **Node 24.x**. Commit/upload the supplied backend files to your existing deployment branch. Reuse the same Railway API service, `/backend` root, one replica and attached `/data` volume. No new credentials, environment variables, paid APIs or services are needed. Keep the current DG session variables and `DG_MONITOR_ENABLED=true`.

Logs should show **Takeoff API v0.4**. The existing `/health/ready` URL should return `{"status":"ready"}`. Startup adds schema 4's private trip table transactionally; existing settings, notes, logins, quantities and timing data remain. A healthy process alone does not verify a successful DG poll.

Do not run older backend code against schema 4. If rollback is necessary, use the protected pre-upgrade backup and offline restore preparation. Restore preparation revokes old sessions as described in the recovery guide.

## 4. Rebuild the iPhone app

1. Open your existing `ios/Takeoff.xcodeproj` in Xcode.
2. Keep the Takeoff scheme, Personal Team, bundle identifier and your connected iPhone selected.
3. Press **Command-R**. Keep the installed app; no new target, capability or Swift package is required.
4. Confirm the new **Trips** tab appears.
5. For the ten included native checks, select an iPhone simulator and press **Command-U**. The tests do not log into your account or transfer phone access.

If Trips says Update Railway after the backend update, close and reopen the app to reload its capabilities. Full Maps route handoff uses iOS 18.4 or later, which includes your iPhone on iOS 26.2. On older supported iOS versions, the button opens just the first stop.

## 5. Verify the hours fix

Wait for a successful inventory poll, then reopen a store from Discover. Expand **Restock timing → Regular store hours**. The provided examples should display:

| Store | Address | Regular hours |
| --- | --- | --- |
| 14838 | 19718 Fisher Ave, Poolesville | 08:00–22:00 daily |
| 18669 | 12619 Wisteria Dr Ste J, Germantown | 08:00–21:00 daily |

Only check these if they belong to an already monitored area; this update does not add monitoring coverage for them. The backend reads `hrsMon`–`hrsSun` directly from the same inventory response and uses the store coordinate to resolve `America/New_York`. Hours are cached before a newly observed stock increase is recorded, so that batch can use them immediately. There is no separate `/store/info` worker.

If a covered store still shows unavailable hours, run this inside the Railway API shell with its real store number:

```sh
cd /app
npm run inspect-hours -- 14838
```

The diagnostic now reads the captured schedule from SQLite without making another DG request. It prints the public schedule, freshness, coordinate availability and any parser error. `waiting_for_inventory_hours` means no schedule-bearing poll has reached this store; `unrecognized` means the supplied schedule was incomplete/invalid. Do not delete the database or reset learned samples to fix hours.

Old batches that started without usable hours remain excluded from clean timing samples. Valid hours help new observations; they do not reconstruct a missed arrival. Unknown formats remain unavailable rather than being treated as all-day opening. Published exceptions are applied only when returned in recognized special-hours fields.

## 6. Plan and edit a trip

1. Open **Trips** and choose all followed items or one specific followed item.
2. Tap **Suggest a route**. The first suggestion uses up to ten nearby, nonexcluded stores with fresh likely-for-sale stock.
3. Keep Takeoff open while it checks each drive with Apple Maps. The start is the saved ZIP center. Each later arrival allows five minutes at the preceding stop.
4. Use **Remove stop** or **Add stop**. Either action recalculates the order and drives. Optional back-stock stops must have medium/high-confidence forecasts ready by their estimated arrival; they still display a warning and stay yellow.
5. Review the numbered map, addresses, arrivals and warnings. A closed-at-arrival, sold-out, unknown or stale stop blocks saving. Remove a warned stop and recalculate. If otherwise available stock has missing hours, the app warns you to check the store.
6. A valid route saves privately to your account. An unsuccessful edit remains an **Unsaved draft**; the prior saved route is retained. Discard the draft to return to it.
7. Tap **Open route in Apple Maps**. Takeoff checks current server eligibility again, then sends the saved ZIP start, ordered intermediate stops and final destination. Confirm the stop order in Maps before starting.

The route ends at the final store. The suggested order uses geographic distance with local improvements; Apple Maps estimates the actual road travel afterward. It is not an exhaustive traffic-aware fastest-route solver. The ten-stop cap keeps the free pilot's routing work bounded. The in-app map marks the visiting order; Apple Maps supplies navigation.

Driving estimates must be recalculated after 15 minutes. Maps can throttle requests; if that happens, wait a few minutes and recalculate. Unknown road estimates are never replaced with invented driving times. Each recalculation starts from the saved ZIP center, including during a trip; this version does not track your position or automatically mark visited stores.

## 7. Trip changes and alerts

The server watches the saved trip for 12 hours after its departure time. Meaningful changes to selected-product shelf status, eligibility or a forecast by at least five minutes can add a **Your trip stop changed** inbox event. Repeated checks/redeploys do not repeat an unchanged event. **Settings → Alerts & pause → Trip changes** controls these events; it defaults on. Pause keeps eligible inbox events. Exclusions, current products, saved ZIP and account access are respected.

The app refreshes while active and catches up on reopening. Return to Trips, review changes, and replan when needed. The server cannot rewrite a route already being navigated in Apple Maps. Clear an outdated/finished trip when you are done. APNs phone pushes still belong to Milestone 5; the free local build has inbox alerts.

## Why a decrease after an outage can remain unknown

Yes: if the monitor missed the initial increase, it has no tracked pending-new-stock threshold. A positive first/restarted observation becomes an unknown baseline. A later fresh decrease may create an ordinary Stock decreased event when enabled, but the stock stays gray. A clean observed increase and qualifying decrease are needed to mark the new batch likely for sale and measure its restock time. A fresh zero remains sold out. No historical arrival or sample is invented from the outage.

## Live acceptance checks

- Verify a real store's regular hours against its inventory response and confirm the overnight exclusion on a subsequent clean batch.
- Build a route with two or three available stores. Compare the displayed order and drive estimates with Maps.
- Add/remove a stop; confirm the saved route adjusts, ends at the last store, and returns after relaunch/redeploy.
- Verify all ordered stops reach Maps. Also test ten stops when enough eligible stores exist.
- Check a forecast-based yellow stop, a closed-at-arrival stop, and a stop that becomes unavailable before handoff. Unsupported cases should warn/block.
- Confirm another allowed account cannot read this saved trip. Turn Trip changes off, then on; verify behavior on a natural change and across redeploys.

The code and automated checks were prepared here. No running Railway service was changed, and no Xcode/device/MapKit handoff test was possible in this Linux workspace.

References: [Apple unified Maps URLs](https://developer.apple.com/documentation/mapkit/unified-map-urls), [iPhone multistop directions](https://support.apple.com/guide/iphone/change-or-add-stops-to-your-route-iph837d13d03/26/ios/26), [full Xcode guide](XCODE_TESTING.md).
