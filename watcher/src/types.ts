/** Shared shapes for the Watcher. */

export type Retailer = 'pokemoncenter' | 'target' | 'walmart';

export type StockState = 'in' | 'out' | 'queue' | 'unknown';

/** How sure the reader is. Drives whether we'd act on it. */
export type Confidence = 'exact' | 'inferred' | 'unknown';

/** One reading of one product page. Readers return this and nothing else. */
export interface Observation {
  retailer: Retailer;
  externalId: string;
  url: string;
  name: string;
  state: StockState;
  confidence: Confidence;
  /** Price as displayed, in dollars. null when not shown. */
  price: number | null;
  /** True when the page is a bot challenge / waiting room rather than a product. */
  challenged: boolean;
  seenAt: string;
  note?: string;
}

/** A product the Hub wants watched, with its spending mandate. */
export interface Watch {
  id: string;
  retailer: Retailer;
  externalId: string;
  url: string;
  name: string;
  /** Armed means: buying is pre-authorised, within these limits. */
  armed: boolean;
  /** Never pay more than this per unit. Required when armed. */
  ceiling: number | null;
  /** How many to buy. Required when armed. */
  quantity: number;
}

export type Outcome =
  | 'bought'
  | 'sold_out'
  | 'price_exceeded'
  | 'qty_unavailable'
  | 'blocked'
  | 'duplicate_prevented'
  | 'budget_exceeded'
  /** Shipping alone broke the account-wide allowance. Its own outcome, because
   *  "the item was too expensive" and "the postage was" have different fixes. */
  | 'shipping_exceeded'
  | 'not_authorised'
  | 'dry_run'
  | 'failed';

/** What actually happened when we tried to act. Reported to the Hub. */
export interface AttemptRecord {
  watchId: string;
  retailer: Retailer;
  externalId: string;
  outcome: Outcome;
  /** What we would have paid / did pay, per unit. */
  unitPrice: number | null;
  quantity: number;
  total: number | null;
  at: string;
  note: string;
}

export interface ProbeResult {
  retailer: Retailer;
  url: string;
  reachable: boolean;
  challenged: boolean;
  status: number | null;
  ms: number;
  title: string;
  verdict: string;
}
