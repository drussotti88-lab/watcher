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
