/**
 * Reading a whole Target category in one request.
 *
 * The product readers answer "what is true of this one listing". This answers a
 * different question — *which* listings are worth watching at all — and it is
 * the cheaper of the two by a wide margin: Target's search endpoint returns the
 * same fulfillment structure the product page does, for every result. One
 * request covers what twenty-eight product-page visits would, against a budget
 * of one request per retailer every twenty seconds.
 *
 * ── What this is looking for ────────────────────────────────────────────────
 *
 * Not "what is in stock". By the time something is in stock the race is over,
 * and on this retailer the only things in stock are resellers at four times
 * MSRP. What this is looking for is the state *before* that:
 *
 *   street_date                              Target has scheduled the drop
 *   is_out_of_stock_in_all_store_locations   false while shipping says
 *                                            OUT_OF_STOCK — stock has landed
 *                                            somewhere it can be counted, and
 *                                            online has not opened yet
 *   location_available_to_promise_quantity   how much, at the nearest store
 *   pre_order_location_...                   an allocation held against a store
 *
 * Whether the middle one actually leads a drop is not yet known — everything
 * captured so far is `true`. That is precisely why it is recorded per scan
 * rather than reasoned about: the question is empirical and the answer arrives
 * on a release day.
 *
 * ── The carousel trap, again ────────────────────────────────────────────────
 *
 * This anchors on `search_response.products` rather than walking for anything
 * that looks like a product. A Target search page carries recommendation
 * carousels — thirty other products, each with a price and a fulfilment block —
 * and a looser walk puts them in the results. That mistake has been made once
 * already, in apisniff.ts, and it is written down at the top of that file too.
 */
import type { StockState } from '../types.ts';
import { decodeEntities, firstParty, type Seller } from './types.ts';
import { stockFromStatus } from './target.ts';

/** One search result, with everything that bears on whether it is about to move. */
export interface ScanRow {
  tcin: string;
  name: string;
  /** The canonical product URL, from Target's own enrichment. */
  url: string;
  price: number | null;
  seller: Seller;
  /** Shipping availability — the one that decides whether you can buy it. */
  state: StockState;
  availableQuantity: number | null;
  /** Per-customer cap. The promise quantity is clamped to this. */
  orderLimit: number | null;
  /** Target's published on-sale date. */
  releaseDate: string | null;
  /**
   * Target's own summary of nearby stores. Null when it did not say.
   *
   * `false` on something whose shipping status is OUT_OF_STOCK is the most
   * interesting single fact this scan can return.
   */
  outOfStockInAllStores: boolean | null;
  /** Units at the nearest store, when stated. */
  storeQuantity: number | null;
  /** Pre-release allocation held at the nearest store, when stated. */
  preOrderStoreQuantity: number | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find the search results, and only the search results.
 *
 * Several response shapes have carried this over time, so it looks for the
 * `search_response.products` key wherever it sits rather than at a fixed path —
 * but it will not accept a bare array of product-shaped things, which is what
 * the carousels are.
 */
export function searchProducts(body: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 12 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const search = asRecord(rec.search_response);
    if (search && Array.isArray(search.products)) {
      for (const p of search.products) {
        const product = asRecord(p);
        if (product && product.tcin) found.push(product);
      }
    }
    for (const key of Object.keys(rec)) visit(rec[key], depth + 1);
  };
  visit(body, 0);

  // The same tcin can appear in more than one module of the same response.
  const seen = new Set<string>();
  return found.filter((p) => {
    const id = String(p.tcin);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Turn one search result into a row. Pure; every field optional in the wild. */
export function toScanRow(product: Record<string, unknown>): ScanRow {
  const item = asRecord(product.item);
  const desc = item ? asRecord(item.product_description) : null;
  const enrichment = item ? asRecord(item.enrichment) : null;
  const itemFulfil = item ? asRecord(item.fulfillment) : null;
  const price = asRecord(product.price);
  const f = asRecord(product.fulfillment);
  const shipping = f ? asRecord(f.shipping_options) : null;

  let seller: Seller = firstParty('Target');
  if (itemFulfil && itemFulfil.is_marketplace === true) {
    const vendors = item && Array.isArray(item.product_vendors) ? item.product_vendors : [];
    const vendor = vendors.length ? asRecord(vendors[0]) : null;
    seller = { kind: 'marketplace', name: vendor ? String(vendor.vendor_name ?? '').trim() : '' };
  }

  const mmbv = item ? asRecord(item.mmbv_content) : null;
  const street = mmbv ? String(mmbv.street_date ?? '') : '';
  // Deliberately not a regex: this file is safe for one, but the same check in
  // page.ts is not, and having the two disagree is how a date gets accepted in
  // one place and dropped in the other.
  const streetParts = street.split('-');
  const looksLikeDate =
    streetParts.length === 3 &&
    streetParts[0]!.length === 4 &&
    streetParts[1]!.length === 2 &&
    streetParts[2]!.length === 2 &&
    Number.isFinite(Date.parse(street + 'T00:00:00Z'));

  let storeQuantity: number | null = null;
  let preOrderStoreQuantity: number | null = null;
  for (const raw of f && Array.isArray(f.store_options) ? f.store_options : []) {
    const store = asRecord(raw);
    if (!store) continue;
    const q = num(store.location_available_to_promise_quantity);
    if (q !== null) storeQuantity = Math.max(storeQuantity ?? 0, q);
    const pq = num(store.pre_order_location_available_to_promise_quantity);
    if (pq !== null) preOrderStoreQuantity = Math.max(preOrderStoreQuantity ?? 0, pq);
  }

  const retail = price ? num(price.current_retail) : null;

  return {
    tcin: String(product.tcin ?? ''),
    name: decodeEntities(String(desc?.title ?? '').replace(/<[^>]+>/g, '')).trim(),
    url: String(enrichment?.buy_url ?? ''),
    // Zero is never a price, here for the same reason as everywhere else.
    price: retail !== null && retail > 0 ? retail : null,
    seller,
    state: shipping ? stockFromStatus(String(shipping.availability_status ?? '')) : 'unknown',
    availableQuantity: shipping ? num(shipping.available_to_promise_quantity) : null,
    orderLimit: itemFulfil ? num(itemFulfil.purchase_limit) : null,
    releaseDate: looksLikeDate ? street : null,
    outOfStockInAllStores:
      f && typeof f.is_out_of_stock_in_all_store_locations === 'boolean'
        ? f.is_out_of_stock_in_all_store_locations
        : null,
    storeQuantity,
    preOrderStoreQuantity,
  };
}

/** Read every result in a captured search response. */
export function readTargetSearch(bodies: unknown[]): ScanRow[] {
  const rows: ScanRow[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const product of searchProducts(body)) {
      const row = toScanRow(product);
      if (!row.tcin || seen.has(row.tcin)) continue;
      seen.add(row.tcin);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * What a row means, in one word.
 *
 * Ordered by how close the thing is to being buyable *from Target*, which is
 * the only kind of buyable worth anything here. A reseller at four times MSRP
 * is in stock and is not an opportunity, so it sorts below an unreleased box
 * with a date on it.
 */
export type ScanSignal =
  | 'buyable'
  | 'in-stores'
  | 'due-today'
  | 'scheduled'
  | 'overdue'
  | 'resale'
  | 'quiet';

export interface ScanVerdict {
  row: ScanRow;
  signal: ScanSignal;
  /** Days until the release date; null when there is none or it has passed. */
  daysOut: number | null;
  /** Said in words, because a one-word signal is not a reason. */
  why: string;
}

const RANK: Record<ScanSignal, number> = {
  buyable: 0,
  'in-stores': 1,
  'due-today': 2,
  scheduled: 3,
  overdue: 4,
  resale: 5,
  quiet: 6,
};

export function classify(row: ScanRow, now: number = Date.now()): ScanVerdict {
  const days =
    row.releaseDate === null
      ? null
      : Math.ceil((Date.parse(row.releaseDate + 'T00:00:00Z') - now) / 86400_000);

  if (row.seller.kind === 'marketplace') {
    return {
      row,
      signal: 'resale',
      daysOut: days,
      why: `sold by ${row.seller.name || 'a marketplace seller'} — not Target's stock`,
    };
  }

  if (row.state === 'in') {
    const qty =
      row.availableQuantity === null
        ? ''
        : row.orderLimit !== null && row.availableQuantity >= row.orderLimit
          ? `, at least ${row.availableQuantity} (the order limit)`
          : `, ${row.availableQuantity} left`;
    return { row, signal: 'buyable', daysOut: days, why: `in stock at Target${qty}` };
  }

  // The one this whole scan exists for: Target says a nearby store has it while
  // the site will not sell it to you. If a drop is ever visible before it
  // opens, this is the shape it takes.
  if (row.outOfStockInAllStores === false) {
    const qty = row.storeQuantity ? ` (${row.storeQuantity} at the nearest)` : '';
    return {
      row,
      signal: 'in-stores',
      daysOut: days,
      why: `out of stock online, but a store has it${qty} — online may be about to open`,
    };
  }
  if (row.preOrderStoreQuantity !== null && row.preOrderStoreQuantity > 0) {
    return {
      row,
      signal: 'in-stores',
      daysOut: days,
      why: `${row.preOrderStoreQuantity} held as pre-release allocation at a store`,
    };
  }

  if (days !== null) {
    if (days === 0) return { row, signal: 'due-today', daysOut: 0, why: 'on sale today' };
    if (days > 0) {
      return {
        row,
        signal: 'scheduled',
        daysOut: days,
        why: `on sale ${row.releaseDate}, ${days} day${days === 1 ? '' : 's'} away`,
      };
    }
    return {
      row,
      signal: 'overdue',
      daysOut: days,
      why: `street date ${row.releaseDate} has passed and it is still not in stock`,
    };
  }

  return { row, signal: 'quiet', daysOut: null, why: 'out of stock, no date announced' };
}

/**
 * Everything, most-worth-your-attention first.
 *
 * Ties break on soonest date and then on tcin, so two runs over the same data
 * produce the same order — a scan you cannot diff against yesterday's is half
 * a tool.
 */
export function rankScan(rows: ScanRow[], now: number = Date.now()): ScanVerdict[] {
  return rows
    .map((row) => classify(row, now))
    .sort((a, b) => {
      if (RANK[a.signal] !== RANK[b.signal]) return RANK[a.signal] - RANK[b.signal];
      const ad = a.daysOut ?? 9999;
      const bd = b.daysOut ?? 9999;
      if (ad !== bd) return ad - bd;
      return a.row.tcin.localeCompare(b.row.tcin);
    });
}
