/**
 * What every reader returns, whatever it had to do to get there.
 *
 * The three retailers each ended up needing a different strategy — Pokémon
 * Center publishes JSON-LD, Target only answers over its own API, Walmart puts
 * the whole product in embedded page state — so the value of a shared shape is
 * that the decision layer never has to know which.
 */
import type { StockState, Confidence } from '../types.ts';

/**
 * Who is actually selling this.
 *
 * Not decoration. The Walmart page for a Pokémon Elite Trainer Box reads
 * `IN_STOCK` at $73.76 — from `Rares Market L.L.C.`, a marketplace reseller,
 * against an MSRP around $50. A buyer that checks price and stock but not the
 * seller will cheerfully pay a scalper, at 3am, unattended. So the seller comes
 * back with every reading and the decision layer gets to refuse on it.
 */
export type SellerKind = 'retailer' | 'marketplace' | 'unknown';

export interface Seller {
  kind: SellerKind;
  name: string;
}

export interface PreOrder {
  isPreOrder: boolean;
  /** ISO date when known. This is the release date Half B needs. */
  releaseDate: string | null;
}

export interface ProductRead {
  name: string;
  price: number | null;
  state: StockState;
  confidence: Confidence;
  /** How many the retailer says it can ship. null when not stated. */
  availableQuantity: number | null;
  /** Most the retailer will sell in one order. null when not stated. */
  orderLimit: number | null;
  /** Available for store pickup, which is not the same as shippable. */
  pickupAvailable: boolean;
  seller: Seller;
  preOrder: PreOrder;
  note: string;
}

/** A reading that commits to nothing. Every reader's failure case. */
export function unknownRead(note: string, name = ''): ProductRead {
  return {
    name,
    price: null,
    state: 'unknown',
    confidence: 'unknown',
    availableQuantity: null,
    orderLimit: null,
    pickupAvailable: false,
    seller: { kind: 'unknown', name: '' },
    preOrder: { isPreOrder: false, releaseDate: null },
    note,
  };
}

/** Pokémon Center and Target sell their own stock; there is no marketplace. */
export function firstParty(name: string): Seller {
  return { kind: 'retailer', name };
}
