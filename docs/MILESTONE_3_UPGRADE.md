# Upgrade Takeoff to Milestone 3

This update adds persistent restock batches, opening-hours timing, store averages and arrival-day patterns, confidence, and departure-warning inbox events. It also makes the Discover ZIP a plain label, shows addresses in the inbox, and removes the Discord ID and radius from Settings. The monitoring radius remains 25 miles on the server.

Your reported Milestone 2 checks passed for sign-in, settings, quantities, private/moderator notes, favorites, and persistence across redeploys. The missed stock-up alert happened while monitoring was off. After a gap longer than nine minutes, the resumed quantity becomes a new baseline rather than a retroactive stock-up event. A backup is for recovery; it does not control alert detection.

## 1. Back up the currently deployed database

In Mac Terminal, from the folder linked to your existing Railway API service:

```sh
railway status
railway ssh
```

Confirm this is the API service, not the old Discord monitor. Inside Railway:

```sh
cd /app
npm run backup -- /data/before-milestone-3.sqlite
exit
```

Back on your Mac:

```sh
mkdir -p ~/TakeoffBackups
chmod 700 ~/TakeoffBackups
railway service files download /data/before-milestone-3.sqlite ~/TakeoffBackups/before-milestone-3.sqlite
chmod 600 ~/TakeoffBackups/before-milestone-3.sqlite
```

Use a new filename in both commands if it already exists. Keep this protected copy outside the repository. The consistent SQLite backup includes committed WAL changes. Do not upload the database to GitHub.

## 2. Merge the update into your existing project

The **update ZIP contains changed/new files**, not a second standalone app. Extract `takeoff-milestone-3-update.zip` in Downloads. In Terminal, `cd` into your **existing Takeoff app repository** (the folder that contains both `backend` and `ios`), then run:

```sh
pwd
ls backend/package.json ios/Takeoff.xcodeproj/project.pbxproj
rsync -av ~/Downloads/takeoff-milestone-3-update/ ./
```

Only run the merge after the two file paths above are found. `rsync` copies the supplied files into the existing folders without deleting other files. Avoid Finder's “Replace folder” action on this partial update. If your downloaded folder is elsewhere, substitute its actual path.

The update omits `AppConfiguration.swift`, the Xcode project, `Info.plist`, catalog, live `.env`, database, and Git history. Your Railway URL, signing Team, bundle identifier, catalog edits, and credentials remain where you configured them. If you made other source edits after Milestone 2, review your Git diff before merging this update.

Files updated are listed in [MILESTONE_3_FILES.md](MILESTONE_3_FILES.md). All Swift changes are in files already included in the project; no new Xcode groups, capabilities, or Swift packages are needed.

## 3. Check locally, then deploy the existing API service

The backend now has two pinned dependencies for timezone lookup and calendar arithmetic. From your existing repository:

```sh
cd backend
node --version
npm ci --ignore-scripts
npm test
```

Use Node **24.x**. The Dockerfile now runs `npm ci --omit=dev --ignore-scripts` during the Railway build, so upload `package.json`, `package-lock.json`, and `Dockerfile` together with the source. Do not upload `node_modules`.

Commit/upload the supplied changed files to your app repository's deployment branch. Reuse the same API service, `/backend` root, `/backend/railway.toml`, Dockerfile builder, one replica, and attached `/data` volume. Keep `DG_MONITOR_ENABLED=true`, the existing DG session variables, Discord settings, and allowlists. **No new Railway variable or paid API key is required.**

The server upgrades schema 2 to 3 transactionally at startup. Settings, notes, favorites, quantities, history, logins, and transfer cooldowns are preserved. Logs identify **Takeoff API v0.3**; the existing `/health/ready` URL should return `{"status":"ready"}`. This verifies process/database health, not DG hours or prediction quality.

Do not run a Milestone 2 backend against the upgraded schema. For a full rollback, use the pre-upgrade backup and the offline `prepare-restore` process in [backend/SETUP.md](../backend/SETUP.md), with a compatible backend version. Restoring a backup intentionally invalidates its saved sessions.

## 4. Run the updated iPhone app

1. Open your **existing** `ios/Takeoff.xcodeproj` in Xcode.
2. Keep the same Takeoff scheme, Personal Team, bundle identifier, and connected iPhone.
3. Press **Command-R**. Do not delete the installed app or create a new target.
4. Confirm the plain ZIP label in Discover, address lines in the Inbox, and simplified Settings.
5. Open a store. The new **Restock timing** section shows learning status, validated regular hours, averages, and observed arrival days as data becomes available.

Press **Command-U** on an iPhone simulator to run the six native tests. These tests do not sign in or transfer your phone's access. See [XCODE_TESTING.md](XCODE_TESTING.md) for the full signing/device guide.

## 5. Verify live store hours first

The hours worker queries DG's existing `/omni/api/store/info/{storeNumber}` endpoint with the same server-side session, one eligible store at a time. Validated schedules are cached for a day and expire after 72 hours without a successful refresh. Timezones use DG's recognized IANA/Windows zone when supplied; otherwise they are derived on the server from the store coordinate. Missing or ambiguous coordinates/timezones suppress a forecast. No extra monitoring areas are loaded.

**The endpoint and `storeinfo` envelope were verified in DG's public directory code; an authenticated hours response was not available in this workspace.** The adapter is tested with synthetic schedules, not a capture of your actual session response. Check **Regular store hours** for one of your stores against DG before relying on predictions.

If the app says hours are unavailable and Railway logs `STORE_HOURS_UNRECOGNIZED`, use a store number already present in your app (replace `21820` below if needed). Inside the Railway API shell:

```sh
cd /app
npm run inspect-hours -- 21820
```

This read-only diagnostic prints public hours fields, field names, whether store coordinates are available, and the normalized schedule. It does not print request headers, cookies, tokens, private notes, or account records. Share this diagnostic output if the normalized result is null so the adapter can be matched to DG's exact format. Do not paste your Railway Variables or raw authorization headers.

Unknown/partial schedules are not interpreted as 24-hour opening. Explicit closed days, split shifts, overnight openings, date-specific changes in recognized fields, and daylight-saving transitions are handled. An unsupported holiday field format suppresses predictions when it appears in the supported special-hours fields. The app lists the weekly schedule; published date exceptions are applied to calculations.

## 6. How learning and warnings work

- The timer begins with a fresh observed increase and ends when a decrease crosses the pending-new-stock threshold. For 3 old + 12 new, sales at 15→14→13→12 do not complete the new timer; 12→11 does.
- Only opening hours count. A 9 PM increase, 10 PM close, 8 AM opening, and 9 AM sale produce a two-hour sample, not twelve hours.
- Multiple deliveries before a qualifying sale, unknown earlier stock, changed/missing schedules, lost coverage, or a monitoring gap cannot supply a clean timing sample. Unresolved batches expire after seven days as uncertain. Detailed records are retained for seven days after a batch ends, and the app shows a week of inventory history; store-level sums/counts are retained for learning.
- Old M2 pending stock and imported wall-clock averages are not retroactively made into opening-hours samples. Expect **Learning** initially. Keep the API running to observe new arrivals and sales.
- One clean sample can show a **low-confidence** estimate. Departure warnings require at least three samples and medium/high confidence. Confidence is a sample-count/variability/recency heuristic, not a measured probability. Several products can share one truck; sample count is not a count of independent trucks.
- The arithmetic average pools products at that store. High variability or samples older than 30 days lower confidence; samples older than 90 days suppress predictions until a new qualifying observation. The observed-day pattern describes clean product-batch arrivals; it does not promise next week's truck schedule.
- Passing a predicted time says **Expected ready—unconfirmed**. Only observed stock changes affect yellow/green shelf inference.

For the free Personal Team build, the active app quietly retrieves Apple Maps drive estimates from the **saved ZIP center**, at most one candidate per refresh cycle. Newly pending stores are prioritized, refreshes are requested after six hours, and an estimate is usable for at most 24 hours. The existing “Check drive from saved ZIP” button also saves an eligible estimate. Results are account-specific and cannot change another user's estimate or the shared restock model.

Railway computes the warning as **predicted shelf time − drive estimate − five minutes**. For 2 PM and a 20-minute drive, that is **1:35 PM**. Railway reevaluates this every 15 seconds using current predictions, selections, exclusions, and freshness. Each account/batch can create at most one approaching event across restarts. There is no second “average reached” alert.

The estimate is cached travel time, not a promise of live future traffic. Missing or expired drive estimates suppress departure warnings until the app refreshes them; newly discovered stores need an initial estimate while the app is open. This is the tradeoff for testing without a paid server Maps key. A future server-side routing provider can remove that dependency.

The server can write an inbox event while your phone is closed if it has a usable saved estimate. **APNs phone pushes remain Milestone 5.** The free build retrieves those missed events when reopened. Pause still retains eligible events in the inbox. Very late warnings (more than two minutes after their calculated departure time) are skipped rather than presented as an on-time five-minute warning.

## Live acceptance checks

1. Confirm the four interface changes and that previously saved settings/notes/favorites/login survive.
2. Confirm valid hours for a real covered store; use `inspect-hours` if needed.
3. With Stock increases enabled, observe a new increase while monitoring stays on. Verify one addressed inbox event.
4. Observe a clean qualifying new-batch sale. Check sample count and opening-hours duration; compare an overnight example when one occurs naturally.
5. After enough clean samples, confirm a later pending batch shows a forecast and confidence. It should stay yellow if the prediction passes without a sale.
6. Keep the app active briefly to populate drive estimates. With a suitable future forecast, confirm exactly one departure-warning inbox event at the calculated time. An excluded store or disabled approaching toggle should produce none.
7. Redeploy the same service and check that learned averages and active sessions survive. Do not artificially change real quantities or the production clock to force this test; automated tests cover the timing examples.

This update was prepared and checked locally. It has not been pushed, deployed, or compiled with Xcode here.
