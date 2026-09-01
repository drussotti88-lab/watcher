/**
 * Reading a Target product page.
 *
 * Written from recorded responses, not from selectors. Target's page carries no
 * JSON-LD and no price in its HTML; the price and the stock state arrive after
 * hydration in two *separate* POSTs to the same URL, which is why this takes a
 * list of bodies and merges across them.
 *
 * The module types are Target's own names, taken from the recorded traffic:
 *
 *   ProductDetailWebDatasourceWithStore              → module_data.data.product.price
 *   ProductDetailWebDatasourceFulfillmentAndVariations → …product.fulfillment
 *
 * ── The thing that would have cost real money ────────────────────────────────
 *
 * On an item the page plainly showed as "Out of stock", the recorded body said:
 *
 *     sold_out: false
 *
 * A reader that trusted `sold_out` would have called this buyable and, once the
 * checkout flow exists, fired a purchase attempt at 3am against nothing. What
 * `sold_out` actually means is closer to "discontinued" — Target still sells
 * this item, it just hasn't got any. The field that answers "can I buy this,
 * shipped, right now" is:
 *
 *     fulfillment.shipping_options.availability_status  = OUT_OF_STOCK
 *     fulfillment.shipping_options.reason_code          = INVENTORY_UNAVAILABLE
 *     fulfillment.shipping_options.available_to_promise_quantity = 0
 *
 * So that is what this reads, and `sold_out` is deliberately ignored.
 */
import type { StockState, Confidence } from '../types.ts';
import type { ProductRead } from './types.ts';
import { unknownRead, firstParty, decodeEntities, type Seller } from './types.ts';

/**
 * Target's availability vocabulary, from the recorded responses.
 *
 * Anything unrecognised maps to 'unknown' rather than to 'out'. Guessing "out"
 * is a missed drop; guessing "in" is a bad purchase. Neither is acceptable, so
 * an unfamiliar status refuses to answer and the decision layer declines to
 * spend on an unknown read.
 */
export function stockFromStatus(status: string): StockState {
  switch (status.trim().toUpperCase()) {
    case 'IN_STOCK':
    case 'AVAILABLE':
      return 'in';
    case 'OUT_OF_STOCK':
    case 'UNAVAILABLE':
    case 'NOT_SOLD_IN_STORE':
    case 'INVENTORY_UNAVAILABLE':
      return 'out';
    case 'PRE_ORDER_SELLABLE':
      return 'in';
    case 'PRE_ORDER_UNSELLABLE':
      return 'out';
    default:
      return 'unknown';
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Find every `product` node in a response that belongs to the tcin we asked
 * about.
 *
 * Deliberately a search rather than a fixed path. The recorded bodies put the
 * product at `modules[0].module_data.data.product`, but the index moves between
 * responses and Target ships CDUI module layouts that change without notice.
 * Matching on the tcin is what makes this survive that — and it is the same
 * anchor that stopped the recommendations carousel being mistaken for the item.
 */
export function productNodes(body: unknown, tcin: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 14 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((v) => visit(v, depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (String(obj.tcin ?? '') === tcin && (obj.price || obj.fulfillment || obj.item)) {
      found.push(obj);
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };

  visit(body, 0);
  return found;
}

/** Merge the price response and the fulfillment response into one reading. */
export function readTargetBodies(
  bodies: unknown[],
  tcin: string,
  now: number = Date.now(),
): ProductRead {
  let name = '';
  let price: number | null = null;
  let shippingStatus = '';
  let quantity: number | null = null;
  let pickup = false;
  let sawProduct = false;
  let streetDate: string | null = null;
  let orderLimit: number | null = null;
  let preOrderQuantity: number | null = null;
  let seller: Seller = firstParty('Target');
  let imageUrl = '';

  for (const body of bodies) {
    for (const product of productNodes(body, tcin)) {
      sawProduct = true;

      const item = asRecord(product.item);
      const desc = item ? asRecord(item.product_description) : null;
      const title = desc ? String(desc.title ?? '') : '';
      if (title && !name) name = decodeEntities(title.replace(/<[^>]+>/g, '')).trim();

      // ── The on-sale date, which Target states outright ────────────────
      //
      // `item.mmbv_content.street_date` is present on an item weeks before it
      // can be bought, on the PDP and on every search result. It is the answer
      // to "is something we are waiting for about to be stocked": not a
      // quantity creeping up — there is no such thing, the count is 0 until
      // the moment it is not — but the retailer's own published date.
      //
      // It was being thrown away. Everything downstream of here already had
      // somewhere to put it.
      if (item) {
        const mmbv = asRecord(item.mmbv_content);
        const street = mmbv ? String(mmbv.street_date ?? '') : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(street)) streetDate = street;

        // How many one customer may have. Worth reading in its own right, and
        // it explains the quantity: the promise count is clamped to this, so
        // an "available 20" against a limit of 20 means *at least* 20, while
        // 9 against a limit of 20 means nine.
        const itemFulfil = asRecord(item.fulfillment);
        if (itemFulfil) {
          const lim = Number(itemFulfil.purchase_limit);
          if (Number.isFinite(lim) && lim > 0) orderLimit = lim;

          // ── Target has a marketplace, and this reader used to deny it ────
          //
          // The comment here read "Target has no marketplace: everything on
          // target.com is sold by Target", and every listing was reported as
          // first-party on that basis. It is not true — Target Plus exists,
          // and `is_marketplace` appears 43 times in one captured search
          // response, on listings at $179 to $279 against a $50 box.
          //
          // The consequence was not cosmetic. `sellerPolicy: 'retailer_only'`
          // is the guard that stops an armed mission buying from a reseller,
          // and it works by comparing seller.kind. A reader that says
          // 'retailer' for everything defeats that guard completely, on the
          // one retailer where the resellers are the only things in stock.
          if (itemFulfil.is_marketplace === true) {
            seller = { kind: 'marketplace', name: '' };
          }
        }

        // Who the marketplace seller actually is, when it says.
        const vendors = Array.isArray(item.product_vendors) ? item.product_vendors : [];
        const vendor = vendors.length ? asRecord(vendors[0]) : null;
        const vendorName = vendor ? String(vendor.vendor_name ?? '').trim() : '';
        if (vendorName && seller.kind === 'marketplace') seller = { kind: 'marketplace', name: vendorName };
      }

      // The same photo the search response carries, and a better source than
      // the page's og:image tag — og:image is chosen for social previews and
      // is sometimes a banner rather than the product.
      if (item && !imageUrl) {
        const enrich = asRecord(item.enrichment);
        const info = enrich ? asRecord(enrich.image_info) : null;
        const primary = info ? asRecord(info.primary_image) : null;
        if (primary && primary.url) imageUrl = String(primary.url);
      }

      const p = asRecord(product.price);
      if (p) {
        const n = Number(p.current_retail);
        // Zero is never a price. A zero here would read as "free" and arm a
        // purchase against nothing.
        if (Number.isFinite(n) && n > 0) price = n;
      }

      const f = asRecord(product.fulfillment);
      if (f) {
        const shipping = asRecord(f.shipping_options);
        if (shipping) {
          const status = String(shipping.availability_status ?? '');
          if (status) shippingStatus = status;
          const q = Number(shipping.available_to_promise_quantity);
          if (Number.isFinite(q)) quantity = q;
        }
        for (const raw of Array.isArray(f.store_options) ? f.store_options : []) {
          const store = asRecord(raw);
          const op = store ? asRecord(store.order_pickup) : null;
          if (op && stockFromStatus(String(op.availability_status ?? '')) === 'in') pickup = true;

          // A separate counter from the shipping one, and the only number in
          // this whole response that can move *before* a drop goes live: an
          // allocation loaded against a store ahead of the street date. It is
          // zero everywhere we have looked so far, which is worth knowing
          // rather than assuming, so it is recorded rather than judged on.
          if (store) {
            const pq = Number(store.pre_order_location_available_to_promise_quantity);
            if (Number.isFinite(pq)) {
              preOrderQuantity = Math.max(preOrderQuantity ?? 0, pq);
            }
          }
        }
      }
    }
  }

  if (!sawProduct) {
    return unknownRead(
      `no product node for tcin ${tcin} in ${bodies.length} captured responses`,
      name,
    );
  }

  const state = shippingStatus ? stockFromStatus(shippingStatus) : 'unknown';

  // Quantity contradicting the status is a reason to stop, not to pick a side.
  const contradiction = state === 'in' && quantity === 0;

  let confidence: Confidence = 'unknown';
  if (state !== 'unknown' && price !== null && !contradiction) confidence = 'exact';
  else if (state !== 'unknown' && !contradiction) confidence = 'inferred';

  // ── Not released yet, versus released and sold out ────────────────────────
  //
  // Two states the old reader could not tell apart, and they call for opposite
  // behaviour: one is worth waiting for on a known date, the other is a race
  // that already happened.
  //
  // `isPreOrder` stays false when the item cannot be bought. It means "you may
  // order this ahead of release", and saying so about something with no buy
  // button would be a lie the decision layer acts on. An unreleased item is
  // described by its release date, which is the honest version.
  const daysOut =
    streetDate === null
      ? null
      : Math.ceil((Date.parse(streetDate + 'T00:00:00Z') - now) / 86400_000);
  const unreleased = daysOut !== null && daysOut > 0 && state !== 'in';

  const notes: string[] = [];
  if (shippingStatus) notes.push(`shipping ${shippingStatus}`);
  // Counted, but not sellable: the shape of a scheduled drop in the hours
  // before it opens. Saying only "atp 31000" next to OUT_OF_STOCK reads as a
  // contradiction; naming it staged says which of the two is the news.
  if (quantity !== null) {
    notes.push(
      quantity > 0 && state !== 'in' ? `atp ${quantity} STAGED — not sellable yet` : `atp ${quantity}`,
    );
  }
  if (orderLimit !== null) notes.push(`limit ${orderLimit}`);
  // Only dates that are still ahead (or today) are information. Target keeps
  // publishing a street date long after it has passed — Chaos Rising carried
  // "2026-05-22" months later — and echoing it pinned a dead date to the card
  // on every check. What a past date MEANS ("released, and still not in
  // stock") is already said by the state.
  if (streetDate && daysOut !== null && daysOut >= 0) {
    notes.push(daysOut > 0 ? `on sale ${streetDate} (${daysOut}d away)` : 'on sale today');
  }
  // Only worth a note when it is not zero. Zero is the entire history of this
  // field so far, and a note on every line saying so is noise.
  if (preOrderQuantity !== null && preOrderQuantity > 0) {
    notes.push(`PRE-ORDER STOCK ${preOrderQuantity}`);
  }
  if (pickup) notes.push('pickup available');
  if (contradiction) notes.push('IN_STOCK with zero available — refusing to call it in stock');
  if (!shippingStatus) notes.push('no shipping availability in the captured responses');

  return {
    name,
    price,
    state: contradiction ? 'unknown' : state,
    confidence,
    availableQuantity: quantity,
    orderLimit,
    pickupAvailable: pickup,
    seller,
    preOrder: {
      isPreOrder: state === 'in' && daysOut !== null && daysOut > 0,
      // Same rule as the note: a past street date is history, not a schedule.
      // Reporting it would overwrite the Hub's stored date with last spring's
      // on every single check, forever.
      releaseDate: daysOut !== null && daysOut >= 0 ? streetDate : null,
    },
    imageUrl,
    note: notes.join('; '),
  };
}
