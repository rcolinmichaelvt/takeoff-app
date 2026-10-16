-- Snapshot of the delivered Milestone 2 schema; never evaluated from live source.
CREATE TABLE users (
  discord_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active_key_id TEXT,
  next_transfer_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE installation_keys (
  key_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  key_id TEXT NOT NULL REFERENCES installation_keys(key_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX sessions_user ON sessions(discord_id);
CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  consumed_at INTEGER
) STRICT;
CREATE TABLE request_nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(key_id, nonce)
) STRICT;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
) STRICT;
CREATE INDEX events_user_time ON events(discord_id, created_at DESC, id DESC);
CREATE TABLE monitor_snapshots (
  name TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
) STRICT;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 1;


CREATE TABLE zip_regions (
  zip TEXT PRIMARY KEY,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  label TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
) STRICT;
CREATE TABLE preferences (
  discord_id TEXT PRIMARY KEY REFERENCES users(discord_id),
  zip TEXT REFERENCES zip_regions(zip),
  products_json TEXT NOT NULL DEFAULT '[]',
  alerts_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  postal_code TEXT,
  phone TEXT,
  latitude REAL,
  longitude REAL,
  coordinate_source TEXT,
  updated_at INTEGER NOT NULL,
  geocode_after INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE store_preferences (
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  private_note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(discord_id,store_id)
) STRICT;
CREATE TABLE public_notes (
  store_id TEXT PRIMARY KEY REFERENCES stores(id),
  note TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(discord_id),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE inventory (
  store_id TEXT NOT NULL REFERENCES stores(id),
  upc TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  status TEXT NOT NULL CHECK(status IN ('unknown','back','available','out')),
  pending_quantity INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL,
  last_increase_at INTEGER,
  last_decrease_at INTEGER,
  PRIMARY KEY(store_id,upc)
) STRICT;
CREATE TABLE area_inventory (
  zip TEXT NOT NULL REFERENCES zip_regions(zip),
  store_id TEXT NOT NULL REFERENCES stores(id),
  upc TEXT NOT NULL,
  distance REAL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY(zip,store_id,upc)
) STRICT;
CREATE INDEX coverage_store ON area_inventory(store_id,upc);
CREATE TABLE inventory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL REFERENCES stores(id),
  upc TEXT NOT NULL,
  previous_quantity INTEGER,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX history_store ON inventory_history(store_id,id DESC);
CREATE TABLE monitor_jobs (
  zip TEXT NOT NULL REFERENCES zip_regions(zip),
  upc TEXT NOT NULL,
  next_poll_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(zip,upc)
) STRICT;
PRAGMA user_version = 2;
