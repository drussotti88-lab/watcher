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
  /**
   * Can this be put in a basket right now?
   *
   * In stock and buyable are different questions, and during a drop they give
   * different answers. At 8:00pm on 2 Sep 2026 Walmart's own node said
   * `availabilityStatusV2: IN_STOCK`, `sellerName: Walmart.com` and
   * `canAddToCart: false` in the same breath — the item was real, Walmart's
   * own, and behind a waiting room. A competing tracker alerted "In Stock" on
   * that data and sent a room full of people to a page they could not buy
   * from.
   *
   * `null` means the retailer did not say, which is not the same as "no" and
   * must never be treated as one. Only Walmart states it today.
   */
  addToCart: boolean | null;
  preOrder: PreOrder;
  note: string;
  /**
   * The retailer's own product photo, when the response names one.
   *
   * Preferred over the page's og:image tag, which is chosen for social
   * previews and is sometimes a seasonal banner rather than the product.
   * Blank means "use whatever the page scrape found".
   */
  imageUrl?: string;
}

/**
 * Turn a retailer's HTML-encoded title into the name a person would write.
 *
 * Target's product title arrives as `Pok&#233;mon Trading Card Game: 30th
 * Celebration Elite Trainer Box`. Stored undecoded it shows up on the page
 * exactly like that — and it is worse than the slug guess it replaced, because
 * it looks like a deliberate name rather than an obvious mistake.
 *
 * Deliberately small: the five named entities that actually appear in product
 * titles, plus numeric ones. This is not an HTML parser and should not become
 * one — anything it does not recognise is left alone rather than mangled.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => codePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec: string) => codePoint(Number(dec), whole))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole);
}

function codePoint(n: number, whole: string): string {
  // Anything outside the range of a real character is left as it was found.
  // A wrong character is harder to notice than an obviously undecoded one.
  if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) return whole;
  try {
    return String.fromCodePoint(n);
  } catch {
    return whole;
  }
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
    addToCart: null,
    preOrder: { isPreOrder: false, releaseDate: null },
    note,
  };
}

/**
 * A seller that is the retailer itself.
 *
 * Pokémon Center only. This used to say "and Target", and that was wrong in a
 * way that mattered: target.com carries Target Plus marketplace listings, and
 * `item.fulfillment.is_marketplace` appears 43 times in a single captured
 * search response. See the note at the top of target.ts.
 */
export function firstParty(name: string): Seller {
  return { kind: 'retailer', name };
}
