/**
 * Reading a Pokémon Center product page.
 *
 * The easy one, and worth saying why: Pokémon Center publishes complete
 * schema.org markup in the page — price, availability, SKU, all of it — so this
 * reader is a dozen lines over the generic JSON-LD extractor rather than a
 * bespoke thing written against recorded network traffic.
 *
 * The one wrinkle the real page threw up: it ships *two* Product blocks. The
 * first has the offer; the second is a ratings-only stub with no offers at all,
 * which the generic extractor faithfully reports with a null price. Taking
 * "the first Product" would work by luck today and break the day they reorder
 * the blocks, so this matches on SKU and prefers the block that actually
 * carries an offer.
 */
import type { StockState, Confidence } from '../types.ts';
import type { LdOffer } from '../inspect.ts';
import type { ProductRead } from './types.ts';
import { unknownRead, firstParty } from './types.ts';

/** schema.org availability → our vocabulary. Unknown stays unknown. */
export function stockFromAvailability(availability: string): StockState {
  switch (availability) {
    case 'InStock':
    case 'LimitedAvailability':
      return 'in';
    case 'PreOrder':
      return 'in';
    case 'OutOfStock':
    case 'SoldOut':
    case 'Discontinued':
      return 'out';
    case 'BackOrder':
      return 'out';
    default:
      return 'unknown';
  }
}

/**
 * Pick the offer that belongs to this SKU and turn it into a reading.
 *
 * `sku` is the id from the URL (`/product/100-10326/…`), which the page repeats
 * in both `sku` and `mpn`.
 */
export function readPokemonCenterOffers(offers: LdOffer[], sku: string): ProductRead {
  const forSku = offers.filter((o) => o.sku === sku);
  const candidates = forSku.length > 0 ? forSku : offers;

  // Prefer a block that states availability; a ratings-only stub states none.
  const offer =
    candidates.find((o) => o.availability !== '' && o.price !== null) ??
    candidates.find((o) => o.availability !== '') ??
    candidates[0];

  if (!offer) return unknownRead('no schema.org Product on the page');

  const state = stockFromAvailability(offer.availability);
  const matched = forSku.length > 0;

  let confidence: Confidence = 'unknown';
  if (state !== 'unknown' && offer.price !== null && matched) confidence = 'exact';
  else if (state !== 'unknown') confidence = 'inferred';

  const notes: string[] = [`availability ${offer.availability || '(absent)'}`];
  if (!matched) {
    // Reading a page and finding a different SKU's offer is a redirect, a
    // variant switch, or the wrong URL — all of which mean don't act on it.
    notes.push(`no offer for sku ${sku}; used ${offer.sku || 'an unlabelled block'}`);
  }

  return {
    name: offer.name,
    price: offer.price,
    state,
    confidence,
    availableQuantity: null,
    orderLimit: null,
    pickupAvailable: false,
    // Pokémon Center sells its own stock; there is no marketplace to guard against.
    seller: firstParty('Pokémon Center'),
    // schema.org PreOrder is availability, not a dated release. Half B still
    // takes release dates by hand here.
    preOrder: { isPreOrder: offer.availability === 'PreOrder', releaseDate: null },
    note: notes.join('; '),
  };
}
