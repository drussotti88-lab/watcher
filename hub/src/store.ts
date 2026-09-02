/**
 * Every SQL read and write. The rest of the Hub never writes SQL.
 *
 * Write discipline, kept from the D1 version even though Postgres is less
 * stingy: we only write when something actually changed — a new discovery, an
 * announcement flipping, a source's status line. Never a row per poll. The
 * reason was never really the quota; it is that a table with one row per poll
 * is unreadable, and this data is meant to be looked at.
 *
 * Two Postgres facts this file exists to absorb:
 *   · NUMERIC comes back as a string, to preserve precision. Prices are
 *     coerced here so nothing above ever compares a string to a number.
 *   · flags are real booleans now, not 0/1. `seeded === 1` is gone.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────
 *
 * Every function here takes a `userId` as its second argument and every query
 * filters on it. That is not tidiness: once checkout exists, a query that
 * forgets it spends the wrong person's money. The compiler catches a call site
 * that omits the argument; only a test catches SQL that ignores it, which is
 * why there is one isolation test per table in ownership.test.ts.
 */
import type { Sql, Statement } from './db.ts';
import type { Discovered, SourceRow, SourceConfig } from './types.ts';
import { productKey } from './parsers/identify.ts';

/** Postgres hands NUMERIC back as a string. Never let that leak upwards. */
function toPrice(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  // Zero is not a price. Same rule as the readers, for the same reason.
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A DATE column, as a plain YYYY-MM-DD string.
 *
 * The driver hands DATE back as a JavaScript Date, not a string, so the
 * obvious `String(v).slice(0, 10)` yields "Sat Sep 26" — a release date that
 * looks almost right, sorts wrong, and has lost the year. Half B's whole job
 * is knowing which day money is needed on, so this is coerced in one place.
 *
 * Deliberately UTC: the value in the column is a calendar date with no time
 * in it, and running it through a local timezone is how a release date moves
 * a day for anyone west of Greenwich.
 */
function toDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** JSONB arrives parsed; a TEXT column would arrive as a string. Take either. */
function toConfig(v: unknown): SourceConfig {
  if (v && typeof v === 'object') return v as SourceConfig;
  try {
    return JSON.parse(String(v || '{}')) as SourceConfig;
  } catch {
    return {};
  }
}

function toSource(row: Record<string, unknown>): SourceRow {
  return {
    id: String(row.id),
    label: String(row.label ?? ''),
    retailer: String(row.retailer ?? ''),
    kind: row.kind as SourceRow['kind'],
    url: String(row.url ?? ''),
    via: row.via as SourceRow['via'],
    config: toConfig(row.config),
    enabled: row.enabled === true,
    seeded: row.seeded === true,
    cursor: Number(row.cursor ?? 0),
    lastSweptAt: row.last_swept_at ? String(row.last_swept_at) : null,
    sweepNowAt: row.sweep_now_at ? String(row.sweep_now_at) : null,
    lastStatus: String(row.last_status ?? ''),
    lastCount: Number(row.last_count ?? 0),
  };
}

export async function listSources(db: Sql, userId: number, via?: string): Promise<SourceRow[]> {
  const rows = via
    ? await db.query(
        'SELECT * FROM sources WHERE user_id = $1 AND enabled = true AND via = $2 ORDER BY id',
        [userId, via],
      )
    : await db.query('SELECT * FROM sources WHERE user_id = $1 AND enabled = true ORDER BY id', [
        userId,
      ]);
  return rows.map(toSource);
}

/** Every source, enabled or not. For diagnostics, which must hide nothing. */
export async function listAllSources(db: Sql, userId: number): Promise<SourceRow[]> {
  const rows = await db.query(
    'SELECT * FROM sources WHERE user_id = $1 ORDER BY retailer, id',
    [userId],
  );
  return rows.map(toSource);
}

export async function getSource(db: Sql, userId: number, id: string): Promise<SourceRow | null> {
  const rows = await db.query('SELECT * FROM sources WHERE user_id = $1 AND id = $2', [userId, id]);
  return rows[0] ? toSource(rows[0]) : null;
}

/** Which of these external ids do we already know about for this source? */
export async function knownIds(db: Sql, userId: number, sourceId: string): Promise<Set<string>> {
  const rows = await db.query<{ external_id: string }>(
    'SELECT external_id FROM discoveries WHERE user_id = $1 AND source_id = $2',
    [userId, sourceId],
  );
  return new Set(rows.map((r) => r.external_id));
}

/**
 * Record newly-seen products.
 *
 * `announce` is false on a source's first ever sweep — that seeds the ledger
 * silently instead of announcing an entire back catalogue. Returns the rows
 * that should actually be announced.
 *
 * The whole set goes in one transaction. If the batch dies halfway, we would
 * rather record nothing and re-see them next sweep than record half and treat
 * the other half as old news forever.
 */
export async function recordDiscoveries(
  db: Sql,
  userId: number,
  sourceId: string,
  items: Discovered[],
  announce: boolean,
): Promise<Discovered[]> {
  if (items.length === 0) return [];

  const statements: Statement[] = items.map((item) => ({
    // ── Why this is DO UPDATE and not DO NOTHING ──────────────────────────
    //
    // It was DO NOTHING, and that made `found_by` a lie. The same TCIN comes
    // back for half a dozen different queries, so the first query to run
    // claimed every product and the twelve after it appeared to have found
    // nothing — which looks exactly like a sweep that is not working, and
    // makes the field useless for the one job the schema says it has: telling
    // you which keyword is earning its place.
    //
    // So a repeat sighting appends its query instead of being discarded. The
    // comparison is against a comma-delimited list rather than a bare
    // substring, or "pokemon tin" would match inside "pokemon tin bundle" and
    // silently stop recording it.
    //
    // kind and confidence fill in only when blank, so a row added before the
    // classifier existed gets labelled the next time it is seen, and a row
    // already labelled is never relabelled by a query that guessed worse.
    text: `INSERT INTO discoveries
             (user_id, source_id, external_id, url, name, price, announced, kind, confidence,
              found_by, image_url, retailer, state, is_pre_order, release_date, order_limit,
              signal, other_offers, available_quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                   $18, $19)
           ON CONFLICT (source_id, external_id) DO UPDATE SET
             found_by = CASE
               WHEN EXCLUDED.found_by = '' THEN discoveries.found_by
               WHEN discoveries.found_by = '' THEN EXCLUDED.found_by
               WHEN position(', ' || EXCLUDED.found_by || ', '
                             IN ', ' || discoveries.found_by || ', ') > 0
                 THEN discoveries.found_by
               WHEN length(discoveries.found_by) > 400 THEN discoveries.found_by
               ELSE discoveries.found_by || ', ' || EXCLUDED.found_by
             END,
             kind = CASE WHEN discoveries.kind = '' THEN EXCLUDED.kind ELSE discoveries.kind END,
             confidence = CASE
               WHEN discoveries.confidence = '' THEN EXCLUDED.confidence
               ELSE discoveries.confidence
             END,
             -- Filled when blank, never replaced. A working image beats a
             -- newer one: these CDN URLs churn and the old one still renders.
             image_url = CASE
               WHEN discoveries.image_url = '' THEN EXCLUDED.image_url
               ELSE discoveries.image_url
             END,
             -- These four are the opposite case from image_url and kind: they
             -- describe the offer *right now*, so the newest sighting wins.
             -- A find that has come back into stock, or had its street date
             -- moved, must say so rather than keep the first thing we saw.
             state = EXCLUDED.state,
             is_pre_order = EXCLUDED.is_pre_order,
             release_date = EXCLUDED.release_date,
             signal = EXCLUDED.signal,
             other_offers = EXCLUDED.other_offers,
             price = COALESCE(EXCLUDED.price, discoveries.price),
             order_limit = COALESCE(EXCLUDED.order_limit, discoveries.order_limit),
             -- Newest wins, blanks included. This one describes the shelf at
             -- the moment of the sweep, so keeping an older number because it
             -- was bigger would turn a drained drop into a standing alarm.
             available_quantity = EXCLUDED.available_quantity,
             retailer = CASE
               WHEN discoveries.retailer = '' THEN EXCLUDED.retailer
               ELSE discoveries.retailer
             END`,
    params: [
      userId,
      sourceId,
      item.externalId,
      item.url,
      item.name,
      item.price ?? null,
      !announce,
      item.kind ?? '',
      item.confidence ?? '',
      item.foundBy ?? '',
      (item.imageUrl ?? '').slice(0, 500),
      item.retailer ?? '',
      item.state ?? '',
      item.isPreOrder === true,
      item.releaseDate ?? '',
      item.orderLimit ?? null,
      item.signal ?? '',
      item.otherOffers ?? null,
      Number.isFinite(item.availableQuantity as number) ? item.availableQuantity : null,
    ],
  }));
  await db.batch(statements);
  return announce ? items : [];
}

export async function markAnnounced(
  db: Sql,
  userId: number,
  sourceId: string,
  externalIds: string[],
): Promise<void> {
  if (externalIds.length === 0) return;
  await db.query(
    `UPDATE discoveries SET announced = true
      WHERE user_id = $1 AND source_id = $2 AND external_id = ANY($3)`,
    [userId, sourceId, externalIds],
  );
}

/** Discoveries a source has seen but not yet announced. */
export async function pendingDiscoveries(
  db: Sql,
  userId: number,
  sourceId: string,
): Promise<Discovered[]> {
  const rows = await db.query(
    `SELECT external_id, name, url, price FROM discoveries
      WHERE user_id = $1 AND source_id = $2 AND announced = false ORDER BY id`,
    [userId, sourceId],
  );
  return rows.map((r) => ({
    externalId: String(r.external_id),
    name: String(r.name ?? ''),
    url: String(r.url ?? ''),
    price: toPrice(r.price),
  }));
}

/**
 * Give a discovery an identity, unless an alias already claims it.
 *
 * The Hub mints the key; the retailer's id becomes an alias pointing at it. A
 * retailer changing its SKU is then an alias edit rather than a migration.
 */
export async function attachIdentity(
  db: Sql,
  userId: number,
  sourceId: string,
  retailer: string,
  item: Discovered,
): Promise<string> {
  const existing = await db.query<{ product_key: string }>(
    `SELECT product_key FROM aliases
      WHERE user_id = $1 AND kind = $2 AND retailer = $3 AND value = $4`,
    [userId, 'retailer_sku', retailer, item.externalId],
  );
  if (existing[0]?.product_key) return existing[0].product_key;

  const key = productKey(item.name, item.externalId);
  await db.batch([
    {
      text: `INSERT INTO products (user_id, key, name) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO NOTHING`,
      params: [userId, key, item.name],
    },
    {
      text: `INSERT INTO aliases (user_id, product_key, kind, retailer, value)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (kind, retailer, value) DO NOTHING`,
      params: [userId, key, 'retailer_sku', retailer, item.externalId],
    },
    {
      text: `UPDATE discoveries SET product_key = $1
              WHERE user_id = $2 AND source_id = $3 AND external_id = $4`,
      params: [key, userId, sourceId, item.externalId],
    },
  ]);
  return key;
}

export async function finishSweep(
  db: Sql,
  userId: number,
  sourceId: string,
  status: string,
  count: number,
  seeded: boolean,
  cursor = 0,
  /**
   * Is the sweep actually over?
   *
   * A Phantom-side sweep is thirteen queries reported one at a time, and every
   * one of them used to stamp last_swept_at and clear the manual request. So a
   * sweep marked itself finished after its first query: a restart part-way
   * through lost the remaining twelve *and* left nothing due for another day.
   * Only the last query completes a sweep.
   */
  complete = true,
): Promise<void> {
  if (!complete) {
    await db.query(
      `UPDATE sources SET last_status = $1, last_count = $2, seeded = $3
        WHERE user_id = $4 AND id = $5`,
      [status.slice(0, 300), count, seeded, userId, sourceId],
    );
    return;
  }
  await db.query(
    `UPDATE sources
        SET last_swept_at = now(), last_status = $1, last_count = $2,
            seeded = $3, cursor = $4,
            -- Cleared by finishing, never by asking. A sweep that was requested
            -- and never ran stays queued instead of being quietly dropped.
            sweep_now_at = NULL
      WHERE user_id = $5 AND id = $6`,
    [status.slice(0, 300), count, seeded, cursor, userId, sourceId],
  );
}

export async function logEvent(
  db: Sql,
  userId: number,
  kind: string,
  message: string,
  data: unknown = null,
): Promise<void> {
  await db.query('INSERT INTO events (user_id, kind, message, data) VALUES ($1, $2, $3, $4)', [
    userId,
    kind,
    message.slice(0, 1000),
    data === null || data === undefined ? null : JSON.stringify(data).slice(0, 4000),
  ]);
}

/**
 * What Phantom should be looking at.
 *
 * Everything with a retailer alias and a URL we can reach. Phantom pulls
 * this on every run rather than holding its own list, so adding a watch is one
 * row here and never a redeploy of the thing on the desk.
 */
export interface WatchRow {
  listingId: number;
  productKey: string;
  name: string;
  retailer: string;
  externalId: string;
  url: string;
  releaseDate: string | null;
}

export async function watchlist(db: Sql, userId: number): Promise<WatchRow[]> {
  const rows = await db.query(
    `SELECT l.id, l.product_key, p.name, p.release_date, l.retailer, l.external_id, l.url
       FROM listings l
       JOIN products p ON p.key = l.product_key
      ORDER BY p.name, l.retailer`,
  );
  return rows.map((r) => ({
    listingId: Number(r.id),
    productKey: String(r.product_key),
    name: String(r.name ?? ''),
    retailer: String(r.retailer ?? ''),
    externalId: String(r.external_id ?? ''),
    url: String(r.url ?? ''),
    releaseDate: toDate(r.release_date),
  }));
}

// ─── Products ────────────────────────────────────────────────────────────────

export interface ProductRow {
  key: string;
  name: string;
  releaseDate: string | null;
  msrp: number | null;
  imageUrl: string;
  notes: string;
}

function toProduct(r: Record<string, unknown>): ProductRow {
  return {
    key: String(r.key),
    name: String(r.name ?? ''),
    releaseDate: toDate(r.release_date),
    msrp: toPrice(r.msrp),
    imageUrl: String(r.image_url ?? ''),
    notes: String(r.notes ?? ''),
  };
}

/**
 * Mint a product key from its name.
 *
 * Deterministic, so adding the same product twice by hand is idempotent rather
 * than producing two products that will never agree with each other.
 */
export function keyForName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `prd_${slug || 'unnamed'}`;
}

/**
 * The catalogue. Shared, so `userId` is not a filter here any more — it is
 * kept in the signature because every caller has it and a reader that quietly
 * stops taking it is a reader nobody notices has changed meaning.
 */
export async function listProducts(db: Sql, _userId: number): Promise<ProductRow[]> {
  const rows = await db.query('SELECT * FROM products ORDER BY name');
  return rows.map(toProduct);
}

export interface ProductInput {
  key?: string;
  name: string;
  /** True when the name came from a URL slug rather than from a person. */
  nameIsGuess?: boolean;
  releaseDate?: string | null;
  msrp?: number | null;
  imageUrl?: string;
  notes?: string;
}

/**
 * Everything optional here is genuinely optional.
 *
 * Worth stating because it was not always true: the add-product form read the
 * name via `form.name`, which is the form's *own* name attribute rather than
 * the input called "name" — so every submission sent an empty name and came
 * back "a product needs a name". The only field left to suspect was the date,
 * which is why it looked required when it never was.
 */
export function validateProduct(p: ProductInput): string | null {
  if (!p.name?.trim()) return 'a product needs a name';
  if (p.name.trim().length > 200) return 'that name is too long';
  if (p.msrp !== undefined && p.msrp !== null && !(p.msrp > 0)) {
    return 'MSRP must be greater than zero, or left blank';
  }
  if (p.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.releaseDate)) {
    return 'a release date must look like 2026-09-26';
  }
  if (p.imageUrl && !/^https?:\/\//i.test(p.imageUrl)) {
    return 'an image URL must start with http:// or https://';
  }
  return null;
}

export async function upsertProduct(
  db: Sql,
  userId: number,
  p: ProductInput,
): Promise<ProductRow> {
  const problem = validateProduct(p);
  if (problem) throw new Error(problem);

  const key = p.key?.trim() || keyForName(p.name);
  const rows = await db.query(
    `INSERT INTO products (user_id, key, name, release_date, msrp, image_url, notes, name_is_guess)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     -- (user_id, key), not (key): two people minting the same key from the same
     -- product name would otherwise have the second silently overwrite the
     -- first's product. Cross-user corruption, on an ordinary add.
     ON CONFLICT (key) DO UPDATE SET
       name = EXCLUDED.name,
       name_is_guess = EXCLUDED.name_is_guess,
       -- COALESCE, not EXCLUDED: an edit that omits a field must not blank a
       -- value someone already took the trouble to set.
       release_date = COALESCE(EXCLUDED.release_date, products.release_date),
       msrp = COALESCE(EXCLUDED.msrp, products.msrp),
       image_url = CASE WHEN EXCLUDED.image_url = '' THEN products.image_url ELSE EXCLUDED.image_url END,
       notes = CASE WHEN EXCLUDED.notes = '' THEN products.notes ELSE EXCLUDED.notes END
     RETURNING *`,
    [
      userId,
      key,
      p.name.trim(),
      p.releaseDate || null,
      p.msrp ?? null,
      p.imageUrl ?? '',
      p.notes ?? '',
      p.nameIsGuess === true,
    ],
  );
  return toProduct(rows[0]!);
}

/** Only ever set an image we actually read off a page; never blank an existing one. */
export async function setProductImage(
  db: Sql,
  userId: number,
  key: string,
  imageUrl: string,
): Promise<void> {
  if (!imageUrl) return;
  await db.query(
    `UPDATE products SET image_url = $1
      WHERE user_id = $2 AND key = $3 AND image_url = ''`,
    [imageUrl, userId, key],
  );
}

export async function deleteProduct(db: Sql, userId: number, key: string): Promise<boolean> {
  // Listings, missions, runs and observations all cascade from here.
  //
  // Returns whether a row was actually removed, which is not pedantry: the
  // Deleting from a shared catalogue is a catalogue write, so the caller must
  // hold the role. The old user_id filter cannot do this job any more: it would
  // let anyone delete anything they happened to have catalogued first, and stop
  // the owner tidying up a row a member created.
  if (!(await canWriteCatalogue(db, userId))) return false;
  const rows = await db.query<{ key: string }>(
    'DELETE FROM products WHERE key = $1 RETURNING key',
    [key],
  );
  return rows.length > 0;
}

// ─── Listings ────────────────────────────────────────────────────────────────

export interface ListingRow {
  id: number;
  productKey: string;
  productName: string;
  retailer: string;
  externalId: string;
  url: string;
  sellerKind: string;
  sellerName: string;
  isPrimary: boolean;
}

function toListing(r: Record<string, unknown>): ListingRow {
  return {
    id: Number(r.id),
    productKey: String(r.product_key),
    productName: String(r.product_name ?? ''),
    retailer: String(r.retailer ?? ''),
    externalId: String(r.external_id ?? ''),
    url: String(r.url ?? ''),
    sellerKind: String(r.seller_kind ?? 'unknown'),
    sellerName: String(r.seller_name ?? ''),
    isPrimary: r.is_primary === true,
  };
}

/** The listing for this retailer + id, if we already track it. */
export async function findListing(
  db: Sql,
  userId: number,
  retailer: string,
  externalId: string,
): Promise<ListingRow | null> {
  const rows = await db.query(
    `SELECT l.*, p.name AS product_name FROM listings l
       JOIN products p ON p.key = l.product_key
      WHERE l.retailer = $1 AND l.external_id = $2`,
    [retailer.trim(), externalId.trim()],
  );
  return rows[0] ? toListing(rows[0]) : null;
}

export async function listListings(
  db: Sql,
  userId: number,
  productKey?: string,
): Promise<ListingRow[]> {
  const sql = `SELECT l.*, p.name AS product_name FROM listings l
                 JOIN products p ON p.key = l.product_key
                ${productKey ? 'WHERE l.product_key = $1' : ''}
                ORDER BY p.name, l.retailer`;
  const rows = productKey ? await db.query(sql, [productKey]) : await db.query(sql);
  return rows.map(toListing);
}

export async function addListing(
  db: Sql,
  userId: number,
  l: { productKey: string; retailer: string; externalId: string; url: string },
): Promise<ListingRow> {
  const rows = await db.query(
    `INSERT INTO listings (user_id, product_key, retailer, external_id, url)
     VALUES ($1, $2, $3, $4, $5)
     -- One listing per tcin for everybody. Two people both watching it is two
     -- MISSIONS against this one row — which is the whole point of the shared
     -- catalogue, and why missions are unique per (user, listing) instead.
     ON CONFLICT (retailer, external_id) DO UPDATE SET
       url = EXCLUDED.url,
       product_key = EXCLUDED.product_key
     RETURNING *`,
    [userId, l.productKey, l.retailer.trim(), l.externalId.trim(), l.url.trim()],
  );
  const [full] = await db.query(
    `SELECT l.*, p.name AS product_name FROM listings l
       JOIN products p ON p.key = l.product_key
      WHERE l.id = $1`,
    [rows[0]!.id],
  );
  return toListing(full!);
}

export async function deleteListing(db: Sql, userId: number, id: number): Promise<boolean> {
  // A catalogue write. See deleteProduct.
  if (!(await canWriteCatalogue(db, userId))) return false;
  const rows = await db.query<{ id: number }>(
    'DELETE FROM listings WHERE id = $1 RETURNING id',
    [id],
  );
  return rows.length > 0;
}

// ─── Missions ────────────────────────────────────────────────────────────────

export type SellerPolicy = 'retailer_only' | 'any';

/**
 * Whether a mission may buy something that is orderable but not in stock.
 *
 * A pre-order takes the money now and delivers when the publisher says. On a
 * mission set up to catch a restock that is a surprise, and surprises about
 * money are what this system exists to prevent — so 'skip' is the default and
 * allowing it is a deliberate act.
 */
export type PreOrderPolicy = 'skip' | 'allow';

export interface MissionInput {
  listingId: number;
  label?: string;
  enabled?: boolean;
  armed?: boolean;
  /** Post this one to Discord. Defaults to true; see MissionRow.alerts. */
  alerts?: boolean;
  ceiling?: number | null;
  quantity?: number;
  sellerPolicy?: SellerPolicy;
  preOrderPolicy?: PreOrderPolicy;
  checkEverySeconds?: number;
  notes?: string;
}

// ── Who is asking ────────────────────────────────────────────────────────────

/**
 * May this account write to the shared catalogue?
 *
 * ── What this replaces, and why it is stronger ──────────────────────────────
 *
 * The rule used to be "a Phantom may write a reading only to a listing its own
 * user owns". That was load-bearing: it is what stopped one person's agent
 * telling another person's ARMED mission that a $500 box is in stock at $5.
 * Shared listings dissolve it — everybody's listing is everybody's listing —
 * so the check has to become about the WRITER instead of the row.
 *
 * This is stronger than what it replaces, for two reasons. A member's Phantom
 * can now write no reading at all, rather than writing freely within its own
 * rows; and it is one flag read in one place rather than an ownership
 * comparison repeated in every write path, which is the kind of check that
 * eventually gets forgotten in one of them.
 *
 * Fails CLOSED on a missing or disabled user: no row, no permission.
 */
export async function canWriteCatalogue(db: Sql, userId: number): Promise<boolean> {
  const rows = await db.query<{ can: boolean }>(
    'SELECT can_write_catalogue AS can FROM users WHERE id = $1 AND enabled = true',
    [userId],
  );
  return rows[0]?.can === true;
}

/**
 * May this account arm a mission — that is, instruct a machine to spend?
 *
 * Deliberately SEPARATE from `can_write_catalogue`, though today one account
 * holds both. They are different questions and will come apart: a trusted
 * member could one day run their own agent and buy on their own card without
 * ever earning the right to edit the catalogue everyone else depends on.
 * Collapsing them now would mean untangling them exactly when the stakes rise.
 *
 * Fails CLOSED, like every permission here.
 */
export async function canArm(db: Sql, userId: number): Promise<boolean> {
  const rows = await db.query<{ can: boolean }>(
    'SELECT can_arm AS can FROM users WHERE id = $1 AND enabled = true',
    [userId],
  );
  return rows[0]?.can === true;
}

/** How many users exist. Used by /health to prove the database answers. */
export async function countUsers(db: Sql): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

/**
 * Whose Phantom presents this token?
 *
 * Takes the hash, never the token: the column holds a hash and the comparison
 * happens in the database on hashes alone, so a leaked table is not a set of
 * working credentials.
 */
export async function userByTokenHash(db: Sql, tokenHash: string): Promise<number> {
  if (!tokenHash) return 0;
  const rows = await db.query<{ id: number }>(
    "SELECT id FROM users WHERE enabled = true AND token_hash <> '' AND token_hash = $1",
    [tokenHash],
  );
  return Number(rows[0]?.id ?? 0);
}

/** A person who can sign in. Never carries the password hash out of here. */
export interface UserRow {
  id: number;
  handle: string;
  enabled: boolean;
  hasPassword: boolean;
  hasToken: boolean;
  createdAt: string;
}

/**
 * Find a user by the name they typed, with their stored hash.
 *
 * Returns the hash because the caller has to verify it, and returns it from
 * exactly one function so there is exactly one place to check that it never
 * goes anywhere else. Disabled users are not found at all: switching somebody
 * off should not leave a door that answers "wrong password".
 */
export async function userForLogin(
  db: Sql,
  handle: string,
): Promise<{ id: number; passwordHash: string } | null> {
  const name = String(handle ?? '').trim();
  if (!name) return null;
  const rows = await db.query<{ id: number; password_hash: string }>(
    `SELECT id, password_hash FROM users
      WHERE enabled = true AND password_hash <> '' AND lower(handle) = lower($1)`,
    [name],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), passwordHash: row.password_hash } : null;
}

/** The name to show in the header, so it is obvious whose dashboard this is. */
export async function userHandle(db: Sql, userId: number): Promise<string> {
  const rows = await db.query<{ handle: string }>('SELECT handle FROM users WHERE id = $1', [
    userId,
  ]);
  return String(rows[0]?.handle ?? '');
}

/** Everyone with an account, for the admin CLI. No secrets in the result. */
export async function listUsers(db: Sql): Promise<UserRow[]> {
  const rows = await db.query<{
    id: number;
    handle: string;
    enabled: boolean;
    has_password: boolean;
    has_token: boolean;
    created_at: string;
  }>(
    `SELECT id, handle, enabled,
            password_hash <> '' AS has_password,
            token_hash <> ''    AS has_token,
            created_at
       FROM users ORDER BY id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    handle: r.handle,
    enabled: Boolean(r.enabled),
    hasPassword: Boolean(r.has_password),
    hasToken: Boolean(r.has_token),
    createdAt: String(r.created_at),
  }));
}

/** Look one up by name whatever their state, so the CLI can say what exists. */
export async function findUser(db: Sql, handle: string): Promise<UserRow | null> {
  const all = await listUsers(db);
  return all.find((u) => u.handle.toLowerCase() === String(handle ?? '').trim().toLowerCase()) ?? null;
}

/**
 * Create a person, or set the password of one who already exists.
 *
 * Takes a hash, never a password: the hashing happens in the caller so that
 * this module never holds a plaintext password even briefly, and so the CLI
 * that reads one off a terminal is the only thing that ever has.
 */
export async function upsertUser(
  db: Sql,
  handle: string,
  passwordHash: string,
): Promise<number> {
  const name = String(handle ?? '').trim();
  if (!name) throw new Error('a user needs a handle');
  const rows = await db.query<{ id: number }>(
    `INSERT INTO users (handle, password_hash) VALUES ($1, $2)
     ON CONFLICT (handle) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [name, passwordHash],
  );
  return Number(rows[0]?.id ?? 0);
}

/**
 * Give a user's Phantom its own token, by storing the hash of one.
 *
 * Takes a hash for the same reason `upsertUser` takes one: the token itself
 * exists for a moment in the CLI that generated it and in the file it is
 * written to, and nowhere else. A leaked users table is then a list of hashes,
 * not a set of working credentials.
 */
export async function setUserToken(db: Sql, handle: string, tokenHash: string): Promise<boolean> {
  const rows = await db.query<{ id: number }>(
    'UPDATE users SET token_hash = $2 WHERE lower(handle) = lower($1) RETURNING id',
    [String(handle ?? '').trim(), tokenHash],
  );
  return rows.length > 0;
}

/** Switch an account on or off. Their data stays; their way in does not. */
export async function setUserEnabled(db: Sql, handle: string, enabled: boolean): Promise<boolean> {
  const rows = await db.query<{ id: number }>(
    'UPDATE users SET enabled = $2 WHERE lower(handle) = lower($1) RETURNING id',
    [String(handle ?? '').trim(), enabled],
  );
  return rows.length > 0;
}

// ── Account settings ─────────────────────────────────────────────────────────

/**
 * What is true of every mission rather than of one.
 *
 * Both of these exist because a price ceiling on the item alone is not a limit
 * on what leaves your account.
 */
export interface Settings {
  /**
   * Sales tax rate, as a fraction. 0.0975 is 9.75%.
   *
   * Used for two things: suggesting a ceiling from a product's MSRP, and
   * judging a listed price before checkout — a listed price is always pre-tax,
   * and the ceiling is not.
   *
   * Zero is a legitimate answer and means "do not estimate". Tax is then
   * checked only in the cart, where it is a real number rather than a guess.
   */
  taxRate: number;
  /**
   * The most to pay for shipping on any one order, on top of the ceiling.
   *
   * Deliberately separate from the ceiling rather than folded into it. Shipping
   * is per order and the ceiling is per unit, so adding one to the other — the
   * way Guppy's "+$15 to your max price" does — quietly turns a $30 limit into
   * $45 and leaves the log still saying $30.
   */
  shippingAllowance: number;
  /**
   * When Phantom is allowed to look, as HH:MM in `timezone`.
   *
   * Target runs its scheduled drops in the small hours, so polling all day is
   * mostly traffic spent on a page that will not change — and traffic is the
   * one thing that earns a challenge and takes Phantom off the air at the
   * moment it matters. Equal values mean no restriction, which is the default
   * and the old behaviour.
   *
   * A window may cross midnight: 22:00 to 06:00 is one window, not two.
   */
  activeFrom: string;
  activeUntil: string;
  /** IANA zone the window is expressed in. Blank means the machine's own. */
  timezone: string;
  /**
   * Stop everything, without unpicking anything.
   *
   * Distinct from pausing each mission: this is the master switch, and it is
   * the honest way to stop a system rather than deleting the missions and
   * rebuilding them later.
   */
  paused: boolean;
  /**
   * How often to sweep the catalogue for new listings. Hours; 0 means never.
   *
   * A day is the right order of magnitude: Target adds a SKU weeks before it
   * is buyable, so nothing is lost by finding out tomorrow, and sweeping more
   * often spends requests on a catalogue that has not changed.
   */
  sweepEveryHours: number;
  /**
   * How often to say it again while stock stays staged, in minutes.
   *
   * The load-in alert is edge-triggered: it fires once, when a listing goes
   * from nothing counted to a warehouse behind it. That is right for a machine
   * and wrong for a person, because the whole point of the alarm is that it
   * lands at eleven at night for a three in the morning drop, and the one
   * message that matters most is the one you were asleep for.
   *
   * Zero means once only, which is the old behaviour and the default — nobody
   * gets a new stream of messages because they upgraded. Set it and Phantom
   * repeats the same warning on that interval for as long as the stock is
   * still sitting there unsellable, and stops the moment it is not.
   */
  stagedRepeatMinutes: number;
  /**
   * When to say a listing is STILL in stock: minutes after the first alert.
   *
   * A SCHEDULE, not an interval, and the difference is the point. "Every 30
   * minutes for up to an hour" is ambiguous at the boundary and reads as an
   * open tap; `[30, 60]` says exactly what will happen — three posts, then
   * silence — and you can count them before switching it on.
   *
   * The first alert always fires on the edge, whatever is in here. This is the
   * follow-up for people who were not looking at their phone in that minute.
   *
   * Empty is the default and means once only. It matters that the end is
   * built in: measured on one ordinary day, three watched listings had been
   * continuously in stock for 8.8, 14.9 and 16.9 hours. An open-ended hourly
   * repeat is forty-one posts about three things nobody needed reminding of,
   * in a channel people joined to be told when something drops.
   */
  inStockRepeatAfter: number[];
  /**
   * The Discord server people are invited to, as a link.
   *
   * Deliberately NOT derived from the webhook. A webhook is a credential that
   * posts as Phantom; an invite is a public address anybody may hold. They
   * belong to the same server and are not the same secret, and building one
   * from the other would put a credential behind a link people click.
   *
   * Blank hides the button rather than showing one that goes nowhere.
   */
  discordInvite: string;
  /**
   * The most that may be authorised in any rolling 24 hours, in dollars.
   *
   * Null means unset, and unset means nothing can be armed. The cap is checked
   * here, at grant time, against the sum of live authorisations — never on the
   * Phantom, whose process can die and forget.
   */
  spendCapDay: number | null;
  /**
   * The standing pot this whole operation is working against, in dollars.
   *
   * Deliberately NOT the daily cap. The cap is a brake — the most that may be
   * committed in any rolling day, checked at grant time so a runaway cannot
   * spend a year's money in an hour. This is the tank: what there is in total,
   * against which orders placed and pre-orders owed are drawn down.
   *
   * Zero means unset. Unset changes nothing and stops nothing — a budget is a
   * number to read, not a second brake, and quietly turning it into one would
   * be a way to lose a drop to a setting nobody remembered typing.
   */
  budgetTotal: number;
  /**
   * Shops that are switched off, by name.
   *
   * A shop at a time, rather than the master switch or nothing. There are
   * evenings when Target is the only thing dropping and spending Walmart's
   * budget on a catalogue that has not moved in a week is pure risk for no
   * information — and evenings when one shop has served a challenge and the
   * honest move is to leave that one alone without blinding the other two.
   *
   * Off means off for BOTH halves: no mission checks and no sweeps. A toggle
   * that stopped watching but kept sweeping would be a toggle that lies.
   */
  pausedRetailers: string[];
  /**
   * The tight floor between requests to one shop, in seconds, used only
   * inside a drop window. 0 means the feature is off and the ordinary floor
   * (20s) always applies.
   *
   * The ordinary floor is sized for a system that runs all day for years. A
   * drop is over in ninety seconds, and checking once every 20–28s during one
   * means seeing it, at best, three times. This is the exception that window
   * earns — and it is deliberately a separate number rather than a smaller
   * default, so the polite pace stays the pace we live at.
   */
  burstSpacingSeconds: number;
  /**
   * When the manual drop window ends, as an ISO timestamp. Blank means no
   * manual window is open.
   *
   * An expiry rather than a toggle, on purpose: the failure mode of a switch
   * is leaving it on. A window that closes itself cannot quietly become the
   * new normal pace at three in the morning.
   */
  dropModeUntil: string;
}

export const DEFAULT_SETTINGS: Settings = {
  taxRate: 0,
  shippingAllowance: 0,
  activeFrom: '',
  activeUntil: '',
  timezone: '',
  paused: false,
  sweepEveryHours: 24,
  stagedRepeatMinutes: 0,
  inStockRepeatAfter: [],
  discordInvite: '',
  spendCapDay: null,
  budgetTotal: 0,
  pausedRetailers: [],
  burstSpacingSeconds: 0,
  dropModeUntil: '',
};

/** The shops this system knows. A toggle for a shop we cannot read is a lie. */
export const KNOWN_RETAILERS = ['Target', 'Walmart', 'Pokemon Center'] as const;

/** HH:MM, 24-hour, or blank. Deliberately strict: a half-parsed time is worse. */
export function isClockTime(v: string): boolean {
  if (v === '') return true;
  const parts = v.split(':');
  if (parts.length !== 2) return false;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return false;
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 && parts[0]!.length === 2 && parts[1]!.length === 2;
}

export function validateSettings(s: Partial<Settings>): string | null {
  if (s.budgetTotal !== undefined && s.budgetTotal !== null) {
    const n = Number(s.budgetTotal);
    if (!Number.isFinite(n) || n < 0) return 'a budget is a number of dollars, or nothing';
    if (n > 10_000_000) return 'that budget does not look like dollars';
  }
  if (s.spendCapDay !== undefined && s.spendCapDay !== null) {
    if (!Number.isFinite(s.spendCapDay) || s.spendCapDay <= 0) {
      return 'the daily spend cap must be a positive number of dollars';
    }
    if (s.spendCapDay > 100_000) return 'that daily spend cap does not look like dollars';
  }
  if (s.taxRate !== undefined) {
    if (!Number.isFinite(s.taxRate) || s.taxRate < 0) return 'a tax rate cannot be negative';
    // A rate above 25% is almost certainly 9.75 typed where 0.0975 was meant,
    // and silently accepting it would decline every mission you own.
    if (s.taxRate > 0.25) {
      return 'a tax rate above 25% looks like a percentage — enter 0.0975 for 9.75%';
    }
  }
  if (s.shippingAllowance !== undefined) {
    if (!Number.isFinite(s.shippingAllowance) || s.shippingAllowance < 0) {
      return 'a shipping allowance cannot be negative';
    }
    if (s.shippingAllowance > 100) return 'that shipping allowance looks like a typo';
  }
  if (s.pausedRetailers !== undefined) {
    if (!Array.isArray(s.pausedRetailers)) return 'paused shops must be a list of names';
    for (const r of s.pausedRetailers) {
      if (!(KNOWN_RETAILERS as readonly string[]).includes(String(r))) {
        return `"${r}" is not a shop this system watches`;
      }
    }
  }
  if (s.burstSpacingSeconds !== undefined) {
    const n = Number(s.burstSpacingSeconds);
    if (!Number.isFinite(n) || n < 0) return 'the drop-window spacing cannot be negative';
    // A floor below five seconds is not a setting, it is a way to get blocked
    // during the one window that matters. The probe test moves this number,
    // not a hunch typed into a box.
    if (n > 0 && n < 5) return 'the drop-window spacing must be at least 5 seconds';
    if (n > 60) return 'a drop-window spacing above 60s is slower than the ordinary pace';
  }
  if (s.dropModeUntil !== undefined && String(s.dropModeUntil) !== '') {
    const t = Date.parse(String(s.dropModeUntil));
    if (!Number.isFinite(t)) return 'the drop window end must be a timestamp';
    // Twelve hours is already generous for something that exists to be brief.
    if (t > Date.now() + 12 * 3600_000) {
      return 'a drop window cannot be opened more than 12 hours ahead';
    }
  }
  for (const key of ['activeFrom', 'activeUntil'] as const) {
    if (s[key] !== undefined && !isClockTime(String(s[key]))) {
      return `${key} must be a 24-hour time like 02:30, or blank for no restriction`;
    }
  }
  if (s.timezone !== undefined && String(s.timezone) !== '') {
    // Asked of the platform rather than checked against a list we would have to
    // maintain. A bad zone here would silently shift the whole window.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: String(s.timezone) });
    } catch {
      return `"${s.timezone}" is not a timezone this server knows`;
    }
  }
  if (s.stagedRepeatMinutes !== undefined) {
    const n = Number(s.stagedRepeatMinutes);
    if (!Number.isFinite(n) || n < 0) return 'a repeat interval cannot be negative';
    // Under five minutes is not a reminder, it is a stream. The check cadence
    // during a drop window is faster than that on purpose; the ALERT does not
    // need to be, and an alarm that fires every minute gets muted before the
    // drop it was warning about.
    if (n > 0 && n < 5) return 'repeat the load-in alert no more often than every 5 minutes';
    if (n > 24 * 60) return 'a repeat interval longer than a day is the same as off';
  }
  if (s.discordInvite !== undefined && s.discordInvite !== '') {
    const v = String(s.discordInvite).trim();
    // Only Discord's own hosts, and only https. This value becomes a link in
    // a header that members click, so "a URL somebody typed" is not good
    // enough — an invite that quietly points elsewhere is a phishing link
    // wearing our chrome.
    if (!/^https:\/\/(discord\.gg|discord\.com|www\.discord\.com)\//i.test(v)) {
      return 'a Discord invite looks like https://discord.gg/… — other links are not accepted here';
    }
    if (v.length > 200) return 'that does not look like an invite link';
  }
  if (s.inStockRepeatAfter !== undefined) {
    const list = s.inStockRepeatAfter;
    if (!Array.isArray(list)) return 'the follow-up times must be a list of minutes';
    if (list.length > 6) return 'six follow-ups is already more than anybody reads';
    let last = 0;
    for (const raw of list) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return 'each follow-up is a number of minutes after the first post';
      if (n < 5) return 'no follow-up sooner than 5 minutes after the first post';
      if (n > 24 * 60) return 'a follow-up more than a day later is not a follow-up';
      // Ascending and distinct, because they are read as a timeline and two
      // the same would fire together and look like a duplicate.
      if (n <= last) return 'the follow-up times must go up: 30, 60';
      last = n;
    }
  }
  if (s.sweepEveryHours !== undefined) {
    if (!Number.isFinite(s.sweepEveryHours) || s.sweepEveryHours < 0) {
      return 'a sweep interval cannot be negative — use 0 to stop sweeping';
    }
    if (s.sweepEveryHours > 24 * 30) return 'that sweep interval is longer than a month';
  }
  // One end of a window without the other is a half-configured rule, and the
  // safe reading of it is not obvious — so it is refused rather than guessed.
  const from = s.activeFrom;
  const until = s.activeUntil;
  if (from !== undefined && until !== undefined) {
    if ((from === '') !== (until === '')) {
      return 'set both ends of the window, or neither';
    }
  }
  return null;
}

export async function getSettings(db: Sql, userId: number): Promise<Settings> {
  const rows = await db.query<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE user_id = $1',
    [userId],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string, fallback: number): number => {
    const raw = map.get(k);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    // A corrupted row falls back rather than making every comparison NaN —
    // NaN > ceiling is false, which would silently approve everything.
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const text = (k: string, fallback: string): string => {
    const raw = map.get(k);
    return raw === undefined ? fallback : String(raw);
  };
  return {
    taxRate: num('taxRate', DEFAULT_SETTINGS.taxRate),
    shippingAllowance: num('shippingAllowance', DEFAULT_SETTINGS.shippingAllowance),
    activeFrom: isClockTime(text('activeFrom', '')) ? text('activeFrom', '') : '',
    activeUntil: isClockTime(text('activeUntil', '')) ? text('activeUntil', '') : '',
    timezone: text('timezone', ''),
    paused: text('paused', '') === 'true',
    sweepEveryHours: num('sweepEveryHours', DEFAULT_SETTINGS.sweepEveryHours),
    stagedRepeatMinutes: num('stagedRepeatMinutes', DEFAULT_SETTINGS.stagedRepeatMinutes),
    // Same comma-separated storage as pausedRetailers. A malformed entry is
    // dropped rather than made NaN: a schedule that half-parses should send
    // fewer messages, never a message at an unknown time.
    discordInvite: text('discordInvite', ''),
    inStockRepeatAfter: text('inStockRepeatAfter', '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b),
    budgetTotal: num('budgetTotal', DEFAULT_SETTINGS.budgetTotal),
    spendCapDay: map.has('spendCapDay') && Number.isFinite(Number(map.get('spendCapDay'))) && Number(map.get('spendCapDay')) > 0
      ? Number(map.get('spendCapDay'))
      : null,
    // Stored as one comma-separated string: the set is three names, and a
    // table for it would be three joins to answer "is Target on".
    pausedRetailers: text('pausedRetailers', '')
      .split(',')
      .map((r) => r.trim())
      .filter((r) => (KNOWN_RETAILERS as readonly string[]).includes(r)),
    burstSpacingSeconds: num('burstSpacingSeconds', DEFAULT_SETTINGS.burstSpacingSeconds),
    dropModeUntil: text('dropModeUntil', ''),
  };
}

export async function setSettings(
  db: Sql,
  userId: number,
  patch: Partial<Settings>,
): Promise<Settings> {
  const problem = validateSettings(patch);
  if (problem) throw new Error(problem);

  const statements: Statement[] = [];
  for (const key of [
    'taxRate',
    'shippingAllowance',
    'activeFrom',
    'activeUntil',
    'timezone',
    'paused',
    'sweepEveryHours',
    'stagedRepeatMinutes',
    'inStockRepeatAfter',
    'discordInvite',
    'budgetTotal',
    'spendCapDay',
    'pausedRetailers',
    'burstSpacingSeconds',
    'dropModeUntil',
  ] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    statements.push({
      text: `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      // null clears a key back to unset — for the spend cap, that means
      // nothing further can be armed until a person sets one again.
      params: [
        userId,
        key,
        value === null ? '' : Array.isArray(value) ? value.join(',') : String(value),
      ],
    });
  }
  if (statements.length) await db.batch(statements);
  return getSettings(db, userId);
}

export interface MissionRow {
  id: number;
  listingId: number;
  productKey: string;
  productName: string;
  imageUrl: string;
  msrp: number | null;
  retailer: string;
  externalId: string;
  url: string;
  label: string;
  enabled: boolean;
  armed: boolean;
  /**
   * Does this mission post to Discord?
   *
   * Separate from `enabled` on purpose. Pausing stops Phantom looking; this
   * stops it TELLING PEOPLE, while the checking, the buying and the page all
   * carry on. A test pen at 99 cents and a marketplace tin at three times MSRP
   * are both worth watching and neither is worth a room full of notifications.
   */
  alerts: boolean;
  ceiling: number | null;
  quantity: number;
  sellerPolicy: SellerPolicy;
  /** 'skip' declines a pre-order; 'allow' treats it as buyable. */
  preOrderPolicy: PreOrderPolicy;
  checkEverySeconds: number;
  /** A "test run" is pending: check this one next pass, whatever its schedule. */
  checkNow: boolean;
  /** When the button was pressed, so the page can count the seconds honestly. */
  checkNowAt: string | null;
  notes: string;
  /** Latest reading for this mission's listing, when there is one. */
  state: string;
  confidence: string;
  price: number | null;
  sellerKind: string;
  sellerName: string;
  availableQuantity: number | null;
  orderLimit: number | null;
  isPreOrder: boolean;
  releaseDate: string | null;
  note: string;
  lastCheckedAt: string;
  lastChangedAt: string;
  /**
   * This listing is watched by somebody else, not by the account reading it.
   * Read the page and post the observation; record no run and buy nothing.
   */
  readOnly?: boolean;
}

function toMission(r: Record<string, unknown>): MissionRow {
  const iso = (v: unknown): string => (v ? new Date(String(v)).toISOString() : '');
  return {
    id: Number(r.id),
    listingId: Number(r.listing_id),
    productKey: String(r.product_key ?? ''),
    productName: String(r.product_name ?? ''),
    imageUrl: String(r.image_url ?? ''),
    msrp: toPrice(r.msrp),
    retailer: String(r.retailer ?? ''),
    externalId: String(r.external_id ?? ''),
    url: String(r.url ?? ''),
    label: String(r.label ?? ''),
    enabled: r.enabled === true,
    armed: r.armed === true,
    // Default ON when the column is absent or null: a mission that predates
    // this setting was announcing, and an upgrade must not silence it.
    alerts: r.alerts === undefined || r.alerts === null ? true : r.alerts === true,
    ceiling: toPrice(r.ceiling),
    quantity: Number(r.quantity ?? 1),
    sellerPolicy: (String(r.seller_policy ?? 'retailer_only') as SellerPolicy),
    preOrderPolicy: (String(r.preorder_policy ?? 'skip') as PreOrderPolicy),
    checkEverySeconds: Number(r.check_every_s ?? 60),
    checkNow: r.check_now_at !== null && r.check_now_at !== undefined,
    checkNowAt: r.check_now_at ? String(r.check_now_at) : null,
    notes: String(r.notes ?? ''),
    state: String(r.state ?? 'unchecked'),
    confidence: String(r.confidence ?? 'unknown'),
    price: toPrice(r.price),
    sellerKind: String(r.ws_seller_kind ?? r.seller_kind ?? 'unknown'),
    sellerName: String(r.ws_seller_name ?? r.seller_name ?? ''),
    availableQuantity: r.available_quantity === null || r.available_quantity === undefined
      ? null
      : Number(r.available_quantity),
    orderLimit: r.order_limit === null || r.order_limit === undefined ? null : Number(r.order_limit),
    isPreOrder: r.is_preorder === true,
    releaseDate: toDate(r.release_date),
    note: String(r.note ?? ''),
    lastCheckedAt: iso(r.last_checked_at),
    lastChangedAt: iso(r.last_changed_at),
  };
}

const MISSION_SELECT = `
  SELECT m.*, l.product_key, l.retailer, l.external_id, l.url,
         p.name AS product_name, p.image_url, p.msrp,
         COALESCE(w.state, 'unchecked') AS state,
         COALESCE(w.confidence, 'unknown') AS confidence,
         w.price,
         COALESCE(w.seller_kind, l.seller_kind) AS ws_seller_kind,
         COALESCE(NULLIF(w.seller_name, ''), l.seller_name) AS ws_seller_name,
         w.available_quantity, w.order_limit,
         COALESCE(w.is_preorder, false) AS is_preorder,
         COALESCE(w.release_date, p.release_date) AS release_date,
         COALESCE(w.note, '') AS note,
         w.last_checked_at, w.last_changed_at
    FROM missions m
    JOIN listings l ON l.id = m.listing_id
    JOIN products p ON p.key = l.product_key
    LEFT JOIN watch_state w ON w.listing_id = l.id
   WHERE m.user_id = $1`;

/**
 * Every mission, in the order you care about them.
 *
 * In stock first, because that is the thing you opened the page to see. A
 * LEFT JOIN on watch_state, so a mission Phantom has never reached still
 * appears — marked unchecked rather than quietly missing.
 */
export async function listMissions(db: Sql, userId: number): Promise<MissionRow[]> {
  const rows = await db.query(`${MISSION_SELECT}
    ORDER BY
      CASE COALESCE(w.state, 'unchecked')
        WHEN 'in' THEN 0 WHEN 'queue' THEN 1 WHEN 'unknown' THEN 2
        WHEN 'unchecked' THEN 3 ELSE 4 END,
      m.armed DESC, p.name, l.retailer`, [userId]);
  return rows.map(toMission);
}

/** The mission watching this listing, if there is one. At most one, by schema. */
export async function missionForListing(
  db: Sql,
  userId: number,
  listingId: number,
): Promise<MissionRow | null> {
  const rows = await db.query(`${MISSION_SELECT} AND m.listing_id = $2`, [userId, listingId]);
  return rows[0] ? toMission(rows[0]) : null;
}

export async function getMission(
  db: Sql,
  userId: number,
  id: number,
): Promise<MissionRow | null> {
  const rows = await db.query(`${MISSION_SELECT} AND m.id = $2`, [userId, id]);
  return rows[0] ? toMission(rows[0]) : null;
}

/** Missions Phantom should be polling right now. */
/**
 * Ask for a mission to be checked on the next pass, whatever its schedule says.
 *
 * This is the "Test run" button. It cannot make a check happen — Phantom
 * owns the browser and the retailer owns the budget — so it records a request
 * and lets the next pass honour it. Saying "checking now" and meaning "queued"
 * would be the same species of lie as a $30 ceiling that accepts $45.
 */
export async function requestCheckNow(db: Sql, userId: number, id: number): Promise<boolean> {
  const rows = await db.query<{ id: number }>(
    'UPDATE missions SET check_now_at = now() WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, id],
  );
  return rows.length > 0;
}

/**
 * The watchlist an agent should read this pass.
 *
 * ── One read serves everyone ────────────────────────────────────────────────
 *
 * For an ordinary account this is just its own enabled missions. For the
 * CATALOGUE WRITER — the one machine with a browser — it is the union of
 * everybody's, deduplicated down to one row per listing. That is the whole
 * point of the shared catalogue: a page is read once no matter how many
 * members are watching it, so traffic stays flat as membership grows instead
 * of multiplying at the three retailers whose patience is the real constraint.
 *
 * ── Why the caller's own row wins ───────────────────────────────────────────
 *
 * `DISTINCT ON (l.id)` with the caller's rows sorted first means that when the
 * owner and a member both watch a listing, the row returned is the OWNER'S —
 * carrying their real arming, ceiling and quantity. Take somebody else's row
 * and the agent would either buy on the wrong mandate or fail to buy on a
 * mandate it actually had.
 *
 * ── readOnly ────────────────────────────────────────────────────────────────
 *
 * A listing only somebody else watches still has to be READ — that is the
 * favour being done — but the agent may not report a run against a mission it
 * does not own, because runs are private and `recordRun` will refuse. So the
 * row is marked readOnly: post the observation, which is shared and helps
 * everyone, and record nothing.
 */
export async function activeMissions(db: Sql, userId: number): Promise<MissionRow[]> {
  if (!(await canWriteCatalogue(db, userId))) {
    const rows = await db.query(`${MISSION_SELECT} AND m.enabled = true ORDER BY m.id`, [userId]);
    return rows.map(toMission);
  }

  const rows = await db.query(
    `SELECT DISTINCT ON (l.id) m.*, l.product_key, l.retailer, l.external_id, l.url,
            p.name AS product_name, p.image_url, p.msrp,
            COALESCE(w.state, 'unchecked') AS state,
            COALESCE(w.confidence, 'unknown') AS confidence,
            w.price,
            COALESCE(w.seller_kind, l.seller_kind) AS ws_seller_kind,
            COALESCE(NULLIF(w.seller_name, ''), l.seller_name) AS ws_seller_name,
            w.available_quantity, w.order_limit,
            COALESCE(w.is_preorder, false) AS is_preorder,
            COALESCE(w.release_date, p.release_date) AS release_date,
            COALESCE(w.note, '') AS note,
            w.last_checked_at, w.last_changed_at,
            (m.user_id <> $1) AS read_only,
            -- Anyone watching this listing may press "check now"; the row we
            -- return is whoever's mandate wins, which may not be theirs.
            (SELECT max(m2.check_now_at) FROM missions m2
              WHERE m2.listing_id = l.id AND m2.enabled = true) AS any_check_now
       FROM missions m
       JOIN listings l ON l.id = m.listing_id
       JOIN products p ON p.key = l.product_key
       LEFT JOIN watch_state w ON w.listing_id = l.id
      WHERE m.enabled = true
      -- Mine first, so a listing we both watch comes back on MY mandate.
      ORDER BY l.id, (m.user_id = $1) DESC, m.id`,
    [userId],
  );
  return rows.map((r) => {
    // A hand-pressed check belongs to the LISTING once the read is shared: a
    // member pressing "check now" on a listing the owner also watches must not
    // be swallowed just because the owner's row is the one that won.
    const mission = {
      ...toMission(r),
      checkNow: r.any_check_now != null,
      checkNowAt: r.any_check_now ? String(r.any_check_now) : null,
    };
    // Somebody else's mission may never be armed by this agent, whatever its
    // own row says. Belt as well as braces: only the owner can arm at all.
    if (r.read_only === true) return { ...mission, readOnly: true, armed: false };
    return mission;
  });
}

/**
 * Refuse to arm a mission that has not been told what it may spend.
 *
 * `armed` with no ceiling is an open cheque. Phantom's decision layer
 * already treats it as unauthorised, but a rule enforced in one place is a rule
 * waiting to be forgotten in another — so it is refused here too, at the point
 * where a person could set it.
 */
export function validateMission(m: MissionInput): string | null {
  if (!Number.isFinite(m.listingId) || m.listingId <= 0) return 'a mission needs a listing';
  const quantity = m.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    return 'quantity must be a whole number between 1 and 20';
  }
  if (m.ceiling !== undefined && m.ceiling !== null && !(m.ceiling > 0)) {
    return 'a price ceiling must be greater than zero';
  }
  if (m.armed && (m.ceiling === undefined || m.ceiling === null)) {
    return 'set a price ceiling before arming — armed with no ceiling is an open cheque';
  }
  if (m.preOrderPolicy && !['skip', 'allow'].includes(m.preOrderPolicy)) {
    return "preOrderPolicy must be 'skip' or 'allow'";
  }
  if (m.sellerPolicy && !['retailer_only', 'any'].includes(m.sellerPolicy)) {
    return 'seller policy must be retailer_only or any';
  }
  const every = m.checkEverySeconds ?? 60;
  if (!Number.isInteger(every) || every < 30 || every > 86_400) {
    return 'check interval must be between 30 seconds and a day';
  }
  return null;
}

export async function upsertMission(
  db: Sql,
  userId: number,
  m: MissionInput,
): Promise<MissionRow> {
  const problem = validateMission(m);
  if (problem) throw new Error(problem);

  // The listing must EXIST. It no longer has to be "this user's": a listing is
  // a shelf at a shop, and a shelf belongs to nobody. The mission created here
  // is always the caller's own — user_id comes from the session, never from the
  // body — so a crafted listingId can now only ever attach a mission to the
  // person who sent it, which is the thing the old ownership check was for.
  const exists = await db.query<{ id: number }>(
    'SELECT id FROM listings WHERE id = $1',
    [m.listingId],
  );
  if (!exists.length) throw new Error('no such listing');

  // ── Watch-only for members (owner decision, 1 Sep 2026) ──────────────────
  //
  // Arming is a standing instruction to spend, and it is carried out by a
  // browser signed into a retail account with a card behind it. That machine
  // is the owner's. Until a member can run their own agent, a member's mission
  // may watch and may not buy — and saying so here, rather than hoping no UI
  // offers the button, is what makes it true.
  if (m.armed && !(await canArm(db, userId))) {
    throw new Error(
      'this account can watch but not buy — arming needs a Phantom of your own, ' +
      'signed into your own retailer account',
    );
  }

  const rows = await db.query(
    `INSERT INTO missions (user_id, listing_id, label, enabled, armed, ceiling, quantity,
                           seller_policy, preorder_policy, check_every_s, notes, alerts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     -- Per person per listing. One shared listing now carries a mission for
     -- every member watching it; the rule that matters is that no ONE person
     -- ends up with two, because two armed missions is two purchases.
     ON CONFLICT (user_id, listing_id) DO UPDATE SET
       label = EXCLUDED.label,
       enabled = EXCLUDED.enabled,
       armed = EXCLUDED.armed,
       ceiling = EXCLUDED.ceiling,
       quantity = EXCLUDED.quantity,
       seller_policy = EXCLUDED.seller_policy,
       preorder_policy = EXCLUDED.preorder_policy,
       check_every_s = EXCLUDED.check_every_s,
       notes = EXCLUDED.notes,
       alerts = EXCLUDED.alerts
     RETURNING id`,
    [
      userId,
      m.listingId,
      m.label ?? '',
      m.enabled ?? true,
      m.armed ?? false,
      m.ceiling ?? null,
      m.quantity ?? 1,
      m.sellerPolicy ?? 'retailer_only',
      m.preOrderPolicy ?? 'skip',
      m.checkEverySeconds ?? 60,
      m.notes ?? '',
      m.alerts ?? true,
    ],
  );
  const mission = await getMission(db, userId, Number(rows[0]!.id));
  if (!mission) throw new Error('mission vanished immediately after being written');
  return mission;
}

export async function deleteMission(db: Sql, userId: number, id: number): Promise<boolean> {
  const rows = await db.query<{ id: number }>(
    'DELETE FROM missions WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, id],
  );
  return rows.length > 0;
}

// ─── Authorisations: permission to spend, granted in exactly one place ───────

export type AuthorisationStatus = 'granted' | 'spent' | 'released';

export interface AuthorisationRow {
  id: number;
  missionId: number;
  amount: number;
  status: AuthorisationStatus;
  grantedAt: string;
  resolvedAt: string | null;
  note: string;
}

export type AuthoriseRefusal =
  | 'not_armed'
  | 'no_ceiling'
  | 'no_spend_cap'
  | 'duplicate_prevented'
  | 'budget_exhausted';

export interface AuthoriseResult {
  granted: boolean;
  authorisation?: AuthorisationRow;
  refusal?: AuthoriseRefusal;
  reason: string;
  /** What the last 24 hours already hold, so a refusal can show its working. */
  committed: number;
  cap: number | null;
}

function toAuthorisation(r: Record<string, unknown>): AuthorisationRow {
  return {
    id: Number(r.id),
    missionId: Number(r.mission_id),
    amount: Number(r.amount),
    status: String(r.status ?? 'granted') as AuthorisationStatus,
    grantedAt: r.granted_at ? new Date(String(r.granted_at)).toISOString() : '',
    resolvedAt: r.resolved_at ? new Date(String(r.resolved_at)).toISOString() : null,
    note: String(r.note ?? ''),
  };
}

/** Live grants — money that is committed until something resolves it. */
export async function committedLast24h(db: Sql, userId: number): Promise<number> {
  const rows = await db.query<{ sum: string }>(
    `SELECT coalesce(sum(amount), 0) AS sum FROM authorisations
      WHERE user_id = $1 AND status IN ('granted', 'spent')
        AND granted_at > now() - interval '24 hours'`,
    [userId],
  );
  return Number(rows[0]?.sum ?? 0);
}

/**
 * May this mission spend, right now? The one place that answer comes from.
 *
 * The amount is computed here from the Hub's own mission row — ceiling ×
 * quantity plus the shipping allowance — because Phantom's opinion of what
 * it is about to spend is not evidence. Every refusal names itself, and the
 * two that matter most are load-bearing:
 *
 *   duplicate_prevented   the partial unique index found a live grant already.
 *                         Four checks racing, or a Phantom restarted mid-buy,
 *                         all collide here and nobody buys twice.
 *   budget_exhausted      the 24-hour sum of live grants would pass the cap.
 *
 * ── The race on the cap, and why the insert is optimistic ───────────────────
 *
 * Two authorisations for two different missions can pass the sum check
 * concurrently and both insert. So the sum is re-checked AFTER inserting, with
 * our own row included; whoever finds the total over the cap releases their
 * own grant and reports budget_exhausted. Both may release — that wastes an
 * authorisation, never money, which is the direction to fail in. The invariant
 * that holds: no grant survives whose keeper saw a total over the cap.
 */
export async function requestAuthorisation(
  db: Sql,
  userId: number,
  missionId: number,
): Promise<AuthoriseResult> {
  const settings = await getSettings(db, userId);
  const cap = settings.spendCapDay;
  const committed = await committedLast24h(db, userId);
  const no = (refusal: AuthoriseRefusal, reason: string): AuthoriseResult => ({
    granted: false,
    refusal,
    reason,
    committed,
    cap,
  });

  const mission = await getMission(db, userId, missionId);
  if (!mission || !mission.enabled || !mission.armed) {
    return no('not_armed', 'the Hub does not list this mission as armed');
  }
  if (mission.ceiling === null || mission.ceiling <= 0) {
    return no('no_ceiling', 'armed with no price ceiling — nothing authorises a purchase');
  }
  if (cap === null) {
    return no(
      'no_spend_cap',
      'no daily spend cap is set — set one in Settings before anything may buy',
    );
  }

  const quantity = Math.max(1, mission.quantity || 1);
  const amount = Math.round((mission.ceiling * quantity + settings.shippingAllowance) * 100) / 100;

  if (committed + amount > cap) {
    return no(
      'budget_exhausted',
      `$${amount.toFixed(2)} would take the last 24 hours to ` +
        `$${(committed + amount).toFixed(2)}, over the $${cap.toFixed(2)} cap`,
    );
  }

  let inserted: Record<string, unknown> | undefined;
  try {
    const rows = await db.query(
      `INSERT INTO authorisations (user_id, mission_id, amount, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, missionId, amount, `granted against a $${cap.toFixed(2)} daily cap`],
    );
    inserted = rows[0];
  } catch (err) {
    // The partial unique index. A live grant already exists for this mission,
    // which is the duplicate lock doing its one job.
    if (/authorisations_one_live|duplicate key/i.test((err as Error).message)) {
      return no(
        'duplicate_prevented',
        'a live authorisation already exists for this mission — nothing buys twice',
      );
    }
    throw err;
  }
  if (!inserted) {
    return no('duplicate_prevented', 'the grant could not be recorded — refusing rather than guessing');
  }

  // The post-insert re-check described above. Our own row is in this sum.
  const after = await committedLast24h(db, userId);
  if (after > cap) {
    await db.query(
      `UPDATE authorisations SET status = 'released', resolved_at = now(),
              note = note || ' — released: lost the race to the daily cap'
        WHERE user_id = $1 AND id = $2`,
      [userId, Number(inserted.id)],
    );
    return {
      granted: false,
      refusal: 'budget_exhausted',
      reason: `concurrent grants would take the last 24 hours to $${after.toFixed(2)}, over the cap`,
      committed: after - amount,
      cap,
    };
  }

  return {
    granted: true,
    authorisation: toAuthorisation(inserted),
    reason: '',
    committed: after,
    cap,
  };
}

/**
 * Phantom says what became of a grant.
 *
 * 'spent' also disarms the mission: a mission is a pre-authorisation for ONE
 * purchase, and the purchase happened. Re-arming is a decision a person makes
 * in the app, never something a successful buy rolls into.
 *
 * Only 'granted' rows can be resolved, and only once — resolving is how a
 * grant stops counting against the cap ('released') or becomes a permanent
 * record ('spent'), and neither transition may be repeated or reversed.
 */
export async function resolveAuthorisation(
  db: Sql,
  userId: number,
  id: number,
  result: 'spent' | 'released',
  note: string,
): Promise<AuthorisationRow | null> {
  const rows = await db.query(
    `UPDATE authorisations
        SET status = $3, resolved_at = now(),
            note = CASE WHEN $4 = '' THEN note ELSE left($4, 300) END
      WHERE user_id = $1 AND id = $2 AND status = 'granted'
      RETURNING *`,
    [userId, id, result, note],
  );
  const row = rows[0];
  if (!row) return null;

  if (result === 'spent') {
    await db.query('UPDATE missions SET armed = false WHERE user_id = $1 AND id = $2', [
      userId,
      Number(row.mission_id),
    ]);
    // A purchase happened, so a physical thing is now incoming inventory:
    // queue it for the vault (review-then-send — a person confirms the match
    // before anything touches the real portfolio). Best-effort by design; the
    // resolve MUST NOT fail because a side table hiccupped.
    await queueAcquisition(db, userId, Number(row.id), Number(row.mission_id)).catch(() => {});
  }
  return toAuthorisation(row);
}

// ─── Acquisitions: confirmed purchases on their way to the vault ─────────────

export interface AcquisitionRow {
  id: number;
  missionId: number | null;
  productKey: string | null;
  name: string;
  retailer: string;
  quantity: number;
  unitPriceCents: number | null;
  orderedOn: string;
  status: 'queued' | 'sent' | 'dismissed';
  externalKey: string;
  vaultTcgId: string;
  sentAt: string | null;
  createdAt: string;
  imageUrl: string;
}

function toAcquisition(r: Record<string, unknown>): AcquisitionRow {
  return {
    id: Number(r.id),
    missionId: r.mission_id == null ? null : Number(r.mission_id),
    productKey: r.product_key == null ? null : String(r.product_key),
    name: String(r.name ?? ''),
    retailer: String(r.retailer ?? ''),
    quantity: Number(r.quantity ?? 1),
    unitPriceCents: r.unit_price_cents == null ? null : Number(r.unit_price_cents),
    orderedOn: toDate(r.ordered_on) ?? '',
    status: String(r.status ?? 'queued') as AcquisitionRow['status'],
    externalKey: String(r.external_key ?? ''),
    vaultTcgId: String(r.vault_tcg_id ?? ''),
    sentAt: r.sent_at ? new Date(String(r.sent_at)).toISOString() : null,
    createdAt: r.created_at ? new Date(String(r.created_at)).toISOString() : '',
    imageUrl: String(r.image_url ?? ''),
  };
}

/**
 * Record a spent grant as a queued acquisition, from the Hub's own rows: the
 * mission names the product and quantity, the latest bought run names the
 * price actually paid. Idempotent on external_key ('auth-<grant id>') — a
 * resolve retried by a nervous Phantom queues one acquisition, not two.
 * Pre-fills the vault match from the product's remembered vault_tcg_id, so
 * the second purchase of the same box is one click.
 */
export async function queueAcquisition(
  db: Sql,
  userId: number,
  authorisationId: number,
  missionId: number,
): Promise<void> {
  await db.query(
    `INSERT INTO acquisitions
       (user_id, mission_id, product_key, name, retailer, quantity,
        unit_price_cents, ordered_on, external_key, vault_tcg_id)
     SELECT m.user_id, m.id, l.product_key, p.name, l.retailer, m.quantity,
            (SELECT round(r.price * 100)::int FROM mission_runs r
              WHERE r.mission_id = m.id AND r.outcome = 'bought'
              ORDER BY r.started_at DESC LIMIT 1),
            CURRENT_DATE, $3, coalesce(p.vault_tcg_id, '')
       FROM missions m
       JOIN listings l ON l.id = m.listing_id
       JOIN products p ON p.key = l.product_key
      WHERE m.user_id = $1 AND m.id = $2
     ON CONFLICT (external_key) DO NOTHING`,
    [userId, missionId, `auth-${authorisationId}`],
  );
}

/** The queue and its history, newest first, with the product's image along for the card. */
export async function listAcquisitions(db: Sql, userId: number): Promise<AcquisitionRow[]> {
  const rows = await db.query(
    `SELECT a.*, coalesce(p.image_url, '') AS image_url
       FROM acquisitions a LEFT JOIN products p ON p.key = a.product_key
      WHERE a.user_id = $1
      ORDER BY a.status = 'queued' DESC, a.created_at DESC
      LIMIT 100`,
    [userId],
  );
  return rows.map(toAcquisition);
}

/**
 * A person confirmed the match and the vault accepted the delivery. Records
 * both facts, and remembers the match on the product so the next purchase of
 * the same thing pre-fills. Only a queued row can be sent, and only once.
 */
export async function markAcquisitionSent(
  db: Sql,
  userId: number,
  id: number,
  vaultTcgId: string,
  vaultItemIds: unknown[],
): Promise<AcquisitionRow | null> {
  const rows = await db.query(
    `UPDATE acquisitions
        SET status = 'sent', sent_at = now(), vault_tcg_id = $3, vault_item_ids = $4
      WHERE user_id = $1 AND id = $2 AND status = 'queued'
      RETURNING *`,
    [userId, id, vaultTcgId, JSON.stringify(vaultItemIds)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.product_key && vaultTcgId) {
    await db.query(
      `UPDATE products SET vault_tcg_id = $3 WHERE user_id = $1 AND key = $2`,
      [userId, String(row.product_key), vaultTcgId],
    );
  }
  return toAcquisition(row);
}

/** A person decided this purchase does not belong in the vault. Kept, as the record of that. */
export async function dismissAcquisition(db: Sql, userId: number, id: number): Promise<boolean> {
  const rows = await db.query(
    `UPDATE acquisitions SET status = 'dismissed'
      WHERE user_id = $1 AND id = $2 AND status = 'queued' RETURNING id`,
    [userId, id],
  );
  return rows.length > 0;
}

// ─── Vault accounts: users whose door is the vault's /sso ────────────────────

/**
 * Find or create the hub user for a vault account. The vault user id is the
 * identity; handle is best-effort (their email, falling back to a stable
 * vault-derived name on collision) because handles are labels here, not
 * credentials. No password is ever set — password_hash '' cannot verify, so
 * the ONLY way into such an account is a fresh signed launch token.
 */
export async function ensureVaultUser(
  db: Sql,
  vaultUserId: string,
  email: string,
): Promise<number> {
  const found = await db.query<{ id: number }>(
    // A fresh launch token proves the vault considers them entitled RIGHT NOW,
    // so an account lapsed-and-disabled earlier is re-enabled by walking back
    // in through the vault's door. That is the renewal path working.
    'UPDATE users SET enabled = true WHERE vault_user_id = $1 RETURNING id',
    [vaultUserId],
  );
  if (found[0]) return Number(found[0].id);

  const base = (email || '').trim() || `vault-${vaultUserId.slice(0, 8)}`;
  for (const handle of [base, `${base}-${vaultUserId.slice(0, 8)}`]) {
    const made = await db.query<{ id: number }>(
      `INSERT INTO users (handle, vault_user_id, entitlement_checked_at)
       VALUES ($1, $2, now())
       ON CONFLICT (handle) DO NOTHING RETURNING id`,
      [handle, vaultUserId],
    );
    if (made[0]) return Number(made[0].id);
  }
  throw new Error('could not create an account for that vault user');
}

export interface VaultLink {
  vaultUserId: string;
  checkedAt: string | null;
  enabled: boolean;
}

/** The vault mapping for a user, or null for a local (owner-style) account. */
export async function vaultLinkFor(db: Sql, userId: number): Promise<VaultLink | null> {
  const rows = await db.query<{ vault_user_id: string | null; entitlement_checked_at: unknown; enabled: unknown }>(
    'SELECT vault_user_id, entitlement_checked_at, enabled FROM users WHERE id = $1',
    [userId],
  );
  const row = rows[0];
  if (!row?.vault_user_id) return null;
  return {
    vaultUserId: String(row.vault_user_id),
    checkedAt: row.entitlement_checked_at
      ? new Date(String(row.entitlement_checked_at)).toISOString()
      : null,
    enabled: row.enabled !== false,
  };
}

/** Entitlement was confirmed just now — reset the daily clock. */
export async function markEntitlementChecked(db: Sql, userId: number): Promise<void> {
  await db.query('UPDATE users SET entitlement_checked_at = now() WHERE id = $1', [userId]);
}

/** The vault said no: the tier lapsed. Sign-out is the caller's job; this records the fact. */
export async function disableVaultUser(db: Sql, userId: number): Promise<void> {
  await db.query(
    "UPDATE users SET enabled = false WHERE id = $1 AND vault_user_id IS NOT NULL",
    [userId],
  );
}

/** Grants still live, for the dashboard — and for a person to release a stuck one. */
export async function openAuthorisations(db: Sql, userId: number): Promise<AuthorisationRow[]> {
  const rows = await db.query(
    `SELECT * FROM authorisations WHERE user_id = $1 AND status = 'granted'
      ORDER BY granted_at DESC`,
    [userId],
  );
  return rows.map(toAuthorisation);
}

// ─── Mission runs ────────────────────────────────────────────────────────────

export type RunOutcome =
  | 'running'
  | 'in_stock'
  | 'bought'
  | 'declined'
  | 'failed'
  | 'blocked'
  // The buy path's own vocabulary. Distinct values rather than reasons inside
  // 'declined', because "how often did the duplicate lock fire" is a question
  // the history has to answer without string-matching.
  | 'dry_run'
  | 'duplicate_prevented'
  | 'budget_exhausted'
  | 'price_exceeded'
  | 'not_authorised';

export interface RunRow {
  id: number;
  missionId: number;
  productName: string;
  retailer: string;
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  reason: string;
  state: string;
  price: number | null;
  sellerKind: string;
  sellerName: string;
  quantity: number | null;
  total: number | null;
  ms: number | null;
}

/**
 * Open a run.
 *
 * Called when a mission does something — not on every poll. A run that is
 * started and never finished shows as 'running' forever, which is exactly the
 * signal you want: something began and nothing closed it.
 */
export async function startRun(db: Sql, userId: number, missionId: number): Promise<number> {
  // The mission has to be this user's, or a crafted missionId writes history
  // onto somebody else's mission.
  const owns = await db.query<{ id: number }>(
    'SELECT id FROM missions WHERE user_id = $1 AND id = $2',
    [userId, missionId],
  );
  if (!owns.length) throw new Error('that mission does not belong to you');

  const rows = await db.query(
    'INSERT INTO mission_runs (user_id, mission_id) VALUES ($1, $2) RETURNING id',
    [userId, missionId],
  );
  return Number(rows[0]!.id);
}

export async function finishRun(
  db: Sql,
  userId: number,
  runId: number,
  r: {
    outcome: Exclude<RunOutcome, 'running'>;
    reason?: string;
    state?: string;
    price?: number | null;
    sellerKind?: string;
    sellerName?: string;
    quantity?: number | null;
    total?: number | null;
    /** Was this a pre-order at the moment it was placed? Money, not trivia. */
    isPreOrder?: boolean;
    /** When it ships, if the shop said. Null for an ordinary order. */
    releaseDate?: string | null;
  },
): Promise<void> {
  // Anything that is not a plain success must explain itself. A run marked
  // 'failed' with an empty reason is the log line you find at 3am and learn
  // nothing from, so a placeholder is written rather than leaving it blank.
  const needsReason = r.outcome !== 'bought' && r.outcome !== 'in_stock';
  const reason = (r.reason ?? '').trim() || (needsReason ? `${r.outcome}, no reason recorded` : '');

  await db.query(
    `UPDATE mission_runs
        SET finished_at = now(),
            outcome = $1, reason = $2, state = $3, price = $4,
            seller_kind = $5, seller_name = $6, quantity = $7, total = $8,
            is_preorder = $9, release_date = $10,
            ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
      WHERE user_id = $11 AND id = $12`,
    [
      r.outcome,
      reason.slice(0, 500),
      r.state ?? '',
      r.price ?? null,
      r.sellerKind ?? '',
      r.sellerName ?? '',
      r.quantity ?? null,
      r.total ?? null,
      r.isPreOrder === true,
      // Only meaningful on a pre-order. A release date on an ordinary order is
      // the product's street date, which is a fact about the product and has
      // nothing to say about when money moves.
      r.isPreOrder === true ? (r.releaseDate || null) : null,
      userId,
      runId,
    ],
  );
}

/** Record a run that is already over. The common case. */
export async function recordRun(
  db: Sql,
  userId: number,
  missionId: number,
  r: Parameters<typeof finishRun>[3],
): Promise<number> {
  const id = await startRun(db, userId, missionId);
  await finishRun(db, userId, id, r);
  return id;
}

function toRun(r: Record<string, unknown>): RunRow {
  const iso = (v: unknown): string => (v ? new Date(String(v)).toISOString() : '');
  return {
    id: Number(r.id),
    missionId: Number(r.mission_id),
    productName: String(r.product_name ?? ''),
    retailer: String(r.retailer ?? ''),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    outcome: String(r.outcome ?? 'running') as RunOutcome,
    reason: String(r.reason ?? ''),
    state: String(r.state ?? ''),
    price: toPrice(r.price),
    sellerKind: String(r.seller_kind ?? ''),
    sellerName: String(r.seller_name ?? ''),
    quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
    total: toPrice(r.total),
    ms: r.ms === null || r.ms === undefined ? null : Number(r.ms),
  };
}

const RUN_SELECT = `
  SELECT r.*, p.name AS product_name, l.retailer
    FROM mission_runs r
    JOIN missions m ON m.user_id = r.user_id AND m.id = r.mission_id
    JOIN listings l ON l.id = m.listing_id
    JOIN products p ON p.key = l.product_key
   WHERE r.user_id = $1`;

export async function missionRuns(
  db: Sql,
  userId: number,
  missionId: number,
  limit = 100,
): Promise<RunRow[]> {
  const rows = await db.query(
    `${RUN_SELECT} AND r.mission_id = $2 ORDER BY r.started_at DESC, r.id DESC LIMIT $3`,
    [userId, missionId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(toRun);
}

export async function recentRuns(db: Sql, userId: number, limit = 50): Promise<RunRow[]> {
  const rows = await db.query(
    `${RUN_SELECT} ORDER BY r.started_at DESC, r.id DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toRun);
}

// ─── What Phantom saw ────────────────────────────────────────────────────

/** One reading of one listing, as Phantom reports it. */
export interface ObservationIn {
  listingId: number;
  /** The retailer's own name for this product. Replaces a slug guess. */
  productName?: string;
  state: 'in' | 'out' | 'queue' | 'unknown';
  confidence?: 'exact' | 'inferred' | 'unknown';
  price?: number | null;
  sellerKind?: 'retailer' | 'marketplace' | 'unknown';
  sellerName?: string;
  availableQuantity?: number | null;
  orderLimit?: number | null;
  isPreOrder?: boolean;
  releaseDate?: string | null;
  imageUrl?: string;
  note?: string;
}

/**
 * Claim the right to announce staged stock on this listing, once.
 *
 * The whole repeat rule lives in one UPDATE, on purpose. Reading a timestamp,
 * deciding in JavaScript and writing it back is three steps with a gap in the
 * middle, and two readings arriving together — which is exactly what happens
 * when a pass reports a batch — would both pass the check and both announce.
 * The database decides, atomically, and returning a row IS the permission.
 *
 * A null timestamp means nothing has been said about this listing yet, so the
 * first sighting always announces however the interval is set.
 */
export async function claimStagedAnnounce(
  db: Sql,
  userId: number,
  listingId: number,
  repeatMinutes: number,
): Promise<boolean> {
  const rows = await db.query<{ listing_id: number }>(
    `UPDATE watch_state SET staged_notified_at = now()
      WHERE user_id = $1 AND listing_id = $2
        AND (staged_notified_at IS NULL
             OR ($3 > 0 AND staged_notified_at < now() - ($3 || ' minutes')::interval))
      RETURNING listing_id`,
    [userId, listingId, Math.max(0, Math.round(repeatMinutes))],
  );
  return rows.length > 0;
}

/**
 * Has this listing earned its next follow-up post, and which one is it?
 *
 * The schedule is minutes after the FIRST alert, so the state we keep is that
 * first moment and how many follow-ups have gone out. `stock_alerts_sent` is
 * both the counter and the index into the schedule, which is what makes the
 * whole thing one comparison rather than a pile of timestamps.
 *
 * The write is a compare-and-set: it only increments if the counter is still
 * what we read. A pass reports a batch and two readings can arrive together;
 * without the guard both would see "one sent" and both would send the second.
 * With it, the loser's UPDATE matches nothing and it stays quiet.
 */
export async function claimStockFollowUp(
  db: Sql,
  userId: number,
  listingId: number,
  afterMinutes: readonly number[],
): Promise<boolean> {
  if (afterMinutes.length === 0) return false;
  const [row] = await db.query<{ sent: number; due: boolean; live: boolean }>(
    `SELECT COALESCE(stock_alerts_sent, 0)::int AS sent,
            (state = 'in') AS live,
            (stock_notified_at IS NOT NULL) AS due
       FROM watch_state WHERE user_id = $1 AND listing_id = $2`,
    [userId, listingId],
  );
  if (!row || !row.live || !row.due) return false;

  const sent = Number(row.sent);
  // Ran out of schedule: the alert is over, and the listing is now just a
  // listing. Nothing here starts it again except going out of stock.
  if (sent >= afterMinutes.length) return false;

  const wait = afterMinutes[sent]!;
  const rows = await db.query<{ listing_id: number }>(
    `UPDATE watch_state SET stock_alerts_sent = $4 + 1
      WHERE user_id = $1 AND listing_id = $2
        AND state = 'in'
        AND COALESCE(stock_alerts_sent, 0) = $4
        AND stock_notified_at <= now() - ($3 || ' minutes')::interval
      RETURNING listing_id`,
    [userId, listingId, Math.round(wait), sent],
  );
  return rows.length > 0;
}

/**
 * Mark the first alert, and start the schedule from now.
 *
 * Called on the edge — out of stock to in — where the post always goes out
 * whatever the schedule says. Everything after it is measured from this.
 */
export async function beginStockAlerts(
  db: Sql,
  userId: number,
  listingId: number,
): Promise<void> {
  await db.query(
    `UPDATE watch_state SET stock_notified_at = now(), stock_alerts_sent = 0
      WHERE user_id = $1 AND listing_id = $2`,
    [userId, listingId],
  );
}

/** Out of stock: forget it, so coming back is news again. */
export async function clearStockAnnounce(
  db: Sql,
  userId: number,
  listingId: number,
): Promise<void> {
  await db.query(
    `UPDATE watch_state SET stock_notified_at = NULL, stock_alerts_sent = 0
      WHERE user_id = $1 AND listing_id = $2 AND stock_notified_at IS NOT NULL`,
    [userId, listingId],
  );
}

/**
 * Forget that we ever announced this listing.
 *
 * Called the moment it stops being staged — sold through, or gone back to
 * nothing. Without this the NEXT load-in on the same listing would be judged
 * against a timestamp from the last one, and a drop two weeks later would
 * announce late or not at all.
 */
export async function clearStagedAnnounce(
  db: Sql,
  userId: number,
  listingId: number,
): Promise<void> {
  await db.query(
    `UPDATE watch_state SET staged_notified_at = NULL
      WHERE user_id = $1 AND listing_id = $2 AND staged_notified_at IS NOT NULL`,
    [userId, listingId],
  );
}

/**
 * The trip line for a load-in, mirrored from the watcher on purpose.
 *
 * 100, not 1: counts of 8 to 20 are ordinary shelf stock, and alerting on
 * those would cry wolf weekly. A drop load-in arrives as hundreds to tens of
 * thousands. The prior must be small so a live drop draining 30k to 20k to 90
 * to 0 fires nothing on the way down and once, at most, on the way up.
 *
 * Two copies of a constant is a smell, and this one is deliberate: the watcher
 * raises the alarm on the machine that saw it, and the Hub raises it for
 * everyone who did not. Neither can rely on the other being present.
 */
export const STOCK_LOADED_MIN = 100;
export const STOCK_LOADED_PRIOR_MAX = 50;

/** Did warehouse stock just appear where there was none? The drop precursor. */
export function stockLoaded(
  prev: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return (next ?? 0) >= STOCK_LOADED_MIN && (prev ?? 0) <= STOCK_LOADED_PRIOR_MAX;
}

export interface RecordedObservation {
  /** Did anything material change? Drives runs and alerts. */
  changed: boolean;
  previousState: string | null;
  previousPrice: number | null;
  /**
   * What the shop said was available at the PREVIOUS reading. Null means it
   * had not said. Carried out of here so a load-in can be detected on the
   * edge — the difference between two readings — rather than by alerting on
   * every reading above the line and then trying to deduplicate it.
   */
  previousQuantity: number | null;
  /** True the first time we ever see this listing. Not a change to shout about. */
  isFirst: boolean;
}

/**
 * Record a reading.
 *
 * `watch_state` is upserted every single time, so the page can always say how
 * stale it is. `observations` gets a row only when the state, the price or the
 * seller actually moved — polling a static product every minute for a week
 * should leave a history of nothing, because nothing happened.
 *
 * The first sighting is marked `isFirst` rather than `changed`. Otherwise
 * turning Phantom on announces every product at once, which is the same
 * mistake the discovery seeding logic exists to avoid.
 */
export async function recordObservation(
  db: Sql,
  userId: number,
  obs: ObservationIn,
): Promise<RecordedObservation> {
  // A reading names a listing by id, and that id arrives over the wire from a
  // Phantom. One shared reading now drives EVERY member's mission on that
  // listing, which raises the stakes rather than lowering them: a bad reading
  // no longer misleads one person, it misleads all of them. So the gate is the
  // catalogue-writer role, and a member's agent is refused outright.
  if (!(await canWriteCatalogue(db, userId))) {
    throw new Error('this account may not write readings to the catalogue');
  }
  const exists = await db.query<{ id: number }>(
    'SELECT id FROM listings WHERE id = $1',
    [obs.listingId],
  );
  if (!exists.length) throw new Error('no such listing');

  const prior = await db.query<{
    state: string;
    price: unknown;
    seller_kind: string;
    available_quantity: unknown;
  }>(
    `SELECT state, price, seller_kind, available_quantity
       FROM watch_state WHERE listing_id = $1`,
    [obs.listingId],
  );

  const before = prior[0] ?? null;
  const isFirst = before === null;
  const previousPrice = before ? toPrice(before.price) : null;
  const price = obs.price ?? null;
  const sellerKind = obs.sellerKind ?? 'unknown';

  // ── Why a count crossing zero counts as a change ──────────────────────────
  //
  // It did not, and that was a real hole. A quantity moving while the state
  // stayed 'out' wrote no row at all: the current number was upserted into
  // watch_state, so the page showed it, and the history showed nothing. Which
  // means the one question worth asking — does inventory appear *before* a drop
  // goes live — had no data behind it, and never would have.
  //
  // Deliberately only across zero, not on every movement. On the way down a
  // live drop ticks 20, 18, 14, 9, and a row for each would be the same flood
  // of noise this table exists to avoid; the per-check activity log carries
  // that, which is the right home for it. Nothing-to-something and
  // something-to-nothing are events. The steps in between are a time series.
  const previousQuantity =
    before && before.available_quantity !== null && before.available_quantity !== undefined
      ? Number(before.available_quantity)
      : null;
  const quantity = obs.availableQuantity ?? null;
  const crossedZero =
    (!previousQuantity && quantity !== null && quantity > 0) ||
    (previousQuantity !== null && previousQuantity > 0 && quantity === 0);

  const changed =
    !isFirst &&
    (before.state !== obs.state ||
      previousPrice !== price ||
      before.seller_kind !== sellerKind ||
      crossedZero);

  await db.query(
    `INSERT INTO watch_state (
       user_id, listing_id, state, confidence, price, seller_kind, seller_name,
       available_quantity, order_limit, is_preorder, release_date, note,
       last_checked_at, last_changed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())
     ON CONFLICT (listing_id) DO UPDATE SET
       state = EXCLUDED.state,
       confidence = EXCLUDED.confidence,
       price = EXCLUDED.price,
       seller_kind = EXCLUDED.seller_kind,
       seller_name = EXCLUDED.seller_name,
       available_quantity = EXCLUDED.available_quantity,
       order_limit = EXCLUDED.order_limit,
       is_preorder = EXCLUDED.is_preorder,
       release_date = EXCLUDED.release_date,
       note = EXCLUDED.note,
       last_checked_at = now(),
       -- Only move this when something actually moved, so "in stock since"
       -- means what it says instead of resetting on every poll.
       last_changed_at = CASE WHEN $13 THEN now() ELSE watch_state.last_changed_at END`,
    [
      userId,
      obs.listingId,
      obs.state,
      obs.confidence ?? 'unknown',
      price,
      sellerKind,
      obs.sellerName ?? '',
      obs.availableQuantity ?? null,
      obs.orderLimit ?? null,
      obs.isPreOrder ?? false,
      obs.releaseDate ?? null,
      (obs.note ?? '').slice(0, 500),
      changed,
    ],
  );

  // A pending "test run" is satisfied by a reading arriving, and by nothing
  // else. Clearing it when the request is *sent* would tick the box for a check
  // that never happened; clearing it here means the button stays lit until the
  // Phantom actually looked.
  // Every mission on this listing, not just the writer's: one reading answers
  // everyone's "check now", because everyone was waiting on the same page.
  await db.query(
    `UPDATE missions SET check_now_at = NULL
      WHERE listing_id = $1 AND check_now_at IS NOT NULL`,
    [obs.listingId],
  );

  // The listing remembers who was selling it, so a mission's seller policy has
  // something to read even before the next check.
  if (sellerKind !== 'unknown') {
    await db.query(
      'UPDATE listings SET seller_kind = $1, seller_name = $2 WHERE id = $3',
      [sellerKind, obs.sellerName ?? '', obs.listingId],
    );
  }

  // The page knows the product's name better than its own URL does. Replace a
  // guess with it, once, and never touch a name a person typed.
  const realName = (obs.productName ?? '').trim();
  if (realName && realName.length <= 200) {
    await db.query(
      `UPDATE products SET name = $1, name_is_guess = false
        WHERE key = (SELECT product_key FROM listings WHERE id = $2)
          AND name_is_guess = true`,
      [realName, obs.listingId],
    );
  }

  // An image is worth having the first time we see one, and never worth
  // overwriting — the retailer's CDN URLs churn and a working one beats a new one.
  if (obs.imageUrl) {
    await db.query(
      `UPDATE products SET image_url = $1
        WHERE image_url = ''
          AND key = (SELECT product_key FROM listings WHERE id = $2)`,
      [obs.imageUrl, obs.listingId],
    );
  }

  if (changed || isFirst) {
    await db.query(
      `INSERT INTO observations
         (user_id, listing_id, state, confidence, price, seller_kind, seller_name,
          available_quantity, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        obs.listingId,
        obs.state,
        obs.confidence ?? 'unknown',
        price,
        sellerKind,
        obs.sellerName ?? '',
        obs.availableQuantity ?? null,
        (obs.note ?? '').slice(0, 500),
      ],
    );
  }

  return {
    changed,
    isFirst,
    previousState: before?.state ?? null,
    previousPrice,
    previousQuantity,
  };
}

/** Recent readings that actually changed. The "what happened" feed. */
export async function recentObservations(db: Sql, userId: number, limit = 50): Promise<
  {
    listingId: number;
    productName: string;
    retailer: string;
    state: string;
    price: number | null;
    sellerKind: string;
    sellerName: string;
    note: string;
    at: string;
  }[]
> {
  const rows = await db.query(
    `SELECT o.listing_id, p.name AS product_name, l.retailer, o.state, o.price,
            o.seller_kind, o.seller_name, o.note, o.at
       FROM observations o
       JOIN listings l ON l.id = o.listing_id
       JOIN products p ON p.key = l.product_key
       -- Scoped by WHAT YOU WATCH, not by who wrote it. The reading is a
       -- shared fact — one row, written once by the catalogue's agent — but an
       -- activity feed carrying every member's products would be unreadable.
       -- A mission on the listing is what makes its history yours to see.
       JOIN missions m ON m.listing_id = o.listing_id AND m.user_id = $1
      ORDER BY o.at DESC, o.id DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    listingId: Number(r.listing_id),
    productName: String(r.product_name ?? ''),
    retailer: String(r.retailer ?? ''),
    state: String(r.state ?? ''),
    price: toPrice(r.price),
    sellerKind: String(r.seller_kind ?? 'unknown'),
    sellerName: String(r.seller_name ?? ''),
    note: String(r.note ?? ''),
    at: r.at ? new Date(String(r.at)).toISOString() : '',
  }));
}

// ─── The activity log ────────────────────────────────────────────────────────
//
// The exception to this file's write-only-when-something-changed rule, and the
// reason is in schema.sql: for diagnosis the boring rows are the signal. A
// failure at 14:02 means one thing if the checks either side of it worked and
// something completely different if they did not.

export interface ActivityIn {
  /** When it happened on Phantom's clock, not when it arrived here. */
  at?: string;
  kind: 'check' | 'pass' | 'hub' | 'browser' | 'startup' | 'sweep';
  level?: 'info' | 'warn' | 'error';
  retailer?: string;
  missionId?: number | null;
  listingId?: number | null;
  state?: string;
  price?: number | null;
  ms?: number | null;
  /** What the retailer said was available. Null means it did not say. */
  availableQuantity?: number | null;
  /** Already scrubbed on Phantom's machine. Scrubbed again on the way out. */
  message: string;
  detail?: string;
}

export interface ActivityRow extends Required<Omit<ActivityIn, 'at'>> {
  id: number;
  at: string;
}

const LEVELS = new Set(['info', 'warn', 'error']);
const KINDS = new Set(['check', 'pass', 'hub', 'browser', 'startup', 'sweep']);

/**
 * Write a batch of activity.
 *
 * Returns how many landed rather than throwing on a bad one: a malformed line
 * in the middle of a batch must not cost the fifty around it, and losing log
 * lines is not worth an error path anywhere upstream.
 */
export async function recordActivity(
  db: Sql,
  userId: number,
  lines: ActivityIn[],
): Promise<{ written: number; rejected: number }> {
  const usable = lines.filter((l) => l && KINDS.has(l.kind) && typeof l.message === 'string');
  if (usable.length === 0) return { written: 0, rejected: lines.length };

  // One statement, many rows. Fifty round trips through the pooler for fifty
  // log lines would cost more than the checks they describe.
  const values: string[] = [];
  const params: unknown[] = [userId];
  for (const l of usable) {
    const base = params.length;
    values.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
        `$${base + 11}, $${base + 12})`,
    );
    params.push(
      l.at && !Number.isNaN(Date.parse(l.at)) ? new Date(l.at).toISOString() : new Date().toISOString(),
      l.kind,
      LEVELS.has(l.level ?? '') ? l.level : 'info',
      (l.retailer ?? '').slice(0, 40),
      Number.isInteger(l.missionId) ? l.missionId : null,
      Number.isInteger(l.listingId) ? l.listingId : null,
      (l.state ?? '').slice(0, 20),
      typeof l.price === 'number' && Number.isFinite(l.price) ? l.price : null,
      Number.isInteger(l.ms) ? l.ms : null,
      Number.isInteger(l.availableQuantity) ? l.availableQuantity : null,
      // A runaway stack trace must not become a megabyte row.
      (l.message ?? '').slice(0, 2000),
      (l.detail ?? '').slice(0, 4000),
    );
  }

  await db.query(
    `INSERT INTO activity
       (user_id, at, kind, level, retailer, mission_id, listing_id, state, price, ms,
        available_quantity, message, detail)
     VALUES ${values.join(', ')}`,
    params,
  );
  return { written: usable.length, rejected: lines.length - usable.length };
}

/** How many days of activity are kept, and the hard ceiling underneath it. */
export const ACTIVITY_DAYS = 7;
export const ACTIVITY_MAX_ROWS = 50_000;

/**
 * Keep the log from becoming the database.
 *
 * Two rules, because either alone has a hole. Age alone is unbounded if
 * something starts looping and writes a million rows in an hour; a row cap
 * alone keeps a year of history for an idle account and none for a busy one.
 */
export async function pruneActivity(db: Sql, userId: number): Promise<number> {
  const old = await db.query<{ id: number }>(
    `DELETE FROM activity
      WHERE user_id = $1 AND at < now() - ($2 || ' days')::interval
      RETURNING id`,
    [userId, String(ACTIVITY_DAYS)],
  );
  const over = await db.query<{ id: number }>(
    `DELETE FROM activity
      WHERE user_id = $1
        AND id <= COALESCE(
          (SELECT id FROM activity WHERE user_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1), -1)
      RETURNING id`,
    [userId, ACTIVITY_MAX_ROWS],
  );
  return old.length + over.length;
}

function toActivity(r: Record<string, unknown>): ActivityRow {
  return {
    id: Number(r.id),
    at: r.at ? new Date(String(r.at)).toISOString() : '',
    kind: String(r.kind ?? '') as ActivityIn['kind'],
    level: String(r.level ?? 'info') as 'info' | 'warn' | 'error',
    retailer: String(r.retailer ?? ''),
    missionId: r.mission_id === null || r.mission_id === undefined ? null : Number(r.mission_id),
    listingId: r.listing_id === null || r.listing_id === undefined ? null : Number(r.listing_id),
    state: String(r.state ?? ''),
    price: toPrice(r.price),
    ms: r.ms === null || r.ms === undefined ? null : Number(r.ms),
    availableQuantity:
      r.available_quantity === null || r.available_quantity === undefined
        ? null
        : Number(r.available_quantity),
    message: String(r.message ?? ''),
    detail: String(r.detail ?? ''),
  };
}

/** The log, newest first. `sinceHours` bounds it; `level` narrows to trouble. */
export async function recentActivity(
  db: Sql,
  userId: number,
  opts: { sinceHours?: number; limit?: number; level?: 'warn' | 'error' } = {},
): Promise<ActivityRow[]> {
  const hours = Math.min(Math.max(opts.sinceHours ?? 24, 1), ACTIVITY_DAYS * 24);
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 20_000);
  const where = opts.level === 'error'
    ? `AND level = 'error'`
    : opts.level === 'warn'
      ? `AND level IN ('warn', 'error')`
      : '';
  const rows = await db.query(
    `SELECT * FROM activity
      WHERE user_id = $1 AND at > now() - ($2 || ' hours')::interval ${where}
      ORDER BY at DESC, id DESC
      LIMIT $3`,
    [userId, String(hours), limit],
  );
  return rows.map(toActivity);
}

/**
 * The shape of what happened, without the lines.
 *
 * What you want first when something is wrong: which retailer, how often it
 * worked, how often it did not, and how slow it was when it did. Computed in
 * the database because pulling ten thousand rows to count them is the kind of
 * thing that turns a diagnostic into an outage.
 */
export async function activitySummary(
  db: Sql,
  userId: number,
  sinceHours = 24,
): Promise<
  { retailer: string; checks: number; failures: number; inStock: number; medianMs: number | null }[]
> {
  const hours = Math.min(Math.max(sinceHours, 1), ACTIVITY_DAYS * 24);
  const rows = await db.query(
    `SELECT retailer,
            COUNT(*)                                          AS checks,
            COUNT(*) FILTER (WHERE level = 'error')           AS failures,
            COUNT(*) FILTER (WHERE state = 'in')              AS in_stock,
            PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY ms)   AS median_ms
       FROM activity
      WHERE user_id = $1 AND kind = 'check' AND at > now() - ($2 || ' hours')::interval
      GROUP BY retailer
      ORDER BY checks DESC`,
    [userId, String(hours)],
  );
  return rows.map((r) => ({
    retailer: String(r.retailer ?? ''),
    checks: Number(r.checks ?? 0),
    failures: Number(r.failures ?? 0),
    inStock: Number(r.in_stock ?? 0),
    medianMs: r.median_ms === null || r.median_ms === undefined ? null : Number(r.median_ms),
  }));
}


// ─── Reviewing what a sweep found ────────────────────────────────────────────
//
// A sweep proposes and a person decides. The deciding is the whole reason the
// feed is usable: without a way to say "never show me this again", every sweep
// re-offers the thirty things already rejected.

export interface DiscoveryRow {
  id: number;
  sourceId: string;
  externalId: string;
  name: string;
  url: string;
  price: number | null;
  kind: string;
  confidence: string;
  foundBy: string;
  imageUrl: string;
  status: string;
  firstSeenAt: string;
  /** True when a product with this name already exists — usually already yours. */
  alreadyHave: boolean;
  /** Which shop. Blank only for rows found before this was recorded. */
  retailer: string;
  /** 'in' | 'out' | 'unknown' as at the last sweep that saw it. */
  state: string;
  isPreOrder: boolean;
  releaseDate: string;
  orderLimit: number | null;
  /**
   * What the shop said was available at the last sweep. Null means it did not
   * say. Beside a state that is not 'in', a positive number is staged stock.
   */
  availableQuantity: number | null;
  /** 'buyable' | 'scheduled' | 'recent' — why it was surfaced. */
  signal: string;
  /** Other sellers with an offer on the same listing. Null when unknown. */
  otherOffers: number | null;
}

function toDiscovery(r: Record<string, unknown>): DiscoveryRow {
  return {
    id: Number(r.id),
    sourceId: String(r.source_id ?? ''),
    externalId: String(r.external_id ?? ''),
    name: String(r.name ?? ''),
    url: String(r.url ?? ''),
    price: toPrice(r.price),
    kind: String(r.kind ?? ''),
    confidence: String(r.confidence ?? ''),
    foundBy: String(r.found_by ?? ''),
    imageUrl: String(r.image_url ?? ''),
    status: String(r.status ?? 'new'),
    firstSeenAt: r.first_seen_at ? new Date(String(r.first_seen_at)).toISOString() : '',
    alreadyHave: Boolean(r.already_have),
    retailer: String(r.retailer ?? ''),
    state: String(r.state ?? ''),
    isPreOrder: Boolean(r.is_pre_order),
    releaseDate: String(r.release_date ?? ''),
    orderLimit: r.order_limit === null || r.order_limit === undefined ? null : Number(r.order_limit),
    availableQuantity:
      r.available_quantity === null || r.available_quantity === undefined
        ? null
        : Number(r.available_quantity),
    signal: String(r.signal ?? ''),
    otherOffers:
      r.other_offers === null || r.other_offers === undefined ? null : Number(r.other_offers),
  };
}

/**
 * Everything waiting on a decision, newest first.
 *
 * Distinct from `pendingDiscoveries` above, which answers a different question
 * — "what has this source found that was never announced". This one is about
 * whether a *person* has looked at it yet.
 */
export async function discoveriesToReview(
  db: Sql,
  userId: number,
  limit = 200,
): Promise<DiscoveryRow[]> {
  const rows = await db.query(
    `SELECT d.*,
            EXISTS (
              SELECT 1 FROM listings l WHERE l.external_id = d.external_id
            ) AS already_have
       FROM discoveries d
      WHERE d.status = 'new'
      ORDER BY d.first_seen_at DESC, d.id DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(toDiscovery);
}

export async function getDiscovery(
  db: Sql,
  userId: number,
  id: number,
): Promise<DiscoveryRow | null> {
  const rows = await db.query(
    `SELECT *, false AS already_have FROM discoveries WHERE id = $1`,
    [id],
  );
  return rows.length ? toDiscovery(rows[0]!) : null;
}

/**
 * Decline one, permanently.
 *
 * Not a delete. The row is what stops the next sweep rediscovering the same
 * thing and offering it again as news — the discovery table is also the memory
 * of what has been seen.
 */
export async function forgetDiscovery(db: Sql, userId: number, id: number): Promise<boolean> {
  // Deciding a find is curation: "never offer this again" is a judgement that
  // now sticks for everybody, so only a catalogue writer may make it.
  if (!(await canWriteCatalogue(db, userId))) return false;
  const rows = await db.query<{ id: number }>(
    `UPDATE discoveries SET status = 'forgotten', decided_at = now()
      WHERE id = $1 AND status = 'new'
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Promote one to something watchable.
 *
 * Creates the product and the listing and nothing else. **No mission, and
 * certainly nothing armed** — a sweep is a machine's guess and arming is a
 * decision about money, so the two are kept a deliberate click apart.
 */
export async function keepDiscovery(
  db: Sql,
  userId: number,
  id: number,
): Promise<{ productKey: string; listingId: number; missionId: number }> {
  // Keeping a find creates catalogue rows everybody will watch against.
  if (!(await canWriteCatalogue(db, userId))) {
    throw new Error('this account may not add to the catalogue');
  }
  const found = await getDiscovery(db, userId, id);
  if (!found) throw new Error('no such discovery');
  if (found.status !== 'new') throw new Error(`this one was already ${found.status}`);

  const source = await getSource(db, userId, found.sourceId);
  const retailer = source?.retailer ?? 'Target';

  const product = await upsertProduct(db, userId, {
    name: found.name,
    msrp: found.price ?? null,
    imageUrl: found.imageUrl,
    // The sweep read the street date off the retailer's own page; dropping it
    // here left every kept product saying "no release date" while the
    // discovery row underneath it knew better.
    releaseDate: found.releaseDate || null,
  });
  const listing = await addListing(db, userId, {
    productKey: product.key,
    retailer,
    externalId: found.externalId,
    url: found.url,
  });

  // Watching, never armed. For weeks Keep stopped at the listing, and the
  // difference was invisible until release week: seventeen kept finds, three
  // missions, and nothing polling the other fourteen. Keeping something IS
  // the decision to watch it — quick-add already worked this way, and a find
  // you kept but nothing looks at is a decision the system quietly ignored.
  // Arming stays a separate, deliberate act; this creates eyes, not a wallet.
  const mission = await upsertMission(db, userId, {
    listingId: listing.id,
    label: product.name,
  });

  await db.query(
    `UPDATE discoveries SET status = 'kept', decided_at = now(), product_key = $3
      WHERE user_id = $1 AND id = $2`,
    [userId, id, product.key],
  );
  return { productKey: product.key, listingId: listing.id, missionId: mission.id };
}


// ─── When the catalogue is next worth sweeping ───────────────────────────────

/**
 * Is a sweep due?
 *
 * Pure, and deliberately the Hub's decision rather than Phantom's. The
 * Phantom is a process that restarts — sometimes several times an hour while
 * something is being fixed — and a restart must not mean another sweep. The
 * Hub already records when the last one finished, so it is the only thing that
 * can answer this without being wrong after a reboot.
 */
export function isSweepDue(
  lastSweptAt: string | null,
  everyHours: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(everyHours) || everyHours <= 0) return false;
  if (!lastSweptAt) return true;
  const last = Date.parse(lastSweptAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= everyHours * 3600_000;
}

/** The same question, against a real source. Returns false for a source that does not exist. */
export async function sweepDue(
  db: Sql,
  userId: number,
  sourceId: string,
  everyHours: number,
  now: number = Date.now(),
): Promise<boolean> {
  const source = await getSource(db, userId, sourceId);
  if (!source || !source.enabled) return false;
  // Asked for by hand beats the schedule, and beats sweeping being switched
  // off entirely — pressing the button is a clearer statement of intent than
  // any setting.
  if (source.sweepNowAt) return true;
  return isSweepDue(source.lastSweptAt, everyHours, now);
}

/** Ask for a sweep on the next pass. */
export async function requestSweep(db: Sql, userId: number, sourceId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE sources SET sweep_now_at = now()
      WHERE user_id = $1 AND id = $2 AND enabled = true
      RETURNING id`,
    [userId, sourceId],
  );
  return rows.length > 0;
}

/**
 * Waiting rooms seen recently — one row per retailer, newest sighting first.
 *
 * A queue at a retailer means everyone is being made to wait because
 * something is dropping, which makes it the loudest early signal this system
 * ever receives. Matched on the words Phantom writes (its 'QUEUE:' sweep
 * lines, and the 'waiting room' challenge wording on checks) because a queue
 * is by definition a page Phantom could not read — there is no cleaner
 * column to ask. The wording is a contract, pinned by tests in both packages.
 */
export async function queueSightings(
  db: Sql,
  userId: number,
  minutes = 30,
): Promise<{ retailer: string; at: string }[]> {
  const rows = await db.query<{ retailer: string; at: string }>(
    `SELECT retailer, max(at) AS at
       FROM activity
      WHERE user_id = $1
        AND at > now() - ($2 || ' minutes')::interval
        AND (message ILIKE '%waiting room%' OR message LIKE 'QUEUE:%')
      GROUP BY retailer
      ORDER BY max(at) DESC`,
    [userId, String(minutes)],
  );
  return rows.map((r) => ({ retailer: r.retailer, at: String(r.at) }));
}

/**
 * Load-ins Phantom has alarmed on: warehouse stock appearing on a watched
 * listing that had none — Target's loudest pre-drop tell, readable hours
 * before the page turns buyable. A long window (12h by default) on purpose:
 * the load lands the evening before a small-hours drop, and the person who
 * needs to see it is asleep in between.
 */
export async function stockLoadSightings(
  db: Sql,
  userId: number,
  minutes = 720,
): Promise<{ retailer: string; message: string; at: string }[]> {
  const rows = await db.query<{ retailer: string; message: string; at: string }>(
    `SELECT DISTINCT ON (message) retailer, message, at
       FROM activity
      WHERE user_id = $1
        AND at > now() - ($2 || ' minutes')::interval
        AND message LIKE 'STOCK LOADED:%'
      ORDER BY message, at DESC`,
    [userId, String(minutes)],
  );
  return rows
    .map((r) => ({ retailer: r.retailer, message: String(r.message), at: String(r.at) }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** What the page needs to render the sweep button and say when it last ran. */
export async function sweepState(
  db: Sql,
  userId: number,
  sourceId: string,
  everyHours: number,
): Promise<{ queued: boolean; lastSweptAt: string | null; lastStatus: string }> {
  const source = await getSource(db, userId, sourceId);
  if (!source) return { queued: false, lastSweptAt: null, lastStatus: '' };
  return {
    queued: Boolean(source.sweepNowAt),
    lastSweptAt: source.lastSweptAt,
    lastStatus: source.lastStatus ?? '',
  };
}

/* ── Requests: the way a member gets something into the catalogue ────────────
 *
 * Curation is a role, so a member cannot add a product. But a member is the
 * one out there finding things, and a system where the only way to say "you
 * are missing this" is to message a person is a system that loses most of
 * what it is told.
 *
 * So they send a LINK. It goes in a queue with their name on it, the owner
 * turns it into a real listing, and the person who asked can see what happened
 * to it. The catalogue stays curated; the finding does not have to be.
 */

export interface ProductRequestRow {
  id: number;
  userId: number;
  handle: string;
  url: string;
  note: string;
  status: 'pending' | 'approved' | 'declined';
  listingId: number | null;
  decidedAt: string | null;
  decidedNote: string;
  createdAt: string;
}

function toRequest(r: Record<string, unknown>): ProductRequestRow {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    handle: String(r.handle ?? ''),
    url: String(r.url),
    note: String(r.note ?? ''),
    status: String(r.status) as ProductRequestRow['status'],
    listingId: r.listing_id === null || r.listing_id === undefined ? null : Number(r.listing_id),
    decidedAt: r.decided_at ? String(r.decided_at) : null,
    decidedNote: String(r.decided_note ?? ''),
    createdAt: String(r.created_at),
  };
}

const REQUEST_SELECT = `SELECT r.*, u.handle FROM product_requests r
   JOIN users u ON u.id = r.user_id`;

/**
 * File a link for the catalogue owner to look at.
 *
 * Re-sending the same URL does not queue a second copy — the unique key sees
 * to that — and it does not silently resurrect a request that was already
 * DECLINED either. Saying no once has to mean something, or the queue becomes
 * the same argument every week.
 */
export async function requestProduct(
  db: Sql,
  userId: number,
  url: string,
  note = '',
): Promise<ProductRequestRow> {
  const clean = url.trim();
  if (!clean) throw new Error('a request needs a URL');
  if (clean.length > 2000) throw new Error('that URL is too long to be a product link');

  const rows = await db.query(
    `INSERT INTO product_requests (user_id, url, note)
          VALUES ($1, $2, $3)
     ON CONFLICT (user_id, url) DO UPDATE
            SET note = EXCLUDED.note
          WHERE product_requests.status = 'pending'
      RETURNING id`,
    [userId, clean, note.trim().slice(0, 500)],
  );

  // No row back means the conflict hit a row that is already decided. Return
  // it as it stands rather than pretending a new request was filed.
  const id = rows[0]
    ? Number(rows[0].id)
    : Number(
        (
          await db.query<{ id: number }>(
            'SELECT id FROM product_requests WHERE user_id = $1 AND url = $2',
            [userId, clean],
          )
        )[0]!.id,
      );
  const full = await db.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  return toRequest(full[0]!);
}

/**
 * What this account should see of the queue.
 *
 * A catalogue writer sees everybody's, because deciding them is their job. A
 * member sees only their own — the queue is other people's finds, and there is
 * nothing in someone else's pending link that is any of their business.
 */
export async function listProductRequests(
  db: Sql,
  userId: number,
  status?: ProductRequestRow['status'],
): Promise<ProductRequestRow[]> {
  const mine = !(await canWriteCatalogue(db, userId));
  const where: string[] = [];
  const args: unknown[] = [];
  if (mine) {
    args.push(userId);
    where.push(`r.user_id = $${args.length}`);
  }
  if (status) {
    args.push(status);
    where.push(`r.status = $${args.length}`);
  }
  const rows = await db.query(
    `${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC
      LIMIT 200`,
    args,
  );
  return rows.map(toRequest);
}

export async function getProductRequest(
  db: Sql,
  userId: number,
  id: number,
): Promise<ProductRequestRow | null> {
  const writer = await canWriteCatalogue(db, userId);
  const rows = await db.query(
    `${REQUEST_SELECT} WHERE r.id = $1 ${writer ? '' : 'AND r.user_id = $2'}`,
    writer ? [id] : [id, userId],
  );
  return rows[0] ? toRequest(rows[0]) : null;
}

/**
 * Say yes or no to a request. Owner only, and the row is kept either way.
 *
 * A declined request is not deleted, so the same link cannot come back around
 * as a fresh ask, and the person who sent it can see that it was looked at
 * rather than assuming it fell down a hole.
 */
export async function decideProductRequest(
  db: Sql,
  userId: number,
  id: number,
  status: 'approved' | 'declined',
  opts: { listingId?: number | null; note?: string } = {},
): Promise<ProductRequestRow | null> {
  if (!(await canWriteCatalogue(db, userId))) {
    throw new Error('this account may not decide requests for the catalogue');
  }
  const rows = await db.query<{ id: number }>(
    `UPDATE product_requests
        SET status = $2, listing_id = $3, decided_note = $4, decided_at = now()
      WHERE id = $1
      RETURNING id`,
    [id, status, opts.listingId ?? null, (opts.note ?? '').trim().slice(0, 500)],
  );
  if (!rows[0]) return null;
  const full = await db.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  return toRequest(full[0]!);
}

/** How many links are waiting — the number that belongs on the owner's tab. */
export async function pendingRequestCount(db: Sql, userId: number): Promise<number> {
  if (!(await canWriteCatalogue(db, userId))) return 0;
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_requests WHERE status = 'pending'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * When this account's Phantom was last heard from.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On 1 Sep 2026 Phantom died at 19:14 and nobody noticed for thirty-five
 * minutes. Nothing was broken enough to say so: the missions all still showed
 * their last reading, the numbers just got older, and "checked 3m ago" turning
 * into "checked 35m ago" is only alarming if you already know what normal is.
 * A watcher that is off looks exactly like a watcher whose products have not
 * changed — which is the one failure this whole system cannot afford.
 *
 * ── Why the activity log, and not a heartbeat column ────────────────────────
 *
 * Because it needs no migration and it is already true. Phantom writes an
 * activity line every pass, and — this is the part that matters — it writes
 * one when it is RESTING too ("outside watching hours"). So silence here means
 * the process is not running, not that it has nothing to do, and the banner
 * cannot cry wolf every night at the hour the schedule closes.
 */
export async function agentLastSeen(db: Sql, userId: number): Promise<string | null> {
  const rows = await db.query<{ at: string | null }>(
    'SELECT max(at) AS at FROM activity WHERE user_id = $1',
    [userId],
  );
  const at = rows[0]?.at;
  return at ? String(at) : null;
}

/**
 * Which listings somebody has asked to be checked RIGHT NOW.
 *
 * ── Why this is its own query ───────────────────────────────────────────────
 *
 * "Check now" could only ever be as fast as Phantom's next poll of the Hub,
 * because the Hub cannot call a machine sitting behind somebody's router — the
 * traffic only goes one way. That poll was the full watchlist: every mission
 * joined to its listing, product and watch_state, once a cycle. Fine every
 * ninety seconds, absurd every three.
 *
 * So this is the fast lane: one indexed column, no joins, a few integers back.
 * Cheap enough to ask constantly, which is the only thing that turns "queued"
 * into "now".
 *
 * Listing ids rather than mission ids, deliberately. The catalogue is shared,
 * so a member pressing the button and the owner's agent doing the reading are
 * talking about the same shelf under different mission numbers — and one read
 * answers both.
 */
export async function urgentListings(db: Sql, userId: number): Promise<number[]> {
  const writer = await canWriteCatalogue(db, userId);
  // A catalogue writer reads for everybody, so it honours everybody's button.
  // Anyone else sees only their own — asking for a check on a listing you do
  // not watch is not a thing the app offers, and it is not a thing this should
  // start allowing by accident.
  const rows = writer
    ? await db.query<{ listing_id: number }>(
        `SELECT DISTINCT listing_id FROM missions
          WHERE enabled = true AND check_now_at IS NOT NULL`,
      )
    : await db.query<{ listing_id: number }>(
        `SELECT DISTINCT listing_id FROM missions
          WHERE user_id = $1 AND enabled = true AND check_now_at IS NOT NULL`,
        [userId],
      );
  return rows.map((r) => Number(r.listing_id));
}

/* ── The dashboard ───────────────────────────────────────────────────────────
 *
 * Everything below answers one question — WHERE ARE WE LOSING IT? — and every
 * number comes out of a table this system already writes. Nothing here is
 * estimated, and nothing is shown that cannot be traced to a row.
 *
 * The honest shape of the funnel is two kinds of thing, and it says so rather
 * than pretending otherwise: the first stages are STATES (what is being
 * watched, what is armed, right now) and the last are EVENTS (what happened in
 * the window). Drawing them as one smooth cone would be a nicer picture and a
 * worse answer.
 */

export interface Funnel {
  /** Enabled missions, right now. */
  watching: number;
  /**
   * Of those, how many saw their listing in stock FROM THE SHOP ITSELF.
   *
   * ── Why the seller matters more than the stock ────────────────────────────
   *
   * The first version counted any in-stock reading and reported fifteen
   * listings, which read as fifteen missed chances. Two of them were. The
   * other thirteen were Walmart marketplace resellers, which are permanently
   * in stock at two to four times MSRP — and every mission refuses them on
   * purpose, because `retailer_only` is the default and a reseller listing is
   * the thing you are racing, not the thing you want.
   *
   * Counting those as opportunities made the funnel say we were losing
   * thirteen chances a week that never existed, and pointed the next day's
   * work at arming when the honest answer was that almost nothing had dropped.
   */
  sawStock: number;
  /** Of the ones that saw stock, how many were armed to do anything about it. */
  sawStockArmed: number;
  /**
   * Listings that were only ever in stock from a marketplace seller.
   *
   * Context, not loss. Shown so the number above is not mistaken for the whole
   * story — and so "nothing dropped this week" can be told apart from "we were
   * asleep".
   */
  resellerOnly: number;
  /**
   * Listings that read COUNTED BUT NOT SELLABLE in the window.
   *
   * The pre-drop tell, and the only stage of this funnel that can move before
   * a race starts rather than after it. Reported even when it is zero, because
   * zero is the finding: across 3,671 readings carrying a count, every single
   * non-zero one was already sellable. A stage that has never once fired
   * should say so on the page rather than be quietly left off it.
   */
  staged: number;
  /** The largest staged count seen in the window. The size of the load-in. */
  stagedPeak: number;
  /** Grants issued in the window — the Hub said yes to spending. */
  authorised: number;
  /** Orders the retailer confirmed. */
  bought: number;
  /** Every run outcome in the window, most common first. The real diagnosis. */
  outcomes: { outcome: string; n: number }[];
  /** Why armed missions did not buy, in their own words, most common first. */
  refusals: { reason: string; n: number }[];
}

export async function funnel(db: Sql, userId: number, hours: number): Promise<Funnel> {
  const since = `${Math.max(1, Math.round(hours))} hours`;

  const [state] = await db.query<{ watching: string; armed: string }>(
    `SELECT count(*) FILTER (WHERE enabled)::text AS watching,
            count(*) FILTER (WHERE enabled AND armed)::text AS armed
       FROM missions WHERE user_id = $1`,
    [userId],
  );

  // Seen in stock, split by WHO was selling it.
  //
  // Joined through this user's missions, so a reading written by somebody
  // else's agent on a shared listing still counts for the person watching it —
  // which is the whole point of one read serving everyone.
  //
  // `seller_kind = 'retailer'` is the whole correction. A marketplace listing
  // sitting in stock all month is not an opportunity anybody missed; it is the
  // thing every mission is configured to refuse.
  const [seen] = await db.query<{ seen: string; armed: string; reseller: string }>(
    `WITH sightings AS (
       SELECT m.listing_id,
              bool_or(o.seller_kind = 'retailer') AS from_shop,
              bool_or(m.armed) AS armed
         FROM missions m
         JOIN observations o ON o.listing_id = m.listing_id
        WHERE m.user_id = $1 AND m.enabled
          AND o.state = 'in'
          AND o.at > now() - $2::interval
        GROUP BY m.listing_id
     )
     SELECT count(*) FILTER (WHERE from_shop)::text AS seen,
            count(*) FILTER (WHERE from_shop AND armed)::text AS armed,
            count(*) FILTER (WHERE NOT from_shop)::text AS reseller
       FROM sightings`,
    [userId, since],
  );

  // Counted, and the shop still saying no. Same definition the mission card
  // paints STOCK STAGED on, asked of the window rather than of right now, and
  // scoped through this user's missions like every other stage here.
  const [loaded] = await db.query<{ n: string; peak: string }>(
    `SELECT count(DISTINCT o.listing_id)::text AS n,
            COALESCE(max(o.available_quantity), 0)::text AS peak
       FROM missions m
       JOIN observations o ON o.listing_id = m.listing_id
      WHERE m.user_id = $1 AND m.enabled
        AND o.state <> 'in'
        AND o.available_quantity > 0
        AND o.at > now() - $2::interval`,
    [userId, since],
  );

  const [grants] = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM authorisations
      WHERE user_id = $1 AND granted_at > now() - $2::interval`,
    [userId, since],
  );

  const outcomes = await db.query<{ outcome: string; n: string }>(
    `SELECT r.outcome, count(*)::text AS n
       FROM mission_runs r JOIN missions m ON m.id = r.mission_id
      WHERE m.user_id = $1 AND r.started_at > now() - $2::interval
      GROUP BY r.outcome ORDER BY count(*) DESC`,
    [userId, since],
  );

  /*
   * Why it did not buy, classified rather than chopped.
   *
   * The first version split the reason on its first comma, which for
   * "sold by Rares Market L.L.C., and this mission is retailer-only" keeps the
   * SELLER and throws away the reason — so every row had a count of one and
   * the list said nothing. The useful half is the kind of refusal, and the
   * kinds are knowable: this system writes them.
   *
   * Anything unmatched falls into its own bucket with its opening words
   * intact, so a refusal nobody anticipated shows up as itself instead of
   * being quietly folded into "other".
   */
  const refusals = await db.query<{ reason: string; n: string }>(
    `SELECT CASE
              WHEN r.reason ILIKE '%retailer-only%'       THEN 'Sold by a marketplace seller'
              WHEN r.reason ILIKE '%pre-order%'           THEN 'It was a pre-order, not stock'
              WHEN r.reason ILIKE '%no price ceiling%'    THEN 'Armed with no ceiling set'
              WHEN r.reason ILIKE '%over the%ceiling%'    THEN 'Over the price ceiling'
              WHEN r.reason ILIKE '%refusing to buy blind%' THEN 'In stock but no price could be read'
              WHEN r.reason ILIKE '%cap%'                 THEN 'Would have passed the daily spend cap'
              WHEN r.reason ILIKE '%press%hold%'
                OR r.reason ILIKE '%challenge%'
                OR r.reason ILIKE '%waiting room%'
                OR r.reason ILIKE '%bot wall%'            THEN 'The shop asked for a human'
              WHEN r.reason ILIKE '%watching only%'       THEN 'Seen, but the mission only watches'
              WHEN r.outcome = 'failed'                   THEN 'The check or the checkout broke'
              ELSE left(r.reason, 60)
            END AS reason,
            count(*)::text AS n
       FROM mission_runs r JOIN missions m ON m.id = r.mission_id
      WHERE m.user_id = $1 AND r.started_at > now() - $2::interval
        AND r.outcome IN ('declined', 'blocked', 'failed')
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
    [userId, since],
  );

  const n = (rows: { n: string }[], i = 0): number => Number(rows[i]?.n ?? 0);

  return {
    watching: Number(state?.watching ?? 0),
    sawStock: Number(seen?.seen ?? 0),
    sawStockArmed: Number(seen?.armed ?? 0),
    resellerOnly: Number(seen?.reseller ?? 0),
    staged: Number(loaded?.n ?? 0),
    stagedPeak: Number(loaded?.peak ?? 0),
    authorised: n([grants ?? { n: '0' }]),
    bought: Number(outcomes.find((o) => o.outcome === 'bought')?.n ?? 0),
    outcomes: outcomes.map((o) => ({ outcome: String(o.outcome), n: Number(o.n) })),
    refusals: refusals
      .map((r) => ({ reason: String(r.reason ?? '').trim(), n: Number(r.n) }))
      .filter((r) => r.reason),
  };
}

export interface Health {
  /** Page reads in the window. */
  checks: number;
  /** Reads that failed outright. */
  failed: number;
  /** Times a shop served a wall or a waiting room instead of a page. */
  challenged: number;
  /** Median read time per shop, in milliseconds. */
  speed: { retailer: string; medianMs: number; checks: number }[];
  /**
   * The share of five-minute buckets in which the machine said anything.
   *
   * Not a uptime guess: Phantom writes an activity line every pass INCLUDING
   * when it is resting outside watching hours, so a silent bucket means the
   * process was not running. It is the same signal the silence banner uses,
   * counted rather than thresholded.
   */
  uptime: number;
  /** How many separate silences, so one long outage is not read as many. */
  stalls: number;
}

export async function health(db: Sql, userId: number, hours: number): Promise<Health> {
  const since = `${Math.max(1, Math.round(hours))} hours`;

  const [totals] = await db.query<{ checks: string; failed: string; challenged: string }>(
    `SELECT count(*) FILTER (WHERE kind = 'check')::text AS checks,
            count(*) FILTER (WHERE kind = 'check' AND level = 'error')::text AS failed,
            count(*) FILTER (WHERE message LIKE 'blocked:%')::text AS challenged
       FROM activity
      WHERE user_id = $1 AND at > now() - $2::interval`,
    [userId, since],
  );

  const speed = await db.query<{ retailer: string; median: string; n: string }>(
    `SELECT retailer,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::text AS median,
            count(*)::text AS n
       FROM activity
      WHERE user_id = $1 AND at > now() - $2::interval
        AND kind = 'check' AND ms IS NOT NULL AND ms > 0 AND retailer <> ''
      GROUP BY retailer ORDER BY count(*) DESC`,
    [userId, since],
  );

  // Buckets, not gaps. A gap query needs a window function over every row in
  // the period; this counts distinct five-minute slots that have something in
  // them and compares that to how many slots there were.
  const [buckets] = await db.query<{ seen: string; total: string }>(
    `SELECT count(DISTINCT date_trunc('hour', at) + interval '5 min' *
              floor(extract(minute FROM at) / 5))::text AS seen,
            (extract(epoch FROM $2::interval) / 300)::int::text AS total
       FROM activity
      WHERE user_id = $1 AND at > now() - $2::interval`,
    [userId, since],
  );

  const seen = Number(buckets?.seen ?? 0);
  const total = Math.max(1, Number(buckets?.total ?? 1));

  return {
    checks: Number(totals?.checks ?? 0),
    failed: Number(totals?.failed ?? 0),
    challenged: Number(totals?.challenged ?? 0),
    speed: speed.map((s) => ({
      retailer: String(s.retailer),
      medianMs: Math.round(Number(s.median ?? 0)),
      checks: Number(s.n),
    })),
    uptime: Math.min(1, seen / total),
    stalls: Math.max(0, total - seen),
  };
}

/**
 * The wins. Confirmed orders only.
 *
 * A run marked 'bought' is only written after the retailer's own page said an
 * order exists — the click alone proved nothing on the first live attempt, and
 * that lesson is why this list can be trusted. Dry runs are not wins and are
 * not here; a page that pads itself stops being worth opening.
 */
/* ── The money ───────────────────────────────────────────────────────────────
 *
 * Three numbers, and the whole reason there are three is that "spent" is not
 * one thing:
 *
 *   SETTLED    an order. The money is gone.
 *   COMMITTED  a pre-order. The retailer takes it at ship, sometimes months
 *              out — it is owed, not paid, and it is still yours until then.
 *   OPEN       a grant the Hub issued that never resolved. Either a buy in
 *              progress, or a Phantom that died mid-checkout and nobody knows
 *              whether money moved. Counted, because "we are not sure" is a
 *              real state and rounding it to zero is how a budget lies.
 *
 * A budget that adds the first two together is wrong twice: it says you have
 * less to work with than you do, and it forgets the bill that is coming.
 */
export interface Money {
  /** The standing pot, from settings. Zero means "not set", not "no money". */
  budget: number;
  /** Orders. Paid. */
  settled: number;
  /** Pre-orders not yet released. Owed. */
  committed: number;
  /** Grants still open — a buy in flight, or one nobody resolved. */
  open: number;
  /** budget − settled − committed − open, when a budget is set. */
  left: number | null;
  /** What is owed, and when it comes due. Soonest first. */
  upcoming: { name: string; retailer: string; releaseDate: string | null; total: number }[];
}

export async function money(db: Sql, userId: number): Promise<Money> {
  const settings = await getSettings(db, userId);

  const [totals] = await db.query<{ settled: string; committed: string }>(
    `SELECT coalesce(sum(r.total) FILTER (WHERE NOT r.is_preorder), 0)::text AS settled,
            coalesce(sum(r.total) FILTER (WHERE r.is_preorder), 0)::text AS committed
       FROM mission_runs r JOIN missions m ON m.id = r.mission_id
      WHERE m.user_id = $1 AND r.outcome = 'bought'`,
    [userId],
  );

  const [grants] = await db.query<{ open: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS open
       FROM authorisations WHERE user_id = $1 AND status = 'granted'`,
    [userId],
  );

  const upcoming = await db.query<{
    name: string; retailer: string; release_date: string | null; total: string;
  }>(
    `SELECT p.name, l.retailer, r.release_date, coalesce(r.total, 0)::text AS total
       FROM mission_runs r
       JOIN missions m ON m.id = r.mission_id
       JOIN listings l ON l.id = m.listing_id
       JOIN products p ON p.key = l.product_key
      WHERE m.user_id = $1 AND r.outcome = 'bought' AND r.is_preorder
      ORDER BY r.release_date NULLS LAST, r.started_at
      LIMIT 20`,
    [userId],
  );

  const budget = Number(settings.budgetTotal ?? 0);
  const settled = Number(totals?.settled ?? 0);
  const committed = Number(totals?.committed ?? 0);
  const open = Number(grants?.open ?? 0);

  return {
    budget,
    settled,
    committed,
    open,
    left: budget > 0 ? Math.round((budget - settled - committed - open) * 100) / 100 : null,
    upcoming: upcoming.map((u) => ({
      name: String(u.name ?? ''),
      retailer: String(u.retailer ?? ''),
      // toDate, not slice: a DATE column arrives as a Date object, and
      // String(date).slice(0, 10) is "Sat Nov 14" — a label that looks
      // almost right and has lost the year.
      releaseDate: toDate(u.release_date),
      total: Number(u.total),
    })),
  };
}

export interface Win {
  runId: number;
  missionId: number;
  productName: string;
  retailer: string;
  at: string;
  quantity: number;
  unitPrice: number | null;
  total: number | null;
  msrp: number | null;
  /** queued | sent | dismissed | null when no vault row exists yet. */
  vaultStatus: string | null;
  /** An order is paid; a pre-order is owed. The page must not blur them. */
  isPreOrder: boolean;
  /** When a pre-order ships, if the shop said. */
  releaseDate: string | null;
}

export async function wins(db: Sql, userId: number, limit = 100): Promise<Win[]> {
  const rows = await db.query(
    `SELECT r.id, r.mission_id, r.started_at, r.quantity, r.price, r.total,
            r.is_preorder, r.release_date,
            p.name AS product_name, p.msrp, l.retailer,
            a.status AS vault_status
       FROM mission_runs r
       JOIN missions m ON m.id = r.mission_id
       JOIN listings l ON l.id = m.listing_id
       JOIN products p ON p.key = l.product_key
       LEFT JOIN acquisitions a ON a.mission_id = m.id AND a.user_id = $1
      WHERE m.user_id = $1 AND r.outcome = 'bought'
      ORDER BY r.started_at DESC
      LIMIT $2`,
    [userId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    runId: Number(r.id),
    missionId: Number(r.mission_id),
    productName: String(r.product_name ?? ''),
    retailer: String(r.retailer ?? ''),
    at: String(r.started_at),
    quantity: Number(r.quantity ?? 1),
    unitPrice: r.price === null || r.price === undefined ? null : Number(r.price),
    total: r.total === null || r.total === undefined ? null : Number(r.total),
    msrp: r.msrp === null || r.msrp === undefined ? null : Number(r.msrp),
    vaultStatus: r.vault_status ? String(r.vault_status) : null,
    isPreOrder: r.is_preorder === true,
    releaseDate: toDate(r.release_date),
  }));
}
