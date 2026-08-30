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
-- Who this belongs to
-- ---------------------------------------------------------------------------
--
-- Added while the system had four missions and one user, deliberately. Once
-- checkout exists, adding an ownership boundary means touching every path that
-- can spend money on a system that is already spending it -- and a bug in the
-- filter would spend the wrong person's money rather than merely showing them
-- the wrong page. This is the cheapest hour this work will ever cost.
--
-- What is NOT here is as important as what is. No password, no address, no
-- card. Sign-in comes later and will use Supabase's own auth rather than this
-- table storing anyone's secrets; residency.test.ts fails the build if a
-- column ever appears that could hold one.
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  -- A label for a person, not a credential. "danru", "the spare laptop".
  handle      TEXT NOT NULL UNIQUE,
  -- SHA-256 of the ingest token this user's Watcher presents. Hashed, never
  -- stored plainly: a leaked database must not hand anyone the ability to
  -- impersonate a Watcher, which is the same standard a password gets.
  token_hash  TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Everything that existed before ownership did belongs to the first user.
INSERT INTO users (id, handle) VALUES (1, 'owner') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1));

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

-- Was this product's name minted from a URL slug rather than typed?
--
-- A slug is lossy: Target encodes "Pokémon" as "pok-233-mon", which titleises
-- into "Pok 233 Mon Trading Card Game 30th Celebration Elite Trainer Box". The
-- retailer's own page states the real name, so the first successful read
-- replaces a guess and clears this flag. A name a person typed is never a
-- guess and is never overwritten.
ALTER TABLE products ADD COLUMN IF NOT EXISTS name_is_guess BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Account settings
-- ---------------------------------------------------------------------------
--
-- Things that are true of every mission rather than of one. Kept as key/value
-- rather than columns on a settings row, because Half B will want to add to
-- this and a migration per preference is a bad trade.
--
-- Money lives here, so the values are validated in store.ts before they land.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ---------------------------------------------------------------------------
-- Ownership
-- ---------------------------------------------------------------------------
--
-- On every table, including the ones that could reach a user through a join.
-- The filter is a money-safety boundary now, not a privacy nicety, and a join
-- somebody forgets is worse than a column they cannot.
--
-- DEFAULT 1 so existing rows land with the original owner and the column can
-- be NOT NULL from the start.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS sources_user_idx ON sources (user_id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS products_user_idx ON products (user_id);
ALTER TABLE aliases ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS aliases_user_idx ON aliases (user_id);
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS discoveries_user_idx ON discoveries (user_id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS events_user_idx ON events (user_id);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS listings_user_idx ON listings (user_id);
ALTER TABLE missions ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS missions_user_idx ON missions (user_id);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS settings_user_idx ON settings (user_id);
ALTER TABLE mission_runs ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS mission_runs_user_idx ON mission_runs (user_id);
ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS watch_state_user_idx ON watch_state (user_id);
ALTER TABLE observations ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS observations_user_idx ON observations (user_id);

-- ---------------------------------------------------------------------------
-- Uniqueness, per owner
-- ---------------------------------------------------------------------------
--
-- Every constraint below was written when there was one user, and every one of
-- them would now stop a second person watching a product the first already
-- watches. Worse than stopping: `products` is upserted ON CONFLICT (key), so a
-- second user minting the same key would silently *overwrite the first user's
-- product*. Cross-user corruption, quietly, on an ordinary add.
--
-- So these become per-owner. The text primary keys — products.key,
-- settings.key, sources.id — are minted per user and collide across users, so
-- the identity is the pair.
--
-- The order matters: a key cannot be dropped while a foreign key points at it.

-- 1. Release the foreign keys.
ALTER TABLE aliases     DROP CONSTRAINT IF EXISTS aliases_product_key_fkey;
ALTER TABLE listings    DROP CONSTRAINT IF EXISTS listings_product_key_fkey;
ALTER TABLE discoveries DROP CONSTRAINT IF EXISTS discoveries_source_id_fkey;

-- 2. Replace the single-column identities with per-owner ones.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS products_owner_key_idx ON products (user_id, key);

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS settings_owner_key_idx ON settings (user_id, key);

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS sources_owner_id_idx ON sources (user_id, id);

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_retailer_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS listings_owner_retailer_external_idx
  ON listings (user_id, retailer, external_id);

ALTER TABLE aliases DROP CONSTRAINT IF EXISTS aliases_kind_retailer_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS aliases_owner_kind_retailer_value_idx
  ON aliases (user_id, kind, retailer, value);

ALTER TABLE discoveries DROP CONSTRAINT IF EXISTS discoveries_source_id_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS discoveries_owner_source_external_idx
  ON discoveries (user_id, source_id, external_id);

-- 3. Point the foreign keys at the new identities.
--
-- ADD CONSTRAINT has no IF NOT EXISTS, and this file is run against a live
-- database every deploy, so each one is guarded by its own existence check.
-- Cascade is kept: deleting a product still takes its listings with it.
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aliases_owner_product_fkey') THEN
    ALTER TABLE aliases ADD CONSTRAINT aliases_owner_product_fkey
      FOREIGN KEY (user_id, product_key) REFERENCES products (user_id, key) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listings_owner_product_fkey') THEN
    ALTER TABLE listings ADD CONSTRAINT listings_owner_product_fkey
      FOREIGN KEY (user_id, product_key) REFERENCES products (user_id, key) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discoveries_owner_source_fkey') THEN
    ALTER TABLE discoveries ADD CONSTRAINT discoveries_owner_source_fkey
      FOREIGN KEY (user_id, source_id) REFERENCES sources (user_id, id) ON DELETE CASCADE;
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- The activity log
--
-- Everything the Watcher did, one row per check, so a question like "why is
-- Target failing" has an answer that is not "look at the terminal window that
-- scrolled past yesterday". This is the one table that deliberately breaks the
-- write-only-when-something-changed rule at the top of store.ts, because for
-- diagnosis the boring rows *are* the signal: a failure means one thing when
-- the nine checks around it succeeded and something else entirely when they
-- did not.
--
-- Three decisions worth stating, because each is a trade:
--
--   · mission_id and listing_id are NOT foreign keys. Deleting a mission must
--     not erase the record of why it was failing — that is usually the moment
--     you most want to look. They are plain numbers that may point at nothing.
--
--   · message and detail arrive already scrubbed. The Watcher takes the
--     secrets out on its own machine before posting (watcher/src/scrub.ts) and
--     the Hub scrubs again on the way out. Nothing here is trusted to be clean
--     just because the previous step said so.
--
--   · it is pruned on every write. A check every 30 seconds is ~11,500 rows a
--     day; without a ceiling this table is the whole database inside a month.
--     Seven days, and a hard row cap underneath it in case something loops.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'check'   one page read
  -- 'pass'    one time round the loop
  -- 'hub'     talking to this server went wrong
  -- 'browser' Chrome fell over, or came back
  -- 'startup' versions and configuration, once per run
  kind       TEXT NOT NULL,
  -- 'info' | 'warn' | 'error'
  level      TEXT NOT NULL DEFAULT 'info',
  retailer   TEXT NOT NULL DEFAULT '',
  mission_id BIGINT,
  listing_id BIGINT,
  state      TEXT NOT NULL DEFAULT '',
  price      NUMERIC(10, 2),
  ms         INTEGER,
  -- What the retailer said was available at that moment.
  --
  -- Here rather than only in watch_state because this is the column that
  -- answers "did stock build before the drop, or appear with it". A time
  -- series needs every reading, including the ten thousand that said the same
  -- thing; the sparse tables cannot answer it by construction.
  available_quantity INTEGER,
  message    TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS activity_recent_idx ON activity (user_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_level_idx ON activity (user_id, level, at DESC);

-- ---------------------------------------------------------------------------
-- Reviewing what a sweep found
--
-- A sweep proposes; a person decides. Three states, and the third is the one
-- that makes the feed usable: without a way to say "no, never show me this
-- again", every sweep re-offers the same thirty things you already rejected
-- and the feed becomes noise you scroll past.
--
--   'new'        found, not yet judged
--   'kept'       promoted to a product and a listing you can watch
--   'forgotten'  judged and declined; never offered again
--
-- Note that 'forgotten' is not a delete. The row stays, which is what stops
-- the next sweep rediscovering it as new — the discovery table is also the
-- memory of what has been seen.
-- ---------------------------------------------------------------------------
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
-- What the sweep thought it was, so the review list can group and explain.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '';
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT '';
-- Which query turned it up. Useful for pruning a keyword that only ever
-- returns rubbish.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS found_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS discoveries_review_idx
  ON discoveries (user_id, status, first_seen_at DESC);

-- Asking for a sweep by hand.
--
-- Same shape as missions.check_now_at, and for the same reason: a request is a
-- fact with a time on it, not a boolean somebody has to remember to clear. The
-- Watcher clears it by finishing, so a sweep that never ran stays queued rather
-- than being silently forgotten.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sweep_now_at TIMESTAMPTZ;

-- The product photo, carried from the sweep.
--
-- Target's search response already names it (item.enrichment.image_info), so a
-- find arrives with a picture rather than a line of text, and Keep can hand it
-- straight to the product. No download and no hosting: it is the retailer's own
-- CDN URL, asked for at thumbnail size.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';

-- Whether a mission may buy a pre-order.
--
-- 'skip' by default, and the default is the point. Every reader already knew
-- an offer was a pre-order — schema.org PreOrder maps to 'in' because you
-- really can put it in a basket, and Walmart says isPreOrder outright — but
-- nothing acted on it, so an armed mission would have paid for something
-- shipping in three months and reported success.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS preorder_policy TEXT NOT NULL DEFAULT 'skip';

-- A password of one's own.
--
-- The browser door used to be a single shared password that always answered
-- as user 1, while every query underneath already filtered by user_id and the
-- Watcher already carried a per-user token. So the storage was multi-user and
-- the front door was not: a second person handed the link and the password was
-- not a second account, they were the first one — able to delete his missions,
-- move his ceilings and switch his Watcher off.
--
-- PBKDF2-HMAC-SHA256, salted per user, iterations recorded in the string so
-- raising them later does not invalidate the passwords already set. Format:
--   pbkdf2$sha256$<iterations>$<salt b64url>$<derived key b64url>
--
-- Empty means this user has no browser login at all — which is the right
-- default for a row that exists only to own a Watcher token.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';

-- Names are typed by humans at a login box, so match them without case.
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower ON users (lower(handle));

-- Point Pokémon Center at the category that actually holds sealed cards.
--
-- The source was seeded as /category/new-releases, which is everything the shop
-- has just put out: Crocs, plush, string lights, and somewhere among them the
-- cards. /category/tcg-cards is 591 products and every one of them is sealed
-- TCG — and it is where the Pokémon Center exclusives live, the 30th
-- Celebration ETB and Booster Bundle and Mini Tins that Target will never
-- stock at any price.
--
-- Guarded on the old URL so it changes a row that was seeded and never one
-- somebody has since pointed somewhere deliberate.
UPDATE sources
   SET url = 'https://www.pokemoncenter.com/category/tcg-cards',
       label = 'Pokémon Center — sealed TCG'
 WHERE url = 'https://www.pokemoncenter.com/category/new-releases';

-- Walmart's seeded browse URL had rotted.
--
-- /browse/toys/trading-cards/4171_4187_1229163 now answers "This page couldn't
-- be found." The numeric category id stopped existing at some point, and
-- because nothing had ever swept Walmart the 404 sat there unnoticed for as
-- long as the source has existed.
--
-- The Watcher searches Walmart by keyword now, with facet=retailer_type:Walmart
-- to get their own stock rather than the resale market, so this URL is what the
-- app shows rather than what the Watcher fetches. It should still be true.
UPDATE sources
   SET url = 'https://www.walmart.com/search?q=pokemon+trading+cards&facet=retailer_type%3AWalmart',
       label = 'Walmart — sealed TCG'
 WHERE url = 'https://www.walmart.com/browse/toys/trading-cards/4171_4187_1229163';

-- What a find actually is, beyond its name and price.
--
-- The review card asked you to decide between keeping and forgetting while
-- telling you almost nothing: a name, a price, and the keyword that turned it
-- up. Not which shop it was at, not whether it was buyable, not whether it was
-- a pre-order — which is the difference between "watch this" and "this takes
-- your money now and ships in October".
--
-- Denormalised rather than joined. A discovery's retailer never changes, and
-- the review list is the one query that must stay cheap enough to poll.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS retailer TEXT NOT NULL DEFAULT '';
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '';
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS is_pre_order BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS release_date TEXT NOT NULL DEFAULT '';
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS order_limit INTEGER;

-- Why the sweep thought this was worth showing you.
--
-- Separate from found_by, which is the query that turned it up. Pokémon Center
-- has no queries — it is walked, not searched — so its rows were writing the
-- signal into found_by and the card read: found by "recent". True, and useless.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS signal TEXT NOT NULL DEFAULT '';

-- Backfill the retailer for everything already found, from its source.
UPDATE discoveries d
   SET retailer = s.retailer
  FROM sources s
 WHERE s.user_id = d.user_id AND s.id = d.source_id AND d.retailer = '';

-- How many other sellers are waiting behind a retailer's own listing.
--
-- Walmart's search, filtered to its own stock, returns exactly that: Walmart's
-- listing, at Walmart's price, out of stock. Truthful — and then the link goes
-- to a page where a reseller holds the buy box at forty times the money,
-- because Walmart has none and the box falls to whoever does.
--
-- Nothing was wrong with the find. What was missing was the warning, so
-- `additionalOfferCount` is carried through and said out loud on the card.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS other_offers INTEGER;

-- Relabel mini tins that were recorded before the classifier told them apart.
--
-- `kind` is deliberately never overwritten on a re-sighting: a row already
-- labelled should not be relabelled by a later sweep that guessed worse. The
-- cost of that rule is that improving the classifier never reaches rows already
-- in the ledger — and a mini tin labelled `tin` now quotes a typical price of
-- $24.99 against a real one nearer $12.99, which is exactly the number somebody
-- would anchor a ceiling to.
--
-- Narrow on purpose: only rows whose name says mini tin, only where the kind is
-- the one the old classifier would have given.
UPDATE discoveries
   SET kind = 'mini tin'
 WHERE kind = 'tin'
   AND (name ILIKE '%mini tin%' OR name ILIKE '%mini tins%');
