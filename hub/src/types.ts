/** Shared shapes. Deliberately small — step 1 only needs discovery. */

/** One product a source told us about. Parsers return these and nothing else. */
export interface Discovered {
  /** The retailer's own stable id, or a slug when that's all we get. */
  externalId: string;
  name: string;
  url: string;
  price?: number | null;
}

export type SourceKind = 'sitemap_index' | 'sitemap' | 'json_list' | 'watcher';
export type SourceVia = 'hub' | 'watcher';

export interface SourceConfig {
  /** Case-insensitive substrings; a product must match at least one. */
  filters?: string[];
  /** For sitemap_index: how many child sitemaps to walk per sweep. */
  childLimit?: number;
  /** For json_list: dotted path to the array, e.g. "data.search.products". */
  itemsPath?: string;
  /** For json_list: field names within each item. */
  idField?: string;
  nameField?: string;
  urlField?: string;
  priceField?: string;
  /** Extra request headers (an API key header, say). */
  headers?: Record<string, string>;
}

/**
 * A source, as the rest of the Hub sees it.
 *
 * Note what is NOT here: snake_case column names and 0/1 flags. store.ts
 * normalises rows on the way out, so nothing above it ever writes
 * `seeded === 1` — a comparison that was quietly true in SQLite and quietly
 * false the moment the column became a real Postgres boolean.
 */
export interface SourceRow {
  id: string;
  label: string;
  retailer: string;
  kind: SourceKind;
  url: string;
  via: SourceVia;
  config: SourceConfig;
  enabled: boolean;
  seeded: boolean;
  cursor: number;
  lastSweptAt: string | null;
  lastStatus: string;
  lastCount: number;
}

/** What a sweep did. Returned so the caller can log and alert. */
export interface SweepResult {
  sourceId: string;
  label: string;
  ok: boolean;
  seen: number;
  fresh: Discovered[];
  seeded: boolean;
  error?: string;
}

/** Everything the Hub reads from the environment. */
export interface Env {
  DATABASE_URL: string;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_OPS_WEBHOOK_URL?: string;
  /** Bearer token the Watcher presents when posting findings. */
  INGEST_TOKEN?: string;
  /** Password for the web page, and the key its session cookie is signed with. */
  APP_PASSWORD?: string;
}
