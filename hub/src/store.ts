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
    lastStatus: String(row.last_status ?? ''),
    lastCount: Number(row.last_count ?? 0),
  };
}

export async function listSources(db: Sql, via?: string): Promise<SourceRow[]> {
  const rows = via
    ? await db.query('SELECT * FROM sources WHERE enabled = true AND via = $1 ORDER BY id', [via])
    : await db.query('SELECT * FROM sources WHERE enabled = true ORDER BY id');
  return rows.map(toSource);
}

/** Every source, enabled or not. For diagnostics, which must hide nothing. */
export async function listAllSources(db: Sql): Promise<SourceRow[]> {
  const rows = await db.query('SELECT * FROM sources ORDER BY retailer, id');
  return rows.map(toSource);
}

export async function getSource(db: Sql, id: string): Promise<SourceRow | null> {
  const rows = await db.query('SELECT * FROM sources WHERE id = $1', [id]);
  return rows[0] ? toSource(rows[0]) : null;
}

/** Which of these external ids do we already know about for this source? */
export async function knownIds(db: Sql, sourceId: string): Promise<Set<string>> {
  const rows = await db.query<{ external_id: string }>(
    'SELECT external_id FROM discoveries WHERE source_id = $1',
    [sourceId],
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
  sourceId: string,
  items: Discovered[],
  announce: boolean,
): Promise<Discovered[]> {
  if (items.length === 0) return [];

  const statements: Statement[] = items.map((item) => ({
    text: `INSERT INTO discoveries (source_id, external_id, url, name, price, announced)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source_id, external_id) DO NOTHING`,
    params: [sourceId, item.externalId, item.url, item.name, item.price ?? null, !announce],
  }));
  await db.batch(statements);
  return announce ? items : [];
}

export async function markAnnounced(
  db: Sql,
  sourceId: string,
  externalIds: string[],
): Promise<void> {
  if (externalIds.length === 0) return;
  await db.query(
    'UPDATE discoveries SET announced = true WHERE source_id = $1 AND external_id = ANY($2)',
    [sourceId, externalIds],
  );
}

/** Discoveries a source has seen but not yet announced. */
export async function pendingDiscoveries(db: Sql, sourceId: string): Promise<Discovered[]> {
  const rows = await db.query(
    `SELECT external_id, name, url, price FROM discoveries
      WHERE source_id = $1 AND announced = false ORDER BY id`,
    [sourceId],
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
  sourceId: string,
  retailer: string,
  item: Discovered,
): Promise<string> {
  const existing = await db.query<{ product_key: string }>(
    'SELECT product_key FROM aliases WHERE kind = $1 AND retailer = $2 AND value = $3',
    ['retailer_sku', retailer, item.externalId],
  );
  if (existing[0]?.product_key) return existing[0].product_key;

  const key = productKey(item.name, item.externalId);
  await db.batch([
    {
      text: 'INSERT INTO products (key, name) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      params: [key, item.name],
    },
    {
      text: `INSERT INTO aliases (product_key, kind, retailer, value) VALUES ($1, $2, $3, $4)
             ON CONFLICT (kind, retailer, value) DO NOTHING`,
      params: [key, 'retailer_sku', retailer, item.externalId],
    },
    {
      text: 'UPDATE discoveries SET product_key = $1 WHERE source_id = $2 AND external_id = $3',
      params: [key, sourceId, item.externalId],
    },
  ]);
  return key;
}

export async function finishSweep(
  db: Sql,
  sourceId: string,
  status: string,
  count: number,
  seeded: boolean,
  cursor = 0,
): Promise<void> {
  await db.query(
    `UPDATE sources
        SET last_swept_at = now(), last_status = $1, last_count = $2,
            seeded = $3, cursor = $4
      WHERE id = $5`,
    [status.slice(0, 300), count, seeded, cursor, sourceId],
  );
}

export async function logEvent(
  db: Sql,
  kind: string,
  message: string,
  data: unknown = null,
): Promise<void> {
  await db.query('INSERT INTO events (kind, message, data) VALUES ($1, $2, $3)', [
    kind,
    message.slice(0, 1000),
    data === null || data === undefined ? null : JSON.stringify(data).slice(0, 4000),
  ]);
}

/**
 * What the Watcher should be looking at.
 *
 * Everything with a retailer alias and a URL we can reach. The Watcher pulls
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

export async function watchlist(db: Sql): Promise<WatchRow[]> {
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

export async function listProducts(db: Sql): Promise<ProductRow[]> {
  const rows = await db.query('SELECT * FROM products ORDER BY name');
  return rows.map(toProduct);
}

export interface ProductInput {
  key?: string;
  name: string;
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

export async function upsertProduct(db: Sql, p: ProductInput): Promise<ProductRow> {
  const problem = validateProduct(p);
  if (problem) throw new Error(problem);

  const key = p.key?.trim() || keyForName(p.name);
  const rows = await db.query(
    `INSERT INTO products (key, name, release_date, msrp, image_url, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key) DO UPDATE SET
       name = EXCLUDED.name,
       -- COALESCE, not EXCLUDED: an edit that omits a field must not blank a
       -- value someone already took the trouble to set.
       release_date = COALESCE(EXCLUDED.release_date, products.release_date),
       msrp = COALESCE(EXCLUDED.msrp, products.msrp),
       image_url = CASE WHEN EXCLUDED.image_url = '' THEN products.image_url ELSE EXCLUDED.image_url END,
       notes = CASE WHEN EXCLUDED.notes = '' THEN products.notes ELSE EXCLUDED.notes END
     RETURNING *`,
    [key, p.name.trim(), p.releaseDate || null, p.msrp ?? null, p.imageUrl ?? '', p.notes ?? ''],
  );
  return toProduct(rows[0]!);
}

/** Only ever set an image we actually read off a page; never blank an existing one. */
export async function setProductImage(db: Sql, key: string, imageUrl: string): Promise<void> {
  if (!imageUrl) return;
  await db.query("UPDATE products SET image_url = $1 WHERE key = $2 AND image_url = ''", [
    imageUrl,
    key,
  ]);
}

export async function deleteProduct(db: Sql, key: string): Promise<void> {
  // Listings, missions, runs and observations all cascade from here.
  await db.query('DELETE FROM products WHERE key = $1', [key]);
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

export async function listListings(db: Sql, productKey?: string): Promise<ListingRow[]> {
  const sql = `SELECT l.*, p.name AS product_name FROM listings l
                 JOIN products p ON p.key = l.product_key
                ${productKey ? 'WHERE l.product_key = $1' : ''}
                ORDER BY p.name, l.retailer`;
  const rows = productKey ? await db.query(sql, [productKey]) : await db.query(sql);
  return rows.map(toListing);
}

export async function addListing(
  db: Sql,
  l: { productKey: string; retailer: string; externalId: string; url: string },
): Promise<ListingRow> {
  const rows = await db.query(
    `INSERT INTO listings (product_key, retailer, external_id, url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (retailer, external_id) DO UPDATE SET
       url = EXCLUDED.url,
       product_key = EXCLUDED.product_key
     RETURNING *`,
    [l.productKey, l.retailer.trim(), l.externalId.trim(), l.url.trim()],
  );
  const [full] = await db.query(
    'SELECT l.*, p.name AS product_name FROM listings l JOIN products p ON p.key = l.product_key WHERE l.id = $1',
    [rows[0]!.id],
  );
  return toListing(full!);
}

export async function deleteListing(db: Sql, id: number): Promise<void> {
  await db.query('DELETE FROM listings WHERE id = $1', [id]);
}

// ─── Missions ────────────────────────────────────────────────────────────────

export type SellerPolicy = 'retailer_only' | 'any';

export interface MissionInput {
  listingId: number;
  label?: string;
  enabled?: boolean;
  armed?: boolean;
  ceiling?: number | null;
  quantity?: number;
  sellerPolicy?: SellerPolicy;
  checkEverySeconds?: number;
  notes?: string;
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
  ceiling: number | null;
  quantity: number;
  sellerPolicy: SellerPolicy;
  checkEverySeconds: number;
  /** A "test run" is pending: check this one next pass, whatever its schedule. */
  checkNow: boolean;
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
    ceiling: toPrice(r.ceiling),
    quantity: Number(r.quantity ?? 1),
    sellerPolicy: (String(r.seller_policy ?? 'retailer_only') as SellerPolicy),
    checkEverySeconds: Number(r.check_every_s ?? 60),
    checkNow: r.check_now_at !== null && r.check_now_at !== undefined,
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
    LEFT JOIN watch_state w ON w.listing_id = l.id`;

/**
 * Every mission, in the order you care about them.
 *
 * In stock first, because that is the thing you opened the page to see. A
 * LEFT JOIN on watch_state, so a mission the Watcher has never reached still
 * appears — marked unchecked rather than quietly missing.
 */
export async function listMissions(db: Sql): Promise<MissionRow[]> {
  const rows = await db.query(`${MISSION_SELECT}
    ORDER BY
      CASE COALESCE(w.state, 'unchecked')
        WHEN 'in' THEN 0 WHEN 'queue' THEN 1 WHEN 'unknown' THEN 2
        WHEN 'unchecked' THEN 3 ELSE 4 END,
      m.armed DESC, p.name, l.retailer`);
  return rows.map(toMission);
}

/** The mission watching this listing, if there is one. At most one, by schema. */
export async function missionForListing(db: Sql, listingId: number): Promise<MissionRow | null> {
  const rows = await db.query(`${MISSION_SELECT} WHERE m.listing_id = $1`, [listingId]);
  return rows[0] ? toMission(rows[0]) : null;
}

export async function getMission(db: Sql, id: number): Promise<MissionRow | null> {
  const rows = await db.query(`${MISSION_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? toMission(rows[0]) : null;
}

/** Missions the Watcher should be polling right now. */
/**
 * Ask for a mission to be checked on the next pass, whatever its schedule says.
 *
 * This is the "Test run" button. It cannot make a check happen — the Watcher
 * owns the browser and the retailer owns the budget — so it records a request
 * and lets the next pass honour it. Saying "checking now" and meaning "queued"
 * would be the same species of lie as a $30 ceiling that accepts $45.
 */
export async function requestCheckNow(db: Sql, id: number): Promise<boolean> {
  const rows = await db.query<{ id: number }>(
    'UPDATE missions SET check_now_at = now() WHERE id = $1 RETURNING id',
    [id],
  );
  return rows.length > 0;
}

export async function activeMissions(db: Sql): Promise<MissionRow[]> {
  const rows = await db.query(`${MISSION_SELECT} WHERE m.enabled = true ORDER BY m.id`);
  return rows.map(toMission);
}

/**
 * Refuse to arm a mission that has not been told what it may spend.
 *
 * `armed` with no ceiling is an open cheque. The Watcher's decision layer
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
  if (m.sellerPolicy && !['retailer_only', 'any'].includes(m.sellerPolicy)) {
    return 'seller policy must be retailer_only or any';
  }
  const every = m.checkEverySeconds ?? 60;
  if (!Number.isInteger(every) || every < 30 || every > 86_400) {
    return 'check interval must be between 30 seconds and a day';
  }
  return null;
}

export async function upsertMission(db: Sql, m: MissionInput): Promise<MissionRow> {
  const problem = validateMission(m);
  if (problem) throw new Error(problem);

  const rows = await db.query(
    `INSERT INTO missions (listing_id, label, enabled, armed, ceiling, quantity,
                           seller_policy, check_every_s, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (listing_id) DO UPDATE SET
       label = EXCLUDED.label,
       enabled = EXCLUDED.enabled,
       armed = EXCLUDED.armed,
       ceiling = EXCLUDED.ceiling,
       quantity = EXCLUDED.quantity,
       seller_policy = EXCLUDED.seller_policy,
       check_every_s = EXCLUDED.check_every_s,
       notes = EXCLUDED.notes
     RETURNING id`,
    [
      m.listingId,
      m.label ?? '',
      m.enabled ?? true,
      m.armed ?? false,
      m.ceiling ?? null,
      m.quantity ?? 1,
      m.sellerPolicy ?? 'retailer_only',
      m.checkEverySeconds ?? 60,
      m.notes ?? '',
    ],
  );
  const mission = await getMission(db, Number(rows[0]!.id));
  if (!mission) throw new Error('mission vanished immediately after being written');
  return mission;
}

export async function deleteMission(db: Sql, id: number): Promise<void> {
  await db.query('DELETE FROM missions WHERE id = $1', [id]);
}

// ─── Mission runs ────────────────────────────────────────────────────────────

export type RunOutcome = 'running' | 'in_stock' | 'bought' | 'declined' | 'failed' | 'blocked';

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
export async function startRun(db: Sql, missionId: number): Promise<number> {
  const rows = await db.query('INSERT INTO mission_runs (mission_id) VALUES ($1) RETURNING id', [
    missionId,
  ]);
  return Number(rows[0]!.id);
}

export async function finishRun(
  db: Sql,
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
            ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
      WHERE id = $9`,
    [
      r.outcome,
      reason.slice(0, 500),
      r.state ?? '',
      r.price ?? null,
      r.sellerKind ?? '',
      r.sellerName ?? '',
      r.quantity ?? null,
      r.total ?? null,
      runId,
    ],
  );
}

/** Record a run that is already over. The common case. */
export async function recordRun(
  db: Sql,
  missionId: number,
  r: Parameters<typeof finishRun>[2],
): Promise<number> {
  const id = await startRun(db, missionId);
  await finishRun(db, id, r);
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
    JOIN missions m ON m.id = r.mission_id
    JOIN listings l ON l.id = m.listing_id
    JOIN products p ON p.key = l.product_key`;

export async function missionRuns(db: Sql, missionId: number, limit = 100): Promise<RunRow[]> {
  const rows = await db.query(
    `${RUN_SELECT} WHERE r.mission_id = $1 ORDER BY r.started_at DESC, r.id DESC LIMIT $2`,
    [missionId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(toRun);
}

export async function recentRuns(db: Sql, limit = 50): Promise<RunRow[]> {
  const rows = await db.query(
    `${RUN_SELECT} ORDER BY r.started_at DESC, r.id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toRun);
}

// ─── What the Watcher saw ────────────────────────────────────────────────────

/** One reading of one listing, as the Watcher reports it. */
export interface ObservationIn {
  listingId: number;
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

export interface RecordedObservation {
  /** Did anything material change? Drives runs and alerts. */
  changed: boolean;
  previousState: string | null;
  previousPrice: number | null;
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
 * turning the Watcher on announces every product at once, which is the same
 * mistake the discovery seeding logic exists to avoid.
 */
export async function recordObservation(
  db: Sql,
  obs: ObservationIn,
): Promise<RecordedObservation> {
  const prior = await db.query<{ state: string; price: unknown; seller_kind: string }>(
    'SELECT state, price, seller_kind FROM watch_state WHERE listing_id = $1',
    [obs.listingId],
  );

  const before = prior[0] ?? null;
  const isFirst = before === null;
  const previousPrice = before ? toPrice(before.price) : null;
  const price = obs.price ?? null;
  const sellerKind = obs.sellerKind ?? 'unknown';

  const changed =
    !isFirst &&
    (before.state !== obs.state ||
      previousPrice !== price ||
      before.seller_kind !== sellerKind);

  await db.query(
    `INSERT INTO watch_state (
       listing_id, state, confidence, price, seller_kind, seller_name,
       available_quantity, order_limit, is_preorder, release_date, note,
       last_checked_at, last_changed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
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
       last_changed_at = CASE WHEN $12 THEN now() ELSE watch_state.last_changed_at END`,
    [
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
  // Watcher actually looked.
  await db.query(
    'UPDATE missions SET check_now_at = NULL WHERE listing_id = $1 AND check_now_at IS NOT NULL',
    [obs.listingId],
  );

  // The listing remembers who was selling it, so a mission's seller policy has
  // something to read even before the next check.
  if (sellerKind !== 'unknown') {
    await db.query('UPDATE listings SET seller_kind = $1, seller_name = $2 WHERE id = $3', [
      sellerKind,
      obs.sellerName ?? '',
      obs.listingId,
    ]);
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
         (listing_id, state, confidence, price, seller_kind, seller_name,
          available_quantity, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
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

  return { changed, isFirst, previousState: before?.state ?? null, previousPrice };
}

/** Recent readings that actually changed. The "what happened" feed. */
export async function recentObservations(db: Sql, limit = 50): Promise<
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
      ORDER BY o.at DESC, o.id DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
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
