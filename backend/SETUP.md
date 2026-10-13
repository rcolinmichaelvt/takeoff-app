# Takeoff backend setup

This guide covers a fresh backend deployment and recovery. If Railway is already set up from Milestone 1, use [the Milestone 2 upgrade guide](../docs/MILESTONE_2_UPGRADE.md), then [the Xcode guide](../docs/XCODE_TESTING.md). The native iPhone client is now included. There is no fake-login bypass in the running server.

## 1. Keep the source private

Use a clean private GitHub repository for new development, or make the existing repository private before pushing this branch. A new private repository should receive only the current sanitized files, without the original `.git` directory, credentials, cache snapshots, or `node_modules`.

Keep the new API on its existing separate service while validating the cutover. Milestone 2 includes optional DG polling; see the upgrade guide for credentials, first subscriptions, and stopping the legacy monitor after validation.

## 2. Create the Discord sign-in application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application named Takeoff, or use a dedicated existing application that you control.
2. Under OAuth2, obtain its Client ID and Client Secret. Put the secret directly into the backend environment; do not put it in Swift, a GitHub file, or a chat message.
3. Add the exact redirect URI for each environment you use:

   ```text
   http://127.0.0.1:3000/v1/auth/discord/callback
   https://YOUR-BACKEND.up.railway.app/v1/auth/discord/callback
   ```

4. For local HTTP testing, the host must match exactly: `localhost` and `127.0.0.1` are different redirect URIs. If you change the port, update both the registered redirect and `PUBLIC_BASE_URL`.
5. Obtain your numeric Discord user ID using Discord's Developer Mode and Copy User ID. Put that ID in `ALLOWED_DISCORD_IDS`. Use commas for multiple users. Moderator IDs must appear in both lists.

Only the `identify` OAuth scope is requested. No Discord bot, guild membership lookup, email access, or webhook is required for the app backend. The server exchanges the Discord code and immediately attempts to revoke the temporary Discord token after fetching the account identity. See [Discord's OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2).

## 3. Run on your Mac

Install [Node.js 24.x](https://nodejs.org/en/download), then open Terminal in this project's folder:

```sh
cd backend
node --version
cp .env.example .env
```

Edit `.env` in a local editor. Fill in your real `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `ALLOWED_DISCORD_IDS`. Leave the other development values as provided for the first run. Do not copy the root legacy monitor settings into this file.

```sh
npm test
npm start
```

In another Terminal window:

```sh
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Expected results are `{"status":"ok"}` and `{"status":"ready"}`. The readiness check proves the API can access its database; it does not prove the Discord credentials work or that inventory is being monitored.

The database is `backend/data/takeoff.sqlite` with SQLite WAL sidecar files while running. Stop with Control-C. Restarting with the same data directory preserves sessions, cooldowns, replay records, and inbox entries. `.env` loads automatically through the `npm start` command; it is ignored by Git.

No `npm install` is needed for this backend's runtime. The root package and its old dependencies are separate from this backend.

An iPhone's `127.0.0.1` is the iPhone itself. Use the Railway HTTPS URL for physical-device testing; the Mac loopback URL is for testing on the Mac.

## 4. Create a separate Railway test service

Once the source has a private destination, create a new service from that private repository in your Railway project. Keep the current monitor service and its live deployment in place during testing.

| Setting | Value |
| --- | --- |
| Service name | `takeoff-api-test` or similar |
| Source branch | The reviewed backend branch |
| Root Directory | `/backend` |
| Config file path | `/backend/railway.toml` |
| Builder | Dockerfile |
| Dockerfile | `Dockerfile`, relative to the service root |
| Start command | Use the Docker image default |
| Health check | `/health/ready` |
| Replicas | **1** |
| Persistent volume mount | `/data` |

The config file path is relative to the repository root even when the service Root Directory is `/backend`. Railway documents this distinction in its [monorepo guide](https://docs.railway.com/deployments/monorepo).

Attach a persistent volume at `/data` before the first successful production start. Railway supplies `RAILWAY_VOLUME_MOUNT_PATH` at runtime; **do not manually invent that variable to bypass the startup check**. Volumes are not mounted during the build or pre-deploy steps, so database initialization runs at service startup. See [Railway volumes](https://docs.railway.com/volumes).

Generate a Railway HTTPS domain and set these service variables:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
DATA_DIR=/data
PUBLIC_BASE_URL=https://YOUR-BACKEND.up.railway.app
APP_CALLBACK_URL=takeoff://auth/callback
DISCORD_CLIENT_ID=YOUR_CLIENT_ID
DISCORD_CLIENT_SECRET=YOUR_CLIENT_SECRET
ALLOWED_DISCORD_IDS=YOUR_NUMERIC_DISCORD_ID
MODERATOR_DISCORD_IDS=YOUR_NUMERIC_DISCORD_ID
TRUST_PROXY_HOPS=1
```

Let Railway provide `PORT`, or set its domain target port to match an explicit `PORT`. The code listens on the provided value. The placeholders above are not usable credentials.

`TRUST_PROXY_HOPS=1` trusts Railway's documented `X-Real-IP` header when requests must pass through its edge. Keep the container reachable through that trusted path; do not expose an alternate direct public port. If another proxy is added, verify its header rewriting before changing this setting. The fallback for other explicitly configured proxy chains reads `X-Forwarded-For` from the trusted end. Local development defaults to `0`, ignoring both headers. With `0` behind Railway, users can share the proxy's IP rate-limit bucket. The per-account limit also remains active. See [Railway networking headers](https://docs.railway.com/networking/public-networking/specs-and-limits).

Register the generated HTTPS callback URI in Discord, deploy this new service, and open `https://YOUR-BACKEND.up.railway.app/health/ready`. The logs should report Takeoff API v0.2, the configured DG monitoring state, and that predictions/APNs are not enabled.

Configure this service without sleeping/serverless behavior when enabling its inventory worker. A mounted SQLite volume means this design is for one service replica; it is not a horizontally scaled database setup. This keeps the initial infrastructure small. Railway service and storage charges depend on your plan and usage; an always-on monitor is not promised to fit a free tier. Check the [current Railway plans](https://docs.railway.com/pricing/plans) before enabling paid resources.

## 5. Preserve the current monitor's state

**Export the latest cache from the running monitor before any redeployment of that service.** The committed cache in the old repository is a historical snapshot, not a reliable copy of its current memory or filesystem.

Use Railway's [SSH access](https://docs.railway.com/cli/ssh) to locate and export the running service's current `dg-stock-cache.json`. Check the active service, environment, file path, `lastSaved`, and whether it contains `timing`. Keep the exported file private. If a previous redeploy already lost the file, this code cannot recover the missing observations.

To archive an exported cache into the new backend, copy it to a private location accessible by that backend and run from its `backend` directory:

```sh
npm run import-cache -- /absolute/path/to/current-dg-stock-cache.json
```

The import is transactional and refuses to overwrite an existing import. It archives old quantities and timing without asserting a current shelf status. Old elapsed-clock-time averages are **not** used as opening-hours averages. The Milestone 2 worker creates fresh observations; Milestone 3 will build opening-hours timing samples and forecasts.

The legacy monitor has also been changed locally to read credentials from environment variables and write its cache atomically. Before deploying that revised legacy file, configure every required root `.env.example` credential with a fresh DG website session, attach a volume to that legacy service, set `DG_CACHE_FILE=/data/dg-stock-cache.json`, and place the verified exported cache there. A volume belongs to its service; do not assume the new API's volume also persists the old monitor's file. The old file still sends Discord notifications until the later app monitoring cutover.

## 6. Back up and recover

The backup utility uses SQLite's online backup API, so it includes committed WAL data. Run it in the environment that actually contains the database:

```sh
npm run backup -- /absolute/path/to/new-backup.sqlite
```

The destination must be new and its parent directory must already exist. The command never intentionally overwrites an existing file. Keep an encrypted or otherwise access-controlled copy outside the service and choose a retention schedule; a second file on the same volume is not protection against volume loss.

For recovery, prepare an offline copy first:

```sh
npm run prepare-restore -- /absolute/path/to/backup.sqlite /absolute/path/to/prepared-restore.sqlite
```

This verifies the schema and integrity, removes old sessions and login challenges, and holds device transfers for at least six hours to protect against rolling back a cooldown. Users must sign in again. A phone matching the restored active installation key can sign in; a different installation must wait for the transfer cooldown. The backup and running database are unchanged by this command.

Before replacing the live database, stop the service and all maintenance processes accessing it. Preserve the current `takeoff.sqlite` **and its `-wal`/`-shm` sidecars together** in a separate recovery location. Put only the prepared restore file at `/data/takeoff.sqlite`, with private file permissions; never leave sidecars from a different database at that path. Start one service instance, check readiness, then test sign-in and device status. Do not restore a raw old backup directly into a running service: that could undo revocations and mix unrelated WAL data.

## 7. Access changes and first live checks

To add or remove a member, edit `ALLOWED_DISCORD_IDS` in Railway Variables and apply/restart the deployment. The allowlist is loaded on startup. Once the new process is running, removal blocks even otherwise unexpired sessions and refresh tokens. Keep moderator IDs consistent with the allowlist.

Before using real accounts, complete these checks with the Milestone 2 client:

- Authorized Discord account signs in; an unlisted account is denied.
- A second installation asks to transfer access; accepting revokes the first immediately.
- A third transfer is blocked until six hours after the preceding transfer.
- Signing out and redeploying do not bypass the cooldown.
- The account, inbox, and device state survive a redeployment with the same volume.

Automated tests cover these server behaviors, but the real Discord, Railway, and native app integration still needs this live check.
