/**
 * Reading a Walmart search page.
 *
 * The third of three, and it needed all three techniques between them: Target
 * by listening to its own API calls, Pokémon Center from a `__NEXT_DATA__`
 * blob on a category page, and Walmart from a `__NEXT_DATA__` blob on a search
 * page — same mechanism as Pokémon Center, different tree, different traps.
 *
 * ── Why search and not the category ─────────────────────────────────────────
 *
 * The source was seeded with a browse URL:
 *
 *     /browse/toys/trading-cards/4171_4187_1229163
 *
 * That page now answers **"This page couldn't be found."** The category id had
 * rotted, and because nothing had ever swept Walmart the 404 sat there unnoticed
 * for as long as the source has existed. A search query cannot rot the same
 * way: the words survive a re-organised taxonomy.
 *
 * ── The filter that makes this source worth having ──────────────────────────
 *
 * `facet=retailer_type:Walmart`. Read out of the page's own filter definitions
 * rather than guessed, and the difference is the entire value of the source:
 *
 *   without it   50 results, ZERO sold by Walmart. Every one a reseller —
 *                $3,275 for a sealed case, $609 for a 151 ETB, $74 for a box
 *                with an MSRP under fifty.
 *   with it      30 results, 29 sold by Walmart.com, at $39–$55.
 *
 * An earlier guess at `facet=retailer:Walmart.com` changed nothing at all and
 * looked plausible while doing so, which is the argument for reading a
 * retailer's own vocabulary out of its own page instead of inventing it.
 */
import type { StockState } from '../types.ts';

export interface WalmartRow {
  /** Walmart's item id. The thing a mission is pinned to. */
  usItemId: string;
  name: string;
  url: string;
  price: number | null;
  state: StockState;
  /** Their name for whoever is selling. "Walmart.com" is first-party. */
  sellerName: string;
  /**
   * Walmart's own id for that seller, which is the half a name cannot fake.
   *
   * Measured 2 Sep 2026 on `pokemon elite trainer box` with no facet: 49 rows,
   * 27 distinct seller ids, and exactly ONE of them Walmart's. The other 48
   * rows were Rares Market, DealDudes, Icy Society, Troll and Toad and two
   * dozen more — every one of them `IN_STOCK` and `canAddToCart: true`, which
   * is precisely how a reseller listing looks more buyable than the real
   * thing.
   */
  sellerId: string;
  isPreOrder: boolean;
  /** The publisher's street date, when Walmart has one. */
  releaseDate: string | null;
  imageUrl: string;
  /**
   * How many other sellers have an offer on this same listing.
   *
   * The field that explains the surprise. Walmart's own listing can be out of
   * stock while the product page still shows a price — the buy box falls to a
   * marketplace seller, sometimes at forty times the money. The search says
   * Walmart, at Walmart's price, out of stock, and every word of that is true;
   * the page just looks nothing like it.
   */
  otherOffers: number | null;
  /** Can this be put in a basket right now? False for every out-of-stock row. */
  canAddToCart: boolean;
}

export interface WalmartMeta {
  /** Results on this page, as Walmart counts them. */
  count: number | null;
  /** Results across the whole query. */
  total: number | null;
  /** How many pages the query has. */
  maxPage: number | null;
}

/** Only what Walmart itself sells. Their spelling, from their own filter list. */
export const SOLD_BY_WALMART = 'retailer_type:Walmart';

/** The search URL for one query, one page deep. */
export function searchUrl(query: string, page = 1): string {
  const params = new URLSearchParams({ q: String(query ?? '') });
  params.set('facet', SOLD_BY_WALMART);
  if (page > 1) params.set('page', String(page));
  return `https://www.walmart.com/search?${params.toString()}`;
}

/** Pull `__NEXT_DATA__` out of the page HTML. Null when it is not there. */
export function nextData(html: string): unknown {
  // The attribute list matters: Walmart adds `nonce=""`, so a pattern that
  // expects the tag to end right after type="application/json" finds nothing
  // and reports a page with no products. That cost a probe cycle.
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html ?? ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

function searchResult(data: unknown): Record<string, any> | null {
  const sr = (data as any)?.props?.pageProps?.initialData?.searchResult;
  return sr && typeof sr === 'object' ? sr : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** A price is never zero. Zero is Walmart's way of saying "no offer". */
function positive(n: number | null): number | null {
  return n !== null && n > 0 ? n : null;
}

/** Walmart's availability vocabulary → ours. Unknown stays unknown. */
export function stockFromWalmart(status: string): StockState {
  switch (String(status ?? '').toUpperCase()) {
    case 'IN_STOCK':
      return 'in';
    case 'OUT_OF_STOCK':
    case 'RETIRED':
      return 'out';
    default:
      return 'unknown';
  }
}

function isoDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : null;
}

/** Every product on the page. Ad slots and placeholders are skipped. */
export function readWalmartSearch(data: unknown): WalmartRow[] {
  const sr = searchResult(data);
  const stacks = Array.isArray(sr?.itemStacks) ? sr!.itemStacks : [];
  const rows: WalmartRow[] = [];

  for (const stack of stacks) {
    const items = Array.isArray(stack?.items) ? stack.items : [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const i = raw as Record<string, any>;

      // A search page carries ad modules in the same array as the products.
      // They have no item id and no name, and one of them is on every page.
      const usItemId = String(i.usItemId ?? '').trim();
      const name = String(i.name ?? '').trim();
      if (!usItemId || !name) continue;

      const path = String(i.canonicalUrl ?? '').trim();
      rows.push({
        usItemId,
        name,
        // canonicalUrl is a path with tracking parameters on it. Keep the path,
        // drop the query: a watchlist entry should be the product, not the
        // search that happened to find it.
        url: path ? `https://www.walmart.com${path.split('?')[0]}` : '',
        /*
         * Measured 3 Sep 2026 under facet=retailer_type:Walmart: every row
         * Walmart is out of stock on carries `price: 0`. Walmart publishes no
         * price when it has no offer; the only price on that product page is
         * a reseller's. So zero is "Walmart has no price today", and a find
         * that showed $0.00 — or worse, treated 0 as a number to compare
         * against the usual price — would be reporting a fact that is not
         * there. Null, like every other absent thing.
         */
        price: positive(num(i.price)) ?? positive(num(i.priceInfo?.currentPrice?.price)),
        state: stockFromWalmart(i.availabilityStatusV2?.value ?? i.availabilityStatus),
        sellerName: String(i.sellerName ?? '').trim(),
        sellerId: String(i.sellerId ?? '').trim(),
        isPreOrder: i.preOrder?.isPreOrder === true,
        releaseDate: isoDate(i.preOrder?.streetDate ?? i.preOrder?.releaseDate),
        imageUrl: String(i.imageInfo?.thumbnailUrl ?? '').trim(),
        otherOffers: num(i.additionalOfferCount),
        canAddToCart: i.canAddToCart === true || i.showAtc === true,
      });
    }
  }
  return rows;
}

export function walmartMeta(data: unknown): WalmartMeta {
  const sr = searchResult(data);
  return {
    count: num(sr?.count),
    total: num(sr?.aggregatedCount),
    maxPage: num(sr?.paginationV2?.maxPage),
  };
}

/**
 * Is this Walmart's own listing?
 *
 * The facet already asks for it, but a filter is a request and this is the
 * check. Target taught the lesson: a marketplace listing that read as
 * first-party defeated `retailer_only` on an armed mission, and the money-safe
 * direction is to verify rather than to trust the parameter we sent.
 */
/**
 * Walmart's own seller id.
 *
 * One constant, read off their own rows. A name is a display string a
 * marketplace seller chooses; this is the key Walmart joins on, and no
 * reseller can call themselves it.
 */
export const WALMART_SELLER_ID = 'F55CDC31AB754BB68FE0B39041159D63';

export function soldByWalmart(sellerName: string, sellerId = ''): boolean {
  /*
   * The id decides when we have it.
   *
   * Not belt and braces for its own sake. Under `facet=retailer_type:Walmart`
   * EVERY row says "Walmart.com" — the facet selects listings Walmart's
   * catalogue owns, not listings Walmart is currently selling — so within a
   * faceted sweep the name distinguishes nothing at all. It is only load-
   * bearing on an unfaceted query, and there it is a string a seller picked.
   *
   * So: trust the id when Walmart sends one, and fall back to the name only
   * when it is absent, which is the case an older capture and every existing
   * fixture is in.
   */
  const id = String(sellerId ?? '').trim().toUpperCase();
  if (id) return id === WALMART_SELLER_ID;
  const s = String(sellerName ?? '').trim().toLowerCase();
  return s === 'walmart.com' || s === 'walmart';
}

/**
 * What a Walmart find is actually offering, once you know Walmart owns it.
 *
 * Three states wearing one word. The sweep has all of this at parse time and
 * used to collapse it to "in stock" or "out", which is how a find that opens
 * onto a $3,999 reseller page looked identical to one worth watching.
 */
export type WalmartOffer =
  /** Walmart is selling it right now. */
  | 'walmart-selling'
  /** Walmart owns it, nobody is selling it. The best thing to watch. */
  | 'nobody-selling'
  /** Walmart is out and resellers hold the buy box. The page will not look like the find. */
  | 'resellers-hold-it';

export function walmartOffer(row: {
  state: StockState;
  canAddToCart: boolean;
  otherOffers: number | null;
}): WalmartOffer {
  if (row.state === 'in' && row.canAddToCart) return 'walmart-selling';
  if ((row.otherOffers ?? 0) > 0) return 'resellers-hold-it';
  return 'nobody-selling';
}
