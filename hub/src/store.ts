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
