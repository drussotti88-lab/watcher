/** Shared shapes. Deliberately small — step 1 only needs discovery. */

/** One product a source told us about. Parsers return these and nothing else. */
export interface Discovered {
  /** The retailer's own stable id, or a slug when that's all we get. */
  externalId: string;
  name: string;
  url: string;
  price?: number | null;
  /**
   * What the sweep thought it was — 'elite trainer box', 'booster box'. Blank
   * when it could not tell, which is not the same as it being nothing.
   */
  kind?: string;
  /** 'sealed' when the sweep was confident, 'unsure' when it wants a person. */
  confidence?: string;
  /** The query that turned it up, so a keyword that only returns rubbish shows. */
  foundBy?: string;
  /** The retailer's own product photo, at thumbnail size. */
  imageUrl?: string;

  // ── What it is, beyond a name and a price ──────────────────────────────────
  //
  // Keeping or forgetting is a judgement, and the card was asking for one while
  // withholding most of what the sweep already knew.

  /** Which shop. Denormalised from the source so the review list stays one query. */
  retailer?: string;
  /** 'in' | 'out' | 'unknown' at the moment the sweep looked. */
  state?: string;
  /**
   * A pre-order takes the money now and ships whenever the publisher says, so
   * it is a different decision from a restock, not a variety of one.
   */
  isPreOrder?: boolean;
  /** The publisher's street date, when the retailer publishes one. */
  releaseDate?: string | null;
  /** Per-customer cap, when the retailer states it. */
  orderLimit?: number | null;
  /**
   * What the shop said was available when the sweep looked.
   *
   * Carried for one reason above all: a count sitting on a listing the shop is
   * NOT selling is staged stock, the earliest warning of a drop this system
   * can get — and a find nobody is watching yet is where that warning is worth
   * the most. Null means the retailer did not say, which is not zero.
   */
  availableQuantity?: number | null;
  /**
   * Other sellers with an offer on the same listing.
   *
   * Walmart's own listing being out of stock does not make the page empty — the
   * buy box falls to a marketplace seller, often at many times the price. The
   * find is still right; the surprise on clicking through is what needs saying.
   */
  otherOffers?: number | null;
  /**
   * Why the sweep surfaced it: 'buyable', 'scheduled', 'recent'.
   *
   * Distinct from foundBy, which is the *query*. Pokémon Center is walked
   * rather than searched and has no query, so its rows were writing the signal
   * into foundBy and the card read `found by "recent"` — true, and useless.
   */
  signal?: string;
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
  /** A sweep was asked for by hand and has not run yet. */
  sweepNowAt: string | null;
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
  /**
   * Where confirmed orders go. A separate channel, because a win is not an
   * alert: alerts are for people racing to buy, and the wins channel is the
   * Wins page, mirrored — the record of what this actually did. Falls back
   * to the main webhook when unset, so a win is never lost to configuration.
   */
  DISCORD_WINS_WEBHOOK_URL?: string;
  /** Bearer token Phantom presents when posting findings. */
  INGEST_TOKEN?: string;
  /** Password for the web page, and the key its session cookie is signed with. */
  APP_PASSWORD?: string;
  /** The vault link (DNA Card Vault): shared HMAC secret, identical in both apps. */
  PHANTOM_SHARED_SECRET?: string;
  /** Where the vault lives, e.g. https://www.dnacardvault.com — no trailing slash. */
  VAULT_URL?: string;
  /**
   * The owner's vault account id. The owner signs in by password (user 1,
   * no vault link), so his sends need the target account named in config.
   */
  VAULT_OWNER_USER_ID?: string;
}
