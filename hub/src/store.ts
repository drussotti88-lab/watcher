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
    text: `INSERT INTO discoveries
             (user_id, source_id, external_id, url, name, price, announced, kind, confidence, found_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (user_id, source_id, external_id) DO NOTHING`,
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
             ON CONFLICT (user_id, key) DO NOTHING`,
      params: [userId, key, item.name],
    },
    {
      text: `INSERT INTO aliases (user_id, product_key, kind, retailer, value)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, kind, retailer, value) DO NOTHING`,
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
): Promise<void> {
  await db.query(
    `UPDATE sources
        SET last_swept_at = now(), last_status = $1, last_count = $2,
            seeded = $3, cursor = $4
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

export async function watchlist(db: Sql, userId: number): Promise<WatchRow[]> {
  const rows = await db.query(
    `SELECT l.id, l.product_key, p.name, p.release_date, l.retailer, l.external_id, l.url
       FROM listings l
       JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
      WHERE l.user_id = $1
      ORDER BY p.name, l.retailer`,
    [userId],
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

export async function listProducts(db: Sql, userId: number): Promise<ProductRow[]> {
  const rows = await db.query('SELECT * FROM products WHERE user_id = $1 ORDER BY name', [userId]);
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
     ON CONFLICT (user_id, key) DO UPDATE SET
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

export async function deleteProduct(db: Sql, userId: number, key: string): Promise<void> {
  // Listings, missions, runs and observations all cascade from here.
  await db.query('DELETE FROM products WHERE user_id = $1 AND key = $2', [userId, key]);
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
       JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
      WHERE l.user_id = $1 AND l.retailer = $2 AND l.external_id = $3`,
    [userId, retailer.trim(), externalId.trim()],
  );
  return rows[0] ? toListing(rows[0]) : null;
}

export async function listListings(
  db: Sql,
  userId: number,
  productKey?: string,
): Promise<ListingRow[]> {
  const sql = `SELECT l.*, p.name AS product_name FROM listings l
                 JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
                WHERE l.user_id = $1${productKey ? ' AND l.product_key = $2' : ''}
                ORDER BY p.name, l.retailer`;
  const rows = productKey
    ? await db.query(sql, [userId, productKey])
    : await db.query(sql, [userId]);
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
     -- Per owner: two people must both be able to watch the same tcin.
     ON CONFLICT (user_id, retailer, external_id) DO UPDATE SET
       url = EXCLUDED.url,
       product_key = EXCLUDED.product_key
     RETURNING *`,
    [userId, l.productKey, l.retailer.trim(), l.externalId.trim(), l.url.trim()],
  );
  const [full] = await db.query(
    `SELECT l.*, p.name AS product_name FROM listings l
       JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
      WHERE l.user_id = $1 AND l.id = $2`,
    [userId, rows[0]!.id],
  );
  return toListing(full!);
}

export async function deleteListing(db: Sql, userId: number, id: number): Promise<void> {
  await db.query('DELETE FROM listings WHERE user_id = $1 AND id = $2', [userId, id]);
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

// ── Who is asking ────────────────────────────────────────────────────────────

/** How many users exist. Used by /health to prove the database answers. */
export async function countUsers(db: Sql): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

/**
 * Whose Watcher presents this token?
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
   * When the Watcher is allowed to look, as HH:MM in `timezone`.
   *
   * Target runs its scheduled drops in the small hours, so polling all day is
   * mostly traffic spent on a page that will not change — and traffic is the
   * one thing that earns a challenge and takes the Watcher off the air at the
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
}

export const DEFAULT_SETTINGS: Settings = {
  taxRate: 0,
  shippingAllowance: 0,
  activeFrom: '',
  activeUntil: '',
  timezone: '',
  paused: false,
};

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
  ] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    statements.push({
      text: `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      params: [userId, key, String(value)],
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
    JOIN listings l ON l.user_id = m.user_id AND l.id = m.listing_id
    JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
    LEFT JOIN watch_state w ON w.user_id = l.user_id AND w.listing_id = l.id
   WHERE m.user_id = $1`;

/**
 * Every mission, in the order you care about them.
 *
 * In stock first, because that is the thing you opened the page to see. A
 * LEFT JOIN on watch_state, so a mission the Watcher has never reached still
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

/** Missions the Watcher should be polling right now. */
/**
 * Ask for a mission to be checked on the next pass, whatever its schedule says.
 *
 * This is the "Test run" button. It cannot make a check happen — the Watcher
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

export async function activeMissions(db: Sql, userId: number): Promise<MissionRow[]> {
  const rows = await db.query(`${MISSION_SELECT} AND m.enabled = true ORDER BY m.id`, [userId]);
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

export async function upsertMission(
  db: Sql,
  userId: number,
  m: MissionInput,
): Promise<MissionRow> {
  const problem = validateMission(m);
  if (problem) throw new Error(problem);

  // The listing has to be this user's. Without this check a crafted listingId
  // would attach a mission to somebody else's listing — and a mission is the
  // thing that spends money.
  const owns = await db.query<{ id: number }>(
    'SELECT id FROM listings WHERE user_id = $1 AND id = $2',
    [userId, m.listingId],
  );
  if (!owns.length) throw new Error('that listing does not belong to you');

  const rows = await db.query(
    `INSERT INTO missions (user_id, listing_id, label, enabled, armed, ceiling, quantity,
                           seller_policy, check_every_s, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
      userId,
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
  const mission = await getMission(db, userId, Number(rows[0]!.id));
  if (!mission) throw new Error('mission vanished immediately after being written');
  return mission;
}

export async function deleteMission(db: Sql, userId: number, id: number): Promise<void> {
  await db.query('DELETE FROM missions WHERE user_id = $1 AND id = $2', [userId, id]);
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
      WHERE user_id = $9 AND id = $10`,
    [
      r.outcome,
      reason.slice(0, 500),
      r.state ?? '',
      r.price ?? null,
      r.sellerKind ?? '',
      r.sellerName ?? '',
      r.quantity ?? null,
      r.total ?? null,
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
    JOIN listings l ON l.user_id = m.user_id AND l.id = m.listing_id
    JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
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

// ─── What the Watcher saw ────────────────────────────────────────────────────

/** One reading of one listing, as the Watcher reports it. */
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
  userId: number,
  obs: ObservationIn,
): Promise<RecordedObservation> {
  // A reading names a listing by id, and that id arrives over the wire from a
  // Watcher. If it is not this user's listing, nothing here may touch it —
  // otherwise one person's Watcher could rewrite another person's stock and
  // price, which is the reading an armed mission acts on.
  const owns = await db.query<{ id: number }>(
    'SELECT id FROM listings WHERE user_id = $1 AND id = $2',
    [userId, obs.listingId],
  );
  if (!owns.length) throw new Error('that listing does not belong to you');

  const prior = await db.query<{
    state: string;
    price: unknown;
    seller_kind: string;
    available_quantity: unknown;
  }>(
    `SELECT state, price, seller_kind, available_quantity
       FROM watch_state WHERE user_id = $1 AND listing_id = $2`,
    [userId, obs.listingId],
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
  // Watcher actually looked.
  await db.query(
    `UPDATE missions SET check_now_at = NULL
      WHERE user_id = $1 AND listing_id = $2 AND check_now_at IS NOT NULL`,
    [userId, obs.listingId],
  );

  // The listing remembers who was selling it, so a mission's seller policy has
  // something to read even before the next check.
  if (sellerKind !== 'unknown') {
    await db.query(
      'UPDATE listings SET seller_kind = $1, seller_name = $2 WHERE user_id = $3 AND id = $4',
      [sellerKind, obs.sellerName ?? '', userId, obs.listingId],
    );
  }

  // The page knows the product's name better than its own URL does. Replace a
  // guess with it, once, and never touch a name a person typed.
  const realName = (obs.productName ?? '').trim();
  if (realName && realName.length <= 200) {
    await db.query(
      `UPDATE products SET name = $1, name_is_guess = false
        WHERE user_id = $2
          AND key = (SELECT product_key FROM listings WHERE user_id = $2 AND id = $3)
          AND name_is_guess = true`,
      [realName, userId, obs.listingId],
    );
  }

  // An image is worth having the first time we see one, and never worth
  // overwriting — the retailer's CDN URLs churn and a working one beats a new one.
  if (obs.imageUrl) {
    await db.query(
      `UPDATE products SET image_url = $1
        WHERE user_id = $2 AND image_url = ''
          AND key = (SELECT product_key FROM listings WHERE user_id = $2 AND id = $3)`,
      [obs.imageUrl, userId, obs.listingId],
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

  return { changed, isFirst, previousState: before?.state ?? null, previousPrice };
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
       JOIN listings l ON l.user_id = o.user_id AND l.id = o.listing_id
       JOIN products p ON p.user_id = l.user_id AND p.key = l.product_key
      WHERE o.user_id = $1
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
  /** When it happened on the Watcher's clock, not when it arrived here. */
  at?: string;
  kind: 'check' | 'pass' | 'hub' | 'browser' | 'startup';
  level?: 'info' | 'warn' | 'error';
  retailer?: string;
  missionId?: number | null;
  listingId?: number | null;
  state?: string;
  price?: number | null;
  ms?: number | null;
  /** What the retailer said was available. Null means it did not say. */
  availableQuantity?: number | null;
  /** Already scrubbed on the Watcher's machine. Scrubbed again on the way out. */
  message: string;
  detail?: string;
}

export interface ActivityRow extends Required<Omit<ActivityIn, 'at'>> {
  id: number;
  at: string;
}

const LEVELS = new Set(['info', 'warn', 'error']);
const KINDS = new Set(['check', 'pass', 'hub', 'browser', 'startup']);

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
  status: string;
  firstSeenAt: string;
  /** True when a product with this name already exists — usually already yours. */
  alreadyHave: boolean;
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
    status: String(r.status ?? 'new'),
    firstSeenAt: r.first_seen_at ? new Date(String(r.first_seen_at)).toISOString() : '',
    alreadyHave: Boolean(r.already_have),
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
              SELECT 1 FROM listings l
               WHERE l.user_id = d.user_id AND l.external_id = d.external_id
            ) AS already_have
       FROM discoveries d
      WHERE d.user_id = $1 AND d.status = 'new'
      ORDER BY d.first_seen_at DESC, d.id DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(toDiscovery);
}

export async function getDiscovery(
  db: Sql,
  userId: number,
  id: number,
): Promise<DiscoveryRow | null> {
  const rows = await db.query(
    `SELECT *, false AS already_have FROM discoveries WHERE user_id = $1 AND id = $2`,
    [userId, id],
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
  const rows = await db.query<{ id: number }>(
    `UPDATE discoveries SET status = 'forgotten', decided_at = now()
      WHERE user_id = $1 AND id = $2 AND status = 'new'
      RETURNING id`,
    [userId, id],
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
): Promise<{ productKey: string; listingId: number }> {
  const found = await getDiscovery(db, userId, id);
  if (!found) throw new Error('no such discovery');
  if (found.status !== 'new') throw new Error(`this one was already ${found.status}`);

  const source = await getSource(db, userId, found.sourceId);
  const retailer = source?.retailer ?? 'Target';

  const product = await upsertProduct(db, userId, {
    name: found.name,
    msrp: found.price ?? null,
  });
  const listing = await addListing(db, userId, {
    productKey: product.key,
    retailer,
    externalId: found.externalId,
    url: found.url,
  });

  await db.query(
    `UPDATE discoveries SET status = 'kept', decided_at = now(), product_key = $3
      WHERE user_id = $1 AND id = $2`,
    [userId, id, product.key],
  );
  return { productKey: product.key, listingId: listing.id };
}
