-- Half A · Hub — catalog discovery schema (Postgres / Supabase)
--
-- Design notes that matter:
--   * `discoveries` is the dedupe ledger. One row per (source, external id).
--     A new row IS the discovery event — that's what triggers an alert.
--   * A source seeds silently on its first sweep, so turning one on doesn't
--     announce its entire back catalogue.
--   * Products own identity; retailer ids live in `aliases` pointing at them.
--     A retailer changing its SKU is an alias edit, never a migration.
--
-- Ported from SQLite/D1. The differences that actually bit:
--   AUTOINCREMENT → BIGSERIAL, datetime('now') → now(), INTEGER flags →
--   BOOLEAN, and REAL → NUMERIC. That last one matters: Postgres hands NUMERIC
--   back as a *string* to preserve precision, so the store coerces prices on
--   the way out. A SQLite-backed test would never have shown that.

-- ---------------------------------------------------------------------------
-- Where to look
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  retailer      TEXT NOT NULL,
  -- 'sitemap_index' | 'sitemap' | 'json_list' | 'watcher'
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL DEFAULT '',
  -- 'hub'     : the Hub fetches this itself (tolerant endpoints)
  -- 'watcher' : unreachable from a datacenter; the Watcher posts it in
  via           TEXT NOT NULL DEFAULT 'hub',
  -- JSON: { filters: ["pokemon"], childLimit: 5, selector: "..." }
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- false until the first full sweep completes; that sweep announces nothing.
  seeded        BOOLEAN NOT NULL DEFAULT false,
  -- Rotating offset into a sitemap index's children. A retailer's product
  -- sitemap can have dozens of children; sweeping the same first few forever
  -- would never see a product that lands in child 47. Each sweep advances.
  cursor        INTEGER NOT NULL DEFAULT 0,
  last_swept_at TIMESTAMPTZ,
  last_status   TEXT NOT NULL DEFAULT '',
  last_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sources_enabled_idx ON sources (enabled, via);

-- ---------------------------------------------------------------------------
-- What a thing IS. The Hub mints these; retailers never define identity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  key           TEXT PRIMARY KEY,          -- prd_mega_evolution_etb
  name          TEXT NOT NULL,
  release_date  DATE,                      -- filled in by hand or a later source
  notes         TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aliases (
  id          BIGSERIAL PRIMARY KEY,
  product_key TEXT NOT NULL REFERENCES products(key) ON DELETE CASCADE,
  -- 'retailer_sku' | 'url' | 'search' | 'receipt_text'
  kind        TEXT NOT NULL,
  retailer    TEXT NOT NULL DEFAULT '',
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, retailer, value)
);

CREATE INDEX IF NOT EXISTS aliases_product_idx ON aliases (product_key);

-- ---------------------------------------------------------------------------
-- The dedupe ledger. Insert = discovery.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discoveries (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT NOT NULL,
  external_id   TEXT NOT NULL,             -- the retailer's own id or slug
  url           TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  price         NUMERIC(10, 2),
  product_key   TEXT,
  -- true when it was seeded silently or has already been announced
  announced     BOOLEAN NOT NULL DEFAULT false,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS discoveries_pending_idx ON discoveries (announced);

-- ---------------------------------------------------------------------------
-- Ops log. Sweeps write here on failure or on anything surprising.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind    TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL DEFAULT '',
  data    JSONB
);

CREATE INDEX IF NOT EXISTS events_at_idx ON events (at DESC);

-- ---------------------------------------------------------------------------
-- What the Watcher saw
--
-- Two tables on purpose, because "what is true now" and "what happened" want
-- different shapes and different write rates.
--
--   watch_state   one row per (product, retailer). Upserted on every check, so
--                 the dashboard can always say how stale a reading is. A page
--                 that cannot tell you it is out of date is worse than no page.
--
--   observations  append-only history, written ONLY when something material
--                 changed — state, price, or seller. Polling every minute for a
--                 week is ten thousand checks and, for a product that never
--                 moves, zero rows. That is what makes the history readable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watch_state (
  product_key        TEXT NOT NULL REFERENCES products(key) ON DELETE CASCADE,
  retailer           TEXT NOT NULL,
  external_id        TEXT NOT NULL DEFAULT '',
  url                TEXT NOT NULL DEFAULT '',
  -- 'in' | 'out' | 'queue' | 'unknown'
  state              TEXT NOT NULL DEFAULT 'unknown',
  -- 'exact' | 'inferred' | 'unknown'
  confidence         TEXT NOT NULL DEFAULT 'unknown',
  price              NUMERIC(10, 2),
  -- 'retailer' | 'marketplace' | 'unknown'. Walmart lists third-party sellers
  -- as IN_STOCK at whatever they like; this is what stops a scalper's price
  -- looking like a restock.
  seller_kind        TEXT NOT NULL DEFAULT 'unknown',
  seller_name        TEXT NOT NULL DEFAULT '',
  available_quantity INTEGER,
  order_limit        INTEGER,
  is_preorder        BOOLEAN NOT NULL DEFAULT false,
  release_date       DATE,
  note               TEXT NOT NULL DEFAULT '',
  last_checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the reading last became something different. Drives "in stock since".
  last_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_key, retailer)
);

CREATE INDEX IF NOT EXISTS watch_state_stock_idx ON watch_state (state, last_changed_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id                 BIGSERIAL PRIMARY KEY,
  product_key        TEXT NOT NULL REFERENCES products(key) ON DELETE CASCADE,
  retailer           TEXT NOT NULL,
  state              TEXT NOT NULL,
  confidence         TEXT NOT NULL DEFAULT 'unknown',
  price              NUMERIC(10, 2),
  seller_kind        TEXT NOT NULL DEFAULT 'unknown',
  seller_name        TEXT NOT NULL DEFAULT '',
  available_quantity INTEGER,
  note               TEXT NOT NULL DEFAULT '',
  at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS observations_product_idx ON observations (product_key, at DESC);
