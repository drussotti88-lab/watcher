/**
 * Reading a Walmart product page.
 *
 * The third retailer, the third strategy. Walmart serves no JSON-LD either, but
 * unlike Target it ships the entire product in embedded page state — 305KB of
 * `__NEXT_DATA__` with the real thing at
 *
 *     props.pageProps.initialData.data.product
 *
 * matched by `usItemId` against the id in the URL. That is option 3 on the
 * list, and it is better here than the recorded GraphQL traffic: the
 * `ItemByIdBtf` POST we captured is *below-the-fold* data, which carries the
 * item among a couple of dozen others in a recommendations module. The embedded
 * node is the authoritative one, and it is the only place carrying the seller.
 *
 * ── The Walmart equivalent of Target's `sold_out` trap ───────────────────────
 *
 * The captured page reads, in full sincerity:
 *
 *     availabilityStatus: "IN_STOCK"
 *     priceInfo.currentPrice.price: 73.76
 *     sellerType: "EXTERNAL"
 *     sellerName: "Rares Market L.L.C."
 *
 * In stock, priced, buyable — and sold by a marketplace reseller at roughly
 * half again over MSRP for that Elite Trainer Box. A reader that returns price
 * and stock and stops there hands the decision layer everything it needs to buy
 * from a scalper unattended. So `sellerType` is read on every pass and comes
 * back with the reading.
 *
 * `EXTERNAL` is Walmart's own word for a third-party seller; `INTERNAL` is
 * Walmart itself. Anything else is reported as unknown rather than assumed
 * safe.
 */
import type { ProductRead, Seller } from './types.ts';
import { unknownRead } from './types.ts';
import type { StockState, Confidence } from '../types.ts';

/** Walmart's availability vocabulary. Unrecognised words refuse to answer. */
export function stockFromWalmart(status: string): StockState {
  switch (status.trim().toUpperCase()) {
    case 'IN_STOCK':
      return 'in';
    case 'OUT_OF_STOCK':
    case 'UNAVAILABLE':
    case 'RETIRED':
      return 'out';
    default:
      return 'unknown';
  }
}

export function sellerFrom(type: unknown, name: unknown): Seller {
  const t = String(type ?? '').trim().toUpperCase();
  const n = String(name ?? '');
  if (t === 'INTERNAL') return { kind: 'retailer', name: n || 'Walmart' };
  if (t === 'EXTERNAL') return { kind: 'marketplace', name: n };
  return { kind: 'unknown', name: n };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Find the product node inside a parsed `__NEXT_DATA__` blob.
 *
 * Searched rather than read from a fixed path, for the same reason as Target:
 * `props.pageProps.initialData.data.product` is where it lives today, and the
 * `usItemId` is what makes it still findable when that stops being true.
 */
export function walmartProductNode(
  nextData: unknown,
  itemId: string,
): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 16 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((v) => visit(v, depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (String(obj.usItemId ?? '') === itemId && (obj.priceInfo || obj.availabilityStatus)) {
      found = obj;
      return;
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };

  visit(nextData, 0);
  return found;
}

export function readWalmartNextData(nextData: unknown, itemId: string): ProductRead {
  const product = walmartProductNode(nextData, itemId);
  if (!product) return unknownRead(`no product node for usItemId ${itemId} in __NEXT_DATA__`);

  const name = String(product.name ?? '');
  const seller = sellerFrom(product.sellerType, product.sellerName);

  let price: number | null = null;
  const priceInfo = asRecord(product.priceInfo);
  const current = priceInfo ? asRecord(priceInfo.currentPrice) : null;
  if (current) {
    const n = Number(current.price);
    // Zero is never a price.
    if (Number.isFinite(n) && n > 0) price = n;
  }

  const status = String(product.itemPageAvailabilityStatus ?? product.availabilityStatus ?? '');
  let state = stockFromWalmart(status);

  const pre = asRecord(product.preOrder);
  const preOrder = {
    isPreOrder: Boolean(pre?.isPreOrder),
    releaseDate: pre?.releaseDate ? String(pre.releaseDate) : null,
  };

  const orderLimitRaw = Number(product.orderLimit);
  const orderLimit = Number.isFinite(orderLimitRaw) && orderLimitRaw > 0 ? orderLimitRaw : null;

  // Shipping and pickup are separate options; only shipping bears on money owed.
  let availableQuantity: number | null = null;
  let pickupAvailable = false;
  for (const raw of Array.isArray(product.fulfillmentOptions) ? product.fulfillmentOptions : []) {
    const opt = asRecord(raw);
    if (!opt) continue;
    const type = String(opt.type ?? '').toUpperCase();
    if (type === 'SHIPPING') {
      const q = Number(opt.availableQuantity);
      if (Number.isFinite(q)) availableQuantity = q;
    }
    if (type === 'PICKUP' && opt.selected === true) pickupAvailable = true;
  }

  const notes: string[] = [`availability ${status || '(absent)'}`];

  // A used or refurbished listing is a different product wearing the same name.
  const conditionNew = product.isConditionNew !== false;
  if (!conditionNew) {
    notes.push(`condition ${String(product.conditionType ?? 'not new')} — not treated as buyable`);
    state = 'unknown';
  }

  if (seller.kind === 'marketplace') notes.push(`marketplace seller: ${seller.name}`);
  if (seller.kind === 'unknown') notes.push('seller could not be identified');
  if (availableQuantity !== null) notes.push(`qty ${availableQuantity}`);
  if (orderLimit !== null) notes.push(`limit ${orderLimit}`);
  if (preOrder.isPreOrder) notes.push(`preorder, releases ${preOrder.releaseDate ?? 'unknown'}`);

  let confidence: Confidence = 'unknown';
  if (state !== 'unknown' && price !== null) confidence = 'exact';
  else if (state !== 'unknown') confidence = 'inferred';

  return {
    name,
    price,
    state,
    confidence,
    availableQuantity,
    orderLimit,
    pickupAvailable,
    seller,
    preOrder,
    note: notes.join('; '),
  };
}
