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
import { unknownRead, firstParty } from './types.ts';

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
export function readTargetBodies(bodies: unknown[], tcin: string): ProductRead {
  let name = '';
  let price: number | null = null;
  let shippingStatus = '';
  let quantity: number | null = null;
  let pickup = false;
  let sawProduct = false;

  for (const body of bodies) {
    for (const product of productNodes(body, tcin)) {
      sawProduct = true;

      const item = asRecord(product.item);
      const desc = item ? asRecord(item.product_description) : null;
      const title = desc ? String(desc.title ?? '') : '';
      if (title && !name) name = title.replace(/<[^>]+>/g, '');

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

  const notes: string[] = [];
  if (shippingStatus) notes.push(`shipping ${shippingStatus}`);
  if (quantity !== null) notes.push(`atp ${quantity}`);
  if (pickup) notes.push('pickup available');
  if (contradiction) notes.push('IN_STOCK with zero available — refusing to call it in stock');
  if (!shippingStatus) notes.push('no shipping availability in the captured responses');

  return {
    name,
    price,
    state: contradiction ? 'unknown' : state,
    confidence,
    availableQuantity: quantity,
    orderLimit: null,
    pickupAvailable: pickup,
    // Target has no marketplace: everything on target.com is sold by Target.
    seller: firstParty('Target'),
    preOrder: { isPreOrder: false, releaseDate: null },
    note: notes.join('; '),
  };
}
