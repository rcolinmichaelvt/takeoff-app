# Upgrade the existing Railway API to Milestone 2

Your Railway service is already set up. This update adds the supporting API/worker and database tables for the iPhone app. **Reuse that API service and its existing `/data` volume.** The upgrade runs automatically on startup and preserves Milestone 1 accounts, sessions, transfer cooldowns, replay records, inbox entries, and archived legacy data.

## Files to add or replace

Merge the download into your new **private** app repository, preserving these paths:

| Path | Action |
| --- | --- |
| `backend/` | Replace/update with the full supplied folder, including `src/migrations.js`, all other new source, `package.json`, and `package-lock.json` |
| `ios/` | Add the whole folder; it contains the project, Swift files, app assets, and tests |
| `docs/` | Add/update the guides and milestone plan |
| Root `README.md` and `.gitignore` | Update with the supplied versions |

Keep source in a private repository before uploading the backend. The ZIP excludes live credentials, cache files, databases, build output, and the old repository's Git history. Do not replace your local `.env` with blank example values. Railway Variables remain the source of deployed secrets. Root `dgMonitor.js` is the separate legacy Discord program; the API service runs **backend/src/main.js**.

## 1. Make a database backup

Open a shell **inside the existing Railway API service**, which has access to its volume. From the Docker image's `/app` directory, run:

```sh
npm run backup -- /data/before-milestone-2.sqlite
```

Choose a new filename if it already exists. Download a protected copy using your existing Railway access/backup workflow. This is a consistent online SQLite backup, including committed WAL data. Running that command on your Mac instead would back up the Mac's database, not Railway's.

A backup copy on `/data` protects against a bad migration but shares the volume's failure risk. Keep a separate protected copy. Recovery instructions remain in [backend/SETUP.md](../backend/SETUP.md); use `prepare-restore` before restoring an old backup so old sessions are not revived.

## 2. Deploy the backend update

1. Add the files above to the branch connected to the API service and deploy it.
2. Keep Root Directory **`/backend`**, config path **`/backend/railway.toml`**, the Dockerfile builder/default start command, one replica, `DATA_DIR=/data`, and the attached volume. Keep the existing Discord settings and allowlists.
3. Leave `DG_MONITOR_ENABLED=false` for the initial upgrade if you want to verify login/settings first.
4. Check `/health/ready` on the same HTTPS domain. Expected: `{"status":"ready"}`. Logs identify **Takeoff API v0.2**.

Schema version 1 is upgraded transactionally to version 2. Repeated restarts do not rerun the migration. **Do not run the old Milestone 1 server against a version 2 database**; it intentionally rejects unknown schema versions. Correct an application issue by deploying a fixed v0.2 build, or use the documented offline backup recovery procedure if a full rollback is necessary.

You do not need a new database, new Discord application, or different service URL.

## 3. Enable live DG inventory on the server

Add a fresh, working DG website session to **this API service's Railway Variables**, using the same header values used by your current monitor:

| Variable | Value from the existing working session |
| --- | --- |
| `DG_AUTHORIZATION` | Complete `Bearer ...` authorization value |
| `DG_APP_SESSION_TOKEN` | `x-dg-appsessiontoken` |
| `DG_APP_TOKEN` | `x-dg-apptoken` |
| `DG_CUSTOMER_GUID` | `x-dg-customerguid` |
| `DG_DEVICE_UNIQUE_ID` | `x-dg-deviceuniqueid` |
| `DG_PARTNER_API_TOKEN` | `x-dg-partnerapitoken` |
| `DG_COOKIE` | DG website cookie header used by the existing token-refresh function |
| `DG_MONITOR_ENABLED` | `true` |
| `STORE_GEOCODING_ENABLED` | `true` (default) |

Paste each header **value**, without surrounding JavaScript quotes or the header name. Keep the values out of Swift, GitHub files, screenshots, and chat. The source archive contains empty placeholders only. The new worker retains the existing inventory endpoint and server-side token refresh approach. Its adapter was tested with controlled responses, **not your live DG session**; use the first real region as the integration check.

Apply variables/redeploy. Then sign in from the app, save your ZIP, and select at least one product. Monitoring work is created from those saved subscriptions. Identical ZIP+UPC selections share one job. Different overlapping ZIPs still need separate upstream area queries; returned store+UPC snapshots are shared and unchanged quantities do not duplicate events. No extra discovery regions are automatically loaded.

The nominal schedule is three minutes normally, or ten seconds for a product/ZIP with an observed increase in the last 72 hours while stock remains. Requests are staggered, sequential, and at least one second apart. Provider backoff and many distinct jobs can make actual checks slower. This is not yet a 100-user capacity guarantee. Keep the Railway service awake; a sleeping/serverless instance does not provide continuous monitoring.

When logs report a sanitized code:

| Code | Meaning/action |
| --- | --- |
| `DG_AUTH_REQUIRED` | Refresh failed; update the server session credentials from a working session |
| `DG_RATE_LIMITED` | The worker honors the provider's delay; reduce load before expanding users |
| `DG_INVALID_RESPONSE` | Unexpected inventory shape; stock is preserved, not changed to zero. Capture only a redacted example structure if adapter work is needed |
| `DG_UNAVAILABLE` | Network/upstream problem; retry is automatic with backoff |

The worker generates app inbox events and has **no Discord webhook path**. After you confirm the new worker is receiving correct observations, stop the old Discord monitor service to complete the cutover and avoid paying for/polling from two monitors. Export its latest cache before stopping if you still need the historical archive. No running service was changed while preparing this download.

## 4. Understand the first data

- A first successful positive quantity is **unknown**, because the app has not seen it arrive or start selling. A first successful zero is sold out.
- A fresh observed increase is pending back stock unless older available stock remains. The approved 3 + 12 = 15 → 14 → 13 → 12 → 11 threshold is implemented for basic map status.
- An error, malformed quantity, missing store row, or unavailable coordinate is never interpreted as zero stock.
- After a monitoring gap of more than nine minutes, the next positive observation starts with unknown status. Old quantities remain visible with freshness information.
- Restock duration, store hours, confidence scores, multiple-delivery timing, and predictions are Milestone 3. This build creates **no predicted-ready or approaching-time events**. The approaching toggle saves the preference for that milestone.
- Historical cache imports remain archived. They are not promoted into current shelf status or opening-hours timing samples.

ZIPs resolve through [Zippopotam.us](https://www.zippopotam.us/) and are cached. Store coordinates use DG when provided, otherwise a throttled [US Census address lookup](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html). ZIP lookup sends only the entered ZIP; Census receives public store addresses, not phone locations. Neither service needs an API key in this implementation. An unavailable address match leaves a store in the list rather than placing an invented pin.

## 5. Verify this deployment

Use [XCODE_TESTING.md](XCODE_TESTING.md) to build and install the app, then:

1. Sign in, save the ZIP/products, and compare a few quantities with the existing working monitor.
2. Save a private note and favorite a store. Reopen the app and confirm persistence.
3. Check that another allowed account cannot see that private note and cannot edit moderator notes unless its ID is in the moderator list.
4. After a real stock change, confirm one corresponding inbox event with the expected preferences/exclusions.
5. Redeploy the same API service and confirm settings, notes, favorites, history, and active login survive on the volume. A long outage can correctly change stock labels to unknown.

Phone push is not active yet. The inbox can gain events while the app is closed; you see them when the app next fetches them. Your Personal Team build cannot receive native APNs stock-change notifications in the background.
