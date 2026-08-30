/**
 * What a sealed Pokémon product usually costs at a shop that isn't reselling it.
 *
 * ── Why this is a table and not a lookup ────────────────────────────────────
 *
 * No retailer publishes MSRP. There is no field for it in any of the three
 * responses this system reads, and there is no public feed of it — so anything
 * claiming to be "the MSRP" for a specific product would be a number somebody
 * made up.
 *
 * Worse, first-party prices for the *same box* disagree. Observed on one day in
 * August 2026, both sold by the retailer itself:
 *
 *     30th Celebration Knock Out Collection    $9.99 at Pokémon Center
 *                                             $11.99 at Target
 *     30th Celebration Elite Trainer Box      $59.99 at Pokémon Center
 *                                             $69.99 at Target
 *
 * So the honest thing to show is not "the MSRP of this product" but "what this
 * kind of thing usually costs" — which is what you actually want when you are
 * looking at a price and deciding whether it is sane.
 *
 * ── Where these numbers come from ───────────────────────────────────────────
 *
 * First-party listings this system has read, cross-checked against the two
 * shops that never resell: Pokémon Center, which is The Pokémon Company's own
 * store, and Target's own stock. Several are exact rather than approximate
 * because they were observed directly — the booster bundle at $26.94 and the
 * 36-pack display at $161.64 are Pokémon Center's own prices.
 *
 * These will drift. They are a sanity check, not an authority, and the app says
 * so: it prints "usually" and never "MSRP $X".
 */

/** Typical first-party price, keyed by the classifier's `kind`. */
export const TYPICAL_PRICE: Readonly<Record<string, number>> = Object.freeze({
  'booster pack': 4.49,
  'booster packs': 12.99, // a sleeved or multi-pack
  'booster bundle': 26.94, // Pokémon Center, exact
  'booster box': 161.64, // 36-pack display, Pokémon Center, exact
  'elite trainer box': 49.99,
  'ultra premium collection': 119.99,
  'super premium collection': 79.99,
  'premium collection': 44.99, // Target, exact
  'collection box': 19.99,
  'ex box': 29.99, // Target, exact
  'v box': 24.99,
  'mini tin': 12.99,
  tin: 24.99,
  blister: 12.99,
  deck: 16.99,
  'build & battle': 24.99,
  toolkit: 29.99,
  'advent calendar': 49.99,
});

/**
 * How far above the usual price a listing sits. Null when there is nothing to
 * compare against — an unknown kind, or a listing with no price.
 */
export function overTypical(kind: string, price: number | null): number | null {
  const typical = TYPICAL_PRICE[String(kind ?? '').toLowerCase()];
  if (!typical || price === null || !Number.isFinite(price) || price <= 0) return null;
  return Math.round((price / typical) * 100) / 100;
}

/**
 * Is this far enough above the usual price to be worth flagging?
 *
 * 1.35 rather than 1.0, because first-party prices genuinely differ by shop and
 * by ten per cent — the Knock Out Collection above is 1.20× between two shops
 * that are both selling it honestly. Flagging that would be crying wolf on the
 * ordinary case and teaching you to ignore the flag when it matters.
 */
export const FLAG_ABOVE = 1.35;
