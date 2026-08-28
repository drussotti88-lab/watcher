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
  -- What it is meant to cost. The whole point of this system is buying at
  -- retail before the resellers do, so "is this a scalper price" needs a
  -- number to compare against — and it gives a mission's ceiling a sane
  -- default instead of asking you to remember one.
  msrp          NUMERIC(10, 2),
  -- Taken from the product page: JSON-LD `image` on Pokémon Center, imageInfo
  -- on Walmart, the enrichment block on Target. Hotlinked rather than copied —
  -- these are the retailer's own CDN images of the retailer's own product.
  image_url     TEXT NOT NULL DEFAULT '',
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
-- Listings — one buyable thing, at one retailer
--
-- A product is a thing in the world. A *listing* is somewhere you can actually
-- buy it: a retailer, that retailer's id for it, and a URL. One product has
-- many listings, and — this is the part that matters — it can have several at
-- the *same* retailer.
--
-- Walmart puts every seller's offer on one item page. Target's third-party
-- sellers appear to get their own item id and their own page, though that is
-- not yet confirmed from a capture. Either way, "the Pitch Black ETB at Target"
-- is not necessarily one URL forever, so nothing is keyed on
-- (product, retailer) any more.
--
-- Today every product has one listing per retailer and `is_primary` is true.
-- The point is that adding a second one later is an INSERT, not a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
  id           BIGSERIAL PRIMARY KEY,
  product_key  TEXT NOT NULL REFERENCES products(key) ON DELETE CASCADE,
  retailer     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  -- What we last saw selling it. Walmart's third-party offers land here.
  seller_kind  TEXT NOT NULL DEFAULT 'unknown',
  seller_name  TEXT NOT NULL DEFAULT '',
  -- The listing we treat as canonical for this product at this retailer.
  is_primary   BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (retailer, external_id)
);

CREATE INDEX IF NOT EXISTS listings_product_idx ON listings (product_key);

-- ---------------------------------------------------------------------------
-- Missions — a listing, plus what you have authorised
--
-- A listing is a thing you *could* buy. A mission is the standing instruction
-- about it: watch this, and — if armed — buy this many at no more than this,
-- from this kind of seller.
--
-- ONE mission per listing, enforced. Two armed missions pointing at the same
-- listing is two purchases of the same item, and the whole point of the
-- duplicate guard in the Watcher is that this must be impossible rather than
-- merely unlikely.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS missions (
  id            BIGSERIAL PRIMARY KEY,
  listing_id    BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- Watching is free and reversible. Arming spends money.
  armed         BOOLEAN NOT NULL DEFAULT false,
  -- Never pay more than this per unit. Required before a mission may arm.
  ceiling       NUMERIC(10, 2),
  quantity      INTEGER NOT NULL DEFAULT 1,
  -- 'retailer_only' : refuse marketplace offers however cheap or available
  -- 'any'           : any seller, still subject to the ceiling
  -- Default is retailer_only, because the whole point of this is buying at
  -- retail before the resellers do. An IN_STOCK marketplace listing at 1.5x
  -- MSRP is the thing you are racing, not the thing you want.
  seller_policy TEXT NOT NULL DEFAULT 'retailer_only',
  check_every_s INTEGER NOT NULL DEFAULT 60,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS missions_active_idx ON missions (enabled, armed);

-- "Test run": check this one now, whatever its schedule says.
--
-- A request, not a command. The Watcher is the only thing with a browser, and
-- it is the only thing that knows whether the retailer will have us — so this
-- sets a flag the next pass picks up, jumping the mission queue but never the
-- per-retailer floor. Cleared when a reading for that listing arrives, which is
-- the only honest signal that the run actually happened.
--
-- ADD COLUMN IF NOT EXISTS rather than a new table: schema.sql is run against a
-- live database by `npm run db:push`, so every statement in it has to be safe
-- to run twice.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS check_now_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Mission runs — what happened, and why
--
-- NOT one row per poll. A mission checking a static product every minute for a
-- week would bury the four rows that matter under ten thousand that say
-- "still out of stock".
--
-- A run is written when the mission *did something or could not*:
--   · stock appeared and the mission acted (or declined to, with a reason)
--   · a check failed — challenged, unreadable, the retailer errored
--
-- Every non-success carries a reason in words. "failed" with no reason is the
-- log entry you find at 3am and learn nothing from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mission_runs (
  id          BIGSERIAL PRIMARY KEY,
  mission_id  BIGINT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- 'running' until it settles, then one of:
  --   'in_stock'  saw stock, mission not armed — reported only
  --   'bought'    a purchase completed
  --   'declined'  armed, but a rule said no (over ceiling, wrong seller, cap)
  --   'failed'    something broke; reason says what
  --   'blocked'   the retailer served a challenge rather than a page
  outcome     TEXT NOT NULL DEFAULT 'running',
  reason      TEXT NOT NULL DEFAULT '',
  -- What the page said at the moment this run fired.
  state       TEXT NOT NULL DEFAULT '',
  price       NUMERIC(10, 2),
  seller_kind TEXT NOT NULL DEFAULT '',
  seller_name TEXT NOT NULL DEFAULT '',
  quantity    INTEGER,
  total       NUMERIC(10, 2),
  ms          INTEGER
);

CREATE INDEX IF NOT EXISTS mission_runs_recent_idx ON mission_runs (mission_id, started_at DESC);
CREATE INDEX IF NOT EXISTS mission_runs_feed_idx ON mission_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- What the Watcher saw
--
-- Two tables on purpose, because "what is true now" and "what happened" want
-- different shapes and different write rates. Both key on a LISTING, not on a
-- product — a product can be sold twice over at one retailer.
--
--   watch_state   one row per listing. Upserted on every check, so the page can
--                 always say how stale a reading is. A page that cannot tell
--                 you it is out of date is worse than no page.
--
--   observations  append-only history, written ONLY when something material
--                 changed — state, price, or seller. Polling every minute for a
--                 week is ten thousand checks and, for a product that never
--                 moves, zero rows. That is what makes the history readable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watch_state (
  listing_id         BIGINT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
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
  last_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS watch_state_stock_idx ON watch_state (state, last_changed_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id                 BIGSERIAL PRIMARY KEY,
  listing_id         BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  state              TEXT NOT NULL,
  confidence         TEXT NOT NULL DEFAULT 'unknown',
  price              NUMERIC(10, 2),
  seller_kind        TEXT NOT NULL DEFAULT 'unknown',
  seller_name        TEXT NOT NULL DEFAULT '',
  available_quantity INTEGER,
  note               TEXT NOT NULL DEFAULT '',
  at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS observations_listing_idx ON observations (listing_id, at DESC);
