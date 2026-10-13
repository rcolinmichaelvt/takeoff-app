export const latestSchemaVersion = 2;

export const migration2 = `
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
`;
