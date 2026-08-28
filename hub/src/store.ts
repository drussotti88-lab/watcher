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
  productKey: string;
  name: string;
  retailer: string;
  externalId: string;
  url: string;
  releaseDate: string | null;
}

export async function watchlist(db: Sql): Promise<WatchRow[]> {
  const rows = await db.query(
    `SELECT p.key, p.name, p.release_date, a.retailer, a.value AS external_id,
            COALESCE(MAX(d.url), '') AS url
       FROM products p
       JOIN aliases a ON a.product_key = p.key AND a.kind = 'retailer_sku'
       LEFT JOIN discoveries d ON d.product_key = p.key
      GROUP BY p.key, p.name, p.release_date, a.retailer, a.value
      ORDER BY p.name, a.retailer`,
  );
  return rows.map((r) => ({
    productKey: String(r.key),
    name: String(r.name ?? ''),
    retailer: String(r.retailer ?? ''),
    externalId: String(r.external_id ?? ''),
    url: String(r.url ?? ''),
    releaseDate: r.release_date ? String(r.release_date).slice(0, 10) : null,
  }));
}

// ─── What the Watcher saw ────────────────────────────────────────────────────

/** One reading of one product at one retailer, as the Watcher reports it. */
export interface ObservationIn {
  productKey: string;
  retailer: string;
  externalId?: string;
  url?: string;
  state: 'in' | 'out' | 'queue' | 'unknown';
  confidence?: 'exact' | 'inferred' | 'unknown';
  price?: number | null;
  sellerKind?: 'retailer' | 'marketplace' | 'unknown';
  sellerName?: string;
  availableQuantity?: number | null;
  orderLimit?: number | null;
  isPreOrder?: boolean;
  releaseDate?: string | null;
  note?: string;
}

export interface RecordedObservation {
  /** Did anything material change? Drives alerts and the history table. */
  changed: boolean;
  /** What it was before, when there was a before. */
  previousState: string | null;
  previousPrice: number | null;
  /** True the first time we ever see this watch. Not a change to shout about. */
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
 * turning the Watcher on for the first time announces every product at once,
 * which is the same mistake the discovery seeding logic exists to avoid.
 */
export async function recordObservation(
  db: Sql,
  obs: ObservationIn,
): Promise<RecordedObservation> {
  const prior = await db.query<{
    state: string;
    price: unknown;
    seller_kind: string;
  }>('SELECT state, price, seller_kind FROM watch_state WHERE product_key = $1 AND retailer = $2', [
    obs.productKey,
    obs.retailer,
  ]);

  const before = prior[0] ?? null;
  const isFirst = before === null;
  const previousPrice = before ? toPrice(before.price) : null;
  const price = obs.price ?? null;

  const changed =
    !isFirst &&
    (before.state !== obs.state ||
      previousPrice !== price ||
      before.seller_kind !== (obs.sellerKind ?? 'unknown'));

  await db.query(
    `INSERT INTO watch_state (
       product_key, retailer, external_id, url, state, confidence, price,
       seller_kind, seller_name, available_quantity, order_limit,
       is_preorder, release_date, note, last_checked_at, last_changed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now())
     ON CONFLICT (product_key, retailer) DO UPDATE SET
       external_id = EXCLUDED.external_id,
       url = EXCLUDED.url,
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
       last_changed_at = CASE WHEN $15 THEN now() ELSE watch_state.last_changed_at END`,
    [
      obs.productKey,
      obs.retailer,
      obs.externalId ?? '',
      obs.url ?? '',
      obs.state,
      obs.confidence ?? 'unknown',
      price,
      obs.sellerKind ?? 'unknown',
      obs.sellerName ?? '',
      obs.availableQuantity ?? null,
      obs.orderLimit ?? null,
      obs.isPreOrder ?? false,
      obs.releaseDate ?? null,
      (obs.note ?? '').slice(0, 500),
      changed,
    ],
  );

  if (changed || isFirst) {
    await db.query(
      `INSERT INTO observations
         (product_key, retailer, state, confidence, price, seller_kind,
          seller_name, available_quantity, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        obs.productKey,
        obs.retailer,
        obs.state,
        obs.confidence ?? 'unknown',
        price,
        obs.sellerKind ?? 'unknown',
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
  };
}

/** One row per watch, as the dashboard renders it. */
export interface WatchStateRow {
  productKey: string;
  productName: string;
  retailer: string;
  externalId: string;
  url: string;
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

/**
 * Everything being watched, whether or not it has ever been checked.
 *
 * A LEFT JOIN, deliberately. A watch the Watcher has never reached must appear
 * on the page as never-checked rather than not appear at all — a dashboard that
 * silently omits what it cannot see is how you find out in a week that one
 * retailer stopped working.
 */
export async function dashboard(db: Sql): Promise<WatchStateRow[]> {
  const rows = await db.query(
    `SELECT p.key, p.name AS product_name, a.retailer, a.value AS external_id,
            COALESCE(w.url, MAX(d.url), '') AS url,
            COALESCE(w.state, 'unchecked') AS state,
            COALESCE(w.confidence, 'unknown') AS confidence,
            w.price, COALESCE(w.seller_kind, 'unknown') AS seller_kind,
            COALESCE(w.seller_name, '') AS seller_name,
            w.available_quantity, w.order_limit,
            COALESCE(w.is_preorder, false) AS is_preorder,
            COALESCE(w.release_date, p.release_date) AS release_date,
            COALESCE(w.note, '') AS note,
            w.last_checked_at, w.last_changed_at
       FROM products p
       JOIN aliases a ON a.product_key = p.key AND a.kind = 'retailer_sku'
       LEFT JOIN watch_state w ON w.product_key = p.key AND w.retailer = a.retailer
       LEFT JOIN discoveries d ON d.product_key = p.key
      GROUP BY p.key, p.name, p.release_date, a.retailer, a.value, w.url, w.state,
               w.confidence, w.price, w.seller_kind, w.seller_name,
               w.available_quantity, w.order_limit, w.is_preorder, w.release_date,
               w.note, w.last_checked_at, w.last_changed_at
      ORDER BY
        CASE COALESCE(w.state, 'unchecked')
          WHEN 'in' THEN 0 WHEN 'queue' THEN 1 WHEN 'unknown' THEN 2
          WHEN 'unchecked' THEN 3 ELSE 4 END,
        p.name, a.retailer`,
  );

  return rows.map((r) => ({
    productKey: String(r.key),
    productName: String(r.product_name ?? ''),
    retailer: String(r.retailer ?? ''),
    externalId: String(r.external_id ?? ''),
    url: String(r.url ?? ''),
    state: String(r.state ?? 'unchecked'),
    confidence: String(r.confidence ?? 'unknown'),
    price: toPrice(r.price),
    sellerKind: String(r.seller_kind ?? 'unknown'),
    sellerName: String(r.seller_name ?? ''),
    availableQuantity: r.available_quantity === null ? null : Number(r.available_quantity),
    orderLimit: r.order_limit === null ? null : Number(r.order_limit),
    isPreOrder: r.is_preorder === true,
    releaseDate: r.release_date ? String(r.release_date).slice(0, 10) : null,
    note: String(r.note ?? ''),
    lastCheckedAt: r.last_checked_at ? new Date(String(r.last_checked_at)).toISOString() : '',
    lastChangedAt: r.last_changed_at ? new Date(String(r.last_changed_at)).toISOString() : '',
  }));
}

/** Recent changes, newest first. The "what happened" feed. */
export async function recentObservations(db: Sql, limit = 50): Promise<
  {
    productKey: string;
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
    `SELECT o.product_key, p.name AS product_name, o.retailer, o.state, o.price,
            o.seller_kind, o.seller_name, o.note, o.at
       FROM observations o
       JOIN products p ON p.key = o.product_key
      ORDER BY o.at DESC, o.id DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    productKey: String(r.product_key),
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
