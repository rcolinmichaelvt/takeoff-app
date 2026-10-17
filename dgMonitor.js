// ============================================================
//  Takeoff Monitors — Dollar General Pokémon Restock Monitor
// ============================================================

const fs = require("fs");
const path = require("path");

const WEBHOOK_URL = process.env.DG_WEBHOOK;

// ── Config ──────────────────────────────────────────────────
const CONFIG = {
  // Latitude / longitude for the search center
  latitude: 37.236075,
  longitude: -80.427231,
  radius: 25, // miles

  // SKUs to monitor (UPC codes)
  skus: [
    { upc: "196214158801", label: "30th ETBs" },
    { upc: "196214158757", label: "30th Posters" },
    { upc: "196214158726", label: "30th Ex Boxes" },
    { upc: "196214152397", label: "Knockout Boxes" },
    { upc: "196214150669", label: "Poster Collections"},
    { upc: "820650105838", label: "Mini Tins" },
    { upc: "196214141308", label: "Ascended Mini Tins?" },
    //{ upc: "820650850363", label: "Phantasmal Portfolios"},
    { upc: "196214152076", label: "AH Ex Boxes"},
    { upc: "820650801563", label: "Booster Packs"},
    { upc: "820650806568", label: "Checklane Blisters"},
    { upc: "820650809859", label: "3 Pack Tins"},
    //{ upc: "196214133099", label: "Sticker Collections"},
  ],

  // How often to poll (ms)
  pollInterval: 3 * 60 * 1000,          // normal: 3 minutes per SKU
  fastPollInterval: 10 * 1000,          // recent restocks: 10 seconds per SKU
  recentStockWindow: 3 * 24 * 60 * 60 * 1000,
  requestTimeout: 25 * 1000,
  maxObservationGap: 9 * 60 * 1000,     // longer gaps do not train predictions
  timezone: "America/New_York",

  // Persistent volume in Railway; a local data directory otherwise.
  cacheFile: process.env.DG_CACHE_FILE || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data"), "dg-stock-cache.json"),

  // Server-only credentials. Never commit captured browser cookies or tokens.
  session: {
    "x-dg-appsessiontoken": process.env.DG_APP_SESSION_TOKEN || "",
    "x-dg-apptoken": process.env.DG_APP_TOKEN || "",
    "x-dg-customerguid": process.env.DG_CUSTOMER_GUID || "",
    "x-dg-deviceuniqueid": process.env.DG_DEVICE_UNIQUE_ID || "",
    "x-dg-partnerapitoken": process.env.DG_PARTNER_API_TOKEN || "",
    cookie: process.env.DG_COOKIE || "",
  },
  auth: { authorization: process.env.DG_AUTHORIZATION || "" },
};

// ── Constants ────────────────────────────────────────────────
const BRAND_COLOR = 0xa78bfa; // light purple
const AVATAR_URL  = "https://i.imgur.com/4M34hi2.png";
const USERNAME    = "Takeoff Monitors";
const API_URL     = "https://dggo.dollargeneral.com/omni/api/store/search/inventory";

// ── In-memory state ──────────────────────────────────────────
// stockState[upc][storeNumber] = { qty, address, city, state, distance, phoneNumber }
const stockState = {};
// Running aggregates cover ALL accepted episodes; history is a bounded audit log.
let timing = { overall: null, byStore: {}, bySku: {}, byPair: {}, history: [] };
let apiPauseUntil = 0;
let refreshPromise = null;

// ── Token refresh ────────────────────────────────────────────
async function refreshToken() {
  if (!refreshPromise) {
    refreshPromise = performTokenRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function performTokenRefresh() {
  console.log(`[${timestamp()}] [Auth] Token expired — refreshing…`);

  try {
    const res = await fetch("https://www.dollargeneral.com/bin/dg/user?refreshCookies=true", {
      method: "GET",
      signal: AbortSignal.timeout(CONFIG.requestTimeout),
      headers: {
        accept:                   "application/json, text/plain, */*",
        "accept-language":        "en-US,en;q=0.9",
        "content-type":           "application/json",
        authorization:            CONFIG.auth.authorization,
        "x-dg-appsessiontoken":   CONFIG.session["x-dg-appsessiontoken"],
        "x-dg-apptoken":          CONFIG.session["x-dg-apptoken"],
        "x-dg-cloud-service":     "true",
        "x-dg-customerguid":      CONFIG.session["x-dg-customerguid"],
        "x-dg-deviceuniqueid":    CONFIG.session["x-dg-deviceuniqueid"],
        "x-dg-partnerapitoken":   CONFIG.session["x-dg-partnerapitoken"],
        cookie:                   CONFIG.session.cookie,
        "sec-ch-ua":              '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile":       "?0",
        "sec-ch-ua-platform":     '"Windows"',
        "sec-fetch-dest":         "empty",
        "sec-fetch-mode":         "cors",
        "sec-fetch-site":         "same-origin",
        priority:                 "u=1, i",
        Referer:                  "https://www.dollargeneral.com/p/pokemon-trading-card-game-15-card-pack-1-ct/728192558375",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (res.status !== 200 || !data.idToken) {
      throw new Error("Token refresh response did not contain an idToken");
    }

    CONFIG.auth.authorization = `Bearer ${data.idToken}`;
    CONFIG.session['x-dg-appsessiontoken'] = data.appSessionToken
    CONFIG.session['x-dg-apptoken'] = data.appToken
    CONFIG.session['x-dg-customerguid'] = data.customerGuid
    CONFIG.session['x-dg-partnerapitoken'] = data.partnerApiToken
    CONFIG.session['x-dg-deviceuniqueid'] = data.uniqueDeviceId
    console.log(`[${timestamp()}] [Auth] Token refreshed successfully.`);
  } catch (err) {
    console.error(`[${timestamp()}] [Auth] Token refresh failed: ${err.message}`);
    console.error(`[${timestamp()}] [Auth] Update the DG cookie/session environment variables if the session has expired.`);
    throw err;
  }
}

// ── Cache helpers ────────────────────────────────────────────
// Legacy { lastSaved, state } files remain valid. The next successful poll
// adds schemaVersion, per-store timestamps/pendingRestock, and timing aggregates.
function loadCache() {
  try {
    if (!fs.existsSync(CONFIG.cacheFile)) {
      console.log("[Cache] No cache file found — starting fresh.");
      return null;
    }
    const raw    = fs.readFileSync(CONFIG.cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    console.log(`[Cache] Loaded — last saved ${parsed.lastSaved}`);
    return parsed;
  } catch (err) {
    console.error(`[Cache] Failed to load: ${err.message} — starting fresh.`);
    return null;
  }
}

function saveCache() {
  try {
    const payload = {
      schemaVersion: 2,
      lastSaved: new Date().toISOString(),
      state: stockState,
      timing,
    };
    fs.mkdirSync(path.dirname(CONFIG.cacheFile), { recursive: true, mode: 0o700 });
    const temporary = `${CONFIG.cacheFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, CONFIG.cacheFile);
  } catch (err) {
    console.error(`[Cache] Failed to save: ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────
function timestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone: CONFIG.timezone, month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

function friendlyDate(isoString) {
  return new Date(isoString).toLocaleString("en-US", {
    timeZone: CONFIG.timezone, month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function storeLabel(store) {
  return `${store.address}, ${store.city}, ${store.state}`;
}

function formatPhone(num) {
  if (!num) return "N/A";
  num = String(num);
  return `(${num.slice(0, 3)}) ${num.slice(3, 6)}-${num.slice(6)}`;
}

// ── Discord helpers ──────────────────────────────────────────
async function sendWebhook(payload) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
    signal: AbortSignal.timeout(CONFIG.requestTimeout),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[Webhook] ${res.status} — ${text}`);
    }
  } catch (err) {
    console.error("[Webhook] Failed to send:", err.message);
  }
}

async function sendStockChange(sku, store, oldQty, newQty, timingFields = []) {
  const increased = newQty > oldQty;
  const emoji = increased ? "🟢" : "🔴";
  const verb  = increased ? "Restock" : "Stock Drop";
  const color = increased ? 0x4ade80 : 0xf87171;

  await sendWebhook({
    username: USERNAME,
    avatar_url: AVATAR_URL,
    embeds: [{
      title: `${emoji} ${verb} — ${sku.label}`,
      color,
      fields: [
        { name: "Store",        value: storeLabel(store),                inline: false },
        { name: "Stock Change", value: `**${oldQty}** → **${newQty}**`, inline: true  },
        { name: "Distance",     value: `${store.distance} mi`,           inline: true  },
        { name: "Phone",        value: formatPhone(store.phoneNumber),    inline: true  },
        ...timingFields,
      ],
      footer: { text: `Takeoff Monitors • Dollar General • UPC ${sku.upc}` },
      timestamp: new Date().toISOString(),
    }],
  });

  console.log(`[${timestamp()}] [${sku.label}] CHANGE @ ${storeLabel(store)} — ${oldQty} → ${newQty}`);
}

// ── API fetch ────────────────────────────────────────────────
async function fetchInventory(sku) {
  const body = new URLSearchParams({
    latitude:        CONFIG.latitude.toString(),
    longitude:       CONFIG.longitude.toString(),
    radius:          CONFIG.radius.toString(),
    upc:             sku.upc,
    offerSourceType: "0",
  });

  const res = await fetch(API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(CONFIG.requestTimeout),
    headers: {
      accept:                   "application/json, text/plain, */*",
      "accept-language":        "en-US,en;q=0.9",
      "content-type":           "application/x-www-form-urlencoded; charset=UTF-8",
      authorization:            CONFIG.auth.authorization,
      "x-dg-appsessiontoken":   CONFIG.session["x-dg-appsessiontoken"],
      "x-dg-apptoken":          CONFIG.session["x-dg-apptoken"],
      "x-dg-cloud-service":     "true",
      "x-dg-customerguid":      CONFIG.session["x-dg-customerguid"],
      "x-dg-deviceuniqueid":    CONFIG.session["x-dg-deviceuniqueid"],
      "x-dg-partnerapitoken":   CONFIG.session["x-dg-partnerapitoken"],
      "sec-ch-ua":              '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
      "sec-ch-ua-mobile":       "?0",
      "sec-ch-ua-platform":     '"Windows"',
      "sec-fetch-dest":         "empty",
      "sec-fetch-mode":         "cors",
      "sec-fetch-site":         "same-site",
      priority:                 "u=1, i",
      Referer:                  "https://www.dollargeneral.com/",
    },
    body: body.toString(),
  });


  if (res.status === 429) {
    const retry = retryAfterMs(res.headers.get("retry-after"));
    apiPauseUntil = Math.max(apiPauseUntil, Date.now() + retry);
    throw new Error(`RATE_LIMITED: paused for ${Math.ceil(retry / 1000)}s`);
  }

  // Auth expired — refresh token and signal caller to retry
  if (res.status === 401 || res.status === 403) {
    await refreshToken();
    throw new Error(`AUTH_EXPIRED`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();

  // Empty or non-JSON body — treat as auth expiry and refresh
  if (!text || text.trim() === "") {
    await refreshToken();
    throw new Error(`AUTH_EXPIRED`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Malformed JSON (e.g. HTML error page) — likely auth issue
    await refreshToken();
    throw new Error(`AUTH_EXPIRED`);
  }

  if (!Array.isArray(data.stores)) throw new Error("Invalid inventory response: stores array missing");
  for (const store of data.stores) {
    if (store.storeNumber == null || store.productQTY == null ||
        String(store.productQTY).trim() === "" ||
        !Number.isFinite(Number(store.productQTY)) || Number(store.productQTY) < 0) {
      throw new Error("Invalid store number or quantity; previous state retained");
    }
    store.productQTY = Number(store.productQTY);
  }
  return data.stores;
}

// ── Timing model ─────────────────────────────────────────────
// This measures observed restock -> first decrease, NOT physical unloading.
// Returns, corrections, sales delay, and backend update delay can affect it.
function retryAfterMs(value, now = Date.now()) {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - now) : 60_000;
}

function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1 minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, mins && `${mins}m`].filter(Boolean).join(" ");
}

function addAggregate(current, ms) {
  const a = current || { count: 0, totalMs: 0, minMs: ms, maxMs: ms };
  a.count++;
  a.totalMs += ms;
  a.minMs = Math.min(a.minMs, ms);
  a.maxMs = Math.max(a.maxMs, ms);
  return a;
}

function recordSample(sample) {
  const { upc, storeNumber, elapsedMs } = sample;
  const pair = `${upc}:${storeNumber}`;
  timing.overall = addAggregate(timing.overall, elapsedMs);
  timing.byStore[storeNumber] = addAggregate(timing.byStore[storeNumber], elapsedMs);
  timing.bySku[upc] = addAggregate(timing.bySku[upc], elapsedMs);
  timing.byPair[pair] = addAggregate(timing.byPair[pair], elapsedMs);
  timing.history.push(sample);
  timing.history = timing.history.slice(-500);
}

// Every store uses only its own completed episodes across monitored products.
// Existing timing.byStore cache data is reused; other stores are never a fallback.
function prediction(upc, storeNumber) {
  const aggregate = timing.byStore[String(storeNumber)];
  if (!aggregate || aggregate.count <= 0) return null;
  return {
    scope: "this store (all products)",
    ...aggregate,
    meanMs: aggregate.totalMs / aggregate.count,
  };
}

function predictionFields(upc, storeNumber, restockAt, arrivalUnknown = false) {
  const p = prediction(upc, storeNumber);
  const fields = [
    { name: "This store's average — restock → first decrease",
      value: p
        ? `**${duration(p.meanMs)}** from **${p.count}** completed episode(s) at store **${storeNumber}**.` +
          `\nAcross monitored products at this store.` +
          `\nObserved range: ${duration(p.minMs)}–${duration(p.maxMs)}.` +
          (p.count < 3 ? "\nPreliminary: fewer than 3 episodes." : "")
        : `Learning: no completed episodes at store **${storeNumber}** yet.`,
      inline: false },
    { name: "Expected first stock decrease (Eastern time)",
      value: !p
        ? "Not available until this store has a completed restock → first-decrease episode."
        : arrivalUnknown
          ? "Unavailable: this increase occurred while offline, so its arrival time is unknown."
          : `**${friendlyDate(new Date(restockAt + p.meanMs).toISOString())} ET**` +
            `\nFirst observed increase + this store's average.`,
      inline: false },
    { name: "Estimate meaning",
      value: "Restock → first decrease is a proxy; includes buyer wait/update delay. Shelf placement is unconfirmed.",
      inline: false },
  ];
  return fields;
}

function isFastSku(sku, now = Date.now()) {
  return Object.values(stockState[sku.upc] || {}).some((entry) => {
    const at = Date.parse(entry.lastIncreaseAt);
    return entry.qty > 0 && Number.isFinite(at) && at <= now && now - at < CONFIG.recentStockWindow;
  });
}

// Pure state transition helper: tests can exercise this without live requests.
function observeStore(sku, store, now = Date.now(), offline = false) {
  const prev = stockState[sku.upc] ||= {};
  const old = prev[store.storeNumber];
  const oldQty = old?.qty ?? null;
  const newQty = store.productQTY;
  const iso = new Date(now).toISOString();
  const entry = {
    ...old, qty: newQty, address: store.address, city: store.city,
    state: store.state, distance: store.distance, phoneNumber: store.phoneNumber,
    lastObservedAt: iso,
  };
  prev[store.storeNumber] = entry;
  const previousAt = Date.parse(old?.lastObservedAt);
  const gap = now - previousAt;
  if (entry.pendingRestock && (offline || !Number.isFinite(gap) ||
      gap < 0 || gap > CONFIG.maxObservationGap)) {
    entry.pendingRestock = { ...entry.pendingRestock, trainable: false };
  }
  // Baseline stock has no known arrival time: never invent a restock.
  if (oldQty === null || oldQty === newQty) return null;
  let fields = [];
  if (newQty > oldQty) {
    entry.lastIncreaseAt = iso;
    // Group consecutive rises before the first decrease into one episode.
    if (!entry.pendingRestock) {
      entry.pendingRestock = {
        detectedAt: iso,
        arrivalUnknown: offline,
        previousObservedAt: old?.lastObservedAt || null,
        trainable: !offline && Number.isFinite(gap) && gap >= 0 && gap <= CONFIG.maxObservationGap,
        increases: 1,
      };
    } else {
      entry.pendingRestock = { ...entry.pendingRestock, increases: entry.pendingRestock.increases + 1 };
    }
    fields = predictionFields(sku.upc, store.storeNumber, Date.parse(entry.pendingRestock.detectedAt), offline || entry.pendingRestock.arrivalUnknown === true);
    if (entry.pendingRestock.increases > 1) fields.push({
      name: "Restock episode", value: "Consecutive increases are grouped; estimate is anchored to the first observed increase.", inline: false,
    });
    fields.push({ name: "Monitoring", value: "10-second checks for 72 hours after the latest observed increase (while stock remains).", inline: false });
    if (offline) fields.push({ name: "Timing uncertainty", value: "Increase happened while offline; arrival time is unknown and this episode will not train estimates.", inline: false });
  } else if (entry.pendingRestock) {
    const pending = entry.pendingRestock;
    const start = Date.parse(pending.detectedAt);
    const elapsedMs = now - start;
    const usable = pending.trainable && !offline && Number.isFinite(elapsedMs) && elapsedMs >= 0;
    if (usable) {
      recordSample({
        upc: sku.upc, storeNumber: String(store.storeNumber),
        restockAt: pending.detectedAt, firstDecreaseAt: iso, elapsedMs,
        // Bounds reflect polling uncertainty, not backend update delay.
        minimumMs: Math.max(0, previousAt - start),
        maximumMs: now - Date.parse(pending.previousObservedAt),
        increases: pending.increases,
      });
    }
    fields = [{ name: "First decrease after restock", value: usable
      ? `**${duration(elapsedMs)}** after the first observed increase; added to averages.` +
        (pending.increases > 1 ? `\nGrouped ${pending.increases} increases in this episode.` : "")
      : "Timing excluded from averages because arrival time or continuous observations were missing.", inline: false },
      { name: "Shelf signal", value: "Possible sale or inventory adjustment; shelf availability is unconfirmed.", inline: false }];
    delete entry.pendingRestock;
  }
  return { store, oldQty, newQty, fields };
}

// ── Poll logic ───────────────────────────────────────────────
async function pollSku(sku, isFirst = false) {
  let stores;
  try {
    stores = await fetchInventory(sku);
  } catch (err) {
    if (err.message !== "AUTH_EXPIRED") throw err;
    // One retry after the shared token refresh; scheduler handles further errors.
    stores = await fetchInventory(sku);
  }
  const now = Date.now();
  const changes = stores.map((store) => observeStore(sku, store, now, isFirst))
    .filter(Boolean);
  // Persist before sending notifications, including observation times with no change.
  saveCache();
  for (const change of changes) {
    await sendStockChange(sku, change.store, change.oldQty, change.newQty, change.fields);
  }
  console.log(`[${timestamp()}] [${sku.label}] ${stores.length} stores; ` +
    `${stores.filter((s) => s.productQTY > 0).length} in stock; ` +
    `${isFastSku(sku) ? "FAST 10s" : "NORMAL 180s"}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Scheduler ────────────────────────────────────────────────
// One slot per configured SKU in each 10-second frame, including idle slots.
// Thus fast SKUs never collapse onto the same launch time when eligibility changes.
// Normal SKUs use one slot every 18 frames (180s). Slow requests never overlap
// for the same SKU, and missed slots are skipped instead of replayed in a burst.
function shouldPoll(sku, runtime, cycle, now = Date.now()) {
  const frames = Math.ceil(CONFIG.pollInterval / CONFIG.fastPollInterval);
  return !runtime.busy && now >= runtime.retryAt && now >= apiPauseUntil &&
    (isFastSku(sku, now) || cycle - runtime.lastCycle >= frames);
}

async function runScheduler() {
  const count = CONFIG.skus.length;
  const slotMs = CONFIG.fastPollInterval / count;
  const started = Date.now();
  const runtimes = CONFIG.skus.map(() => ({ busy: false, initialized: false,
    lastCycle: -Infinity, retryAt: 0, failures: 0 }));
  let slot = 0;
  while (true) {
    const target = started + slot * slotMs;
    if (target > Date.now()) await sleep(target - Date.now());
    slot = Math.max(slot, Math.floor((Date.now() - started) / slotMs));
    const index = slot % count;
    const cycle = Math.floor(slot / count);
    const sku = CONFIG.skus[index];
    const runtime = runtimes[index];
    if (shouldPoll(sku, runtime, cycle)) {
      runtime.busy = true;
      runtime.lastCycle = cycle;
      pollSku(sku, !runtime.initialized).then(() => {
        runtime.initialized = true;
        runtime.failures = 0;
        runtime.retryAt = 0;
      }).catch((err) => {
        runtime.failures++;
        const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(runtime.failures - 1, 5));
        runtime.retryAt = Math.max(apiPauseUntil, Date.now() + delay);
        // Retry on the next eligible slot AFTER backoff, even for a normal SKU.
        runtime.lastCycle = -Infinity;
        console.error(`[${timestamp()}] [${sku.label}] ${err.message}; retry in ${duration(delay)}.`);
      }).finally(() => { runtime.busy = false; });
    }
    slot++;
  }
}

// ── Entry point ──────────────────────────────────────────────
async function main() {
  const required = ["DG_APP_SESSION_TOKEN", "DG_APP_TOKEN", "DG_CUSTOMER_GUID",
    "DG_DEVICE_UNIQUE_ID", "DG_PARTNER_API_TOKEN", "DG_COOKIE", "DG_AUTHORIZATION"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Set server environment variables: ${missing.join(", ")}`);
  if (!WEBHOOK_URL) throw new Error("Set DG_WEBHOOK before starting the monitor.");
  const url = new URL(WEBHOOK_URL);
  if (url.protocol !== "https:") throw new Error("DG_WEBHOOK must be an HTTPS URL.");
  if (!CONFIG.skus.length) throw new Error("Configure at least one SKU.");
  const cache = loadCache();
  if (cache?.state) Object.assign(stockState, cache.state);
  if (cache?.timing) {
    timing = { ...timing, ...cache.timing };
  }
  // Downtime may hide the real first decrease; never train across restarts.
  for (const stores of Object.values(stockState)) {
    for (const entry of Object.values(stores)) {
      if (entry.pendingRestock) entry.pendingRestock.trainable = false;
    }
  }
  console.log(`Takeoff Monitors — ${CONFIG.skus.length} SKUs; normal 180s / recent 10s.`);
  console.log(`Stagger: ${(CONFIG.fastPollInterval / CONFIG.skus.length / 1000).toFixed(3)}s per slot; times in Eastern.`);
  console.log(`Timing history: ${timing.overall?.count || 0} completed episodes.`);
  process.on("SIGINT", () => { saveCache(); process.exit(0); });
  process.on("SIGTERM", () => { saveCache(); process.exit(0); });
  await runScheduler();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { CONFIG, stockState, observeStore, isFastSku, prediction,
  predictionFields, shouldPoll, retryAfterMs, pollSku, fetchInventory,
  getTiming: () => timing };
