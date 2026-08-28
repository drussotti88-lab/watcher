/**
 * Watch what the page's own JavaScript asks for.
 *
 * The Target inspection settled an argument. That page has no JSON-LD at all,
 * and its `__NEXT_DATA__` blob — all 131KB of it — contains exactly one
 * price-related field:
 *
 *     isProductDetailServerSideRenderPriceEnabled: false
 *
 * which is Target telling us, in as many words, that the price is not in the
 * HTML. It arrives afterwards, over the wire, from their own API.
 *
 * So there is a strategy above all four in inspect.ts's list: let the page load,
 * and record the calls it makes. That gives us the real endpoint, the real
 * parameters and the real response shape — none of it guessed. A reader written
 * from a recorded call is reading the same source the site reads.
 *
 * The second Target inspection then taught the harder lesson. Ranking responses
 * by "how many price-shaped fields are in here" put the *recommendations*
 * carousel on top — thirty other products, each with a price — and buried the
 * one product we asked about. Volume is not relevance. What matters is whether
 * a price sits next to *our* identifier, so that is what this now measures.
 *
 * Everything here is pure and takes plain data, so it can be tested without a
 * browser.
 */

/** Telemetry, ads and logging. Never the product data, always noisy. */
const NOISE = [
  /\/consumers\/v\d\/ingest/i,
  /firefly_events/i,
  // No closing \b on these: vendors append to their own names (tealiumiq,
  // datadoghq), and a trailing word boundary quietly stops matching them.
  /\b(google|doubleclick|googletagmanager|gstatic|facebook|criteo|bing|tiktok)/i,
  /\b(tealium|adobedtm|omtrdc|demdex|quantserve|scorecardresearch)/i,
  /\b(sentry|datadog|newrelic|bugsnag|nr-data|dynatrace)/i,
  /\/(beacon|collect|rum|telemetry|metrics|analytics|track(ing)?)\b/i,
  /\.(png|jpe?g|gif|webp|svg|css|woff2?|ico|mp4)(\?|$)/i,
];

/** Paths that tend to carry price, stock or cart state. */
const SIGNAL = [
  /redsky/i,
  /sapphire/i,
  /graphql/i,
  /\/(pdp|product|item|sku|offer)s?[_/]/i,
  /\/(fulfillment|availability|inventory|stock|price|pricing|promotion|status)/i,
  /\/api\//i,
];

export function isInterestingApi(url: string, contentType: string): boolean {
  if (!/json/i.test(contentType)) return false;
  if (NOISE.some((r) => r.test(url))) return false;
  return SIGNAL.some((r) => r.test(url));
}

export interface FieldPath {
  path: string;
  value: string;
  /** True when this value sits inside an object carrying the product's own id. */
  onTarget: boolean;
}

export interface CapturedCall {
  /** Unique per capture. Four POSTs to one URL are four different answers. */
  id: number;
  method: string;
  url: string;
  status: number;
  bytes: number;
  /** Request payload, when there was one — the only thing telling those four apart. */
  postData: string;
  /** How much this response looks like the answer *for the product we asked about*. */
  score: number;
  /** Does the body mention our identifier at all? */
  mentionsProduct: boolean;
  paths: FieldPath[];
  savedAs: string;
}

// Broad on the key, strict on the value. Target calls its price
// `current_retail`, not anything containing "price", so a tidy list of expected
// key names would have missed the one field the whole exercise was for.
const PRICE_KEY = /(price|retail|cost|amount|^value$|_value$)/i;
const STOCK_KEY =
  /(availab|in_?stock|out_?of_?stock|sold_?out|purchas|inventor|fulfill|shipping_options|status)/i;

/**
 * Money that isn't the product's price.
 *
 * Every one of these was in the first ranked Target output, presented as if it
 * were a price: Affirm's instalment plan, its interest, its minimum loan, and a
 * review score that happened to live under a key called `value`. Tested against
 * the whole path rather than the leaf key, because `secondary_averages[0].value`
 * is only recognisable as a rating from its parent.
 */
const NOT_A_PRICE =
  /(financ|installment|instalment|interest|loan|apr\b|affirm|klarna|afterpay|rating|review|average|tax|donation|reward|points|shipping_cost|handling|deposit|savings|discount_amount)/i;

/** Keys that identify a product. Used to tell "our item" from "an item". */
const ID_KEY = /^(tcin|sku|id|product_?id|item_?id|us_?item_?id|offer_?id|external_?id|dpci)$/i;

function plausiblePrice(v: unknown): boolean {
  if (typeof v === 'number') return v > 0 && v < 100_000;
  if (typeof v === 'string') return /^\$?\d{1,5}(\.\d{2})?$/.test(v.trim());
  return false;
}

/**
 * Pull the product's own identifier out of its URL.
 *
 * This is the anchor for everything below. Without it we can only ask "is there
 * a price in here"; with it we can ask "is there a price for *this*", which is
 * the question that actually distinguishes the product endpoint from the
 * carousel of things you might buy instead.
 */
export function extractProductKey(url: string): string | null {
  const patterns: RegExp[] = [
    /\/p\/(?:[^/]*\/)?-?\/?A-(\d{6,})/i, // target.com/p/-/A-1012644666
    /[?&]tcin=(\d{6,})/i,
    /\/ip\/(?:[^/]+\/)?(\d{8,})/i, // walmart.com/ip/Name/19988614228
    /\/product\/(\d{2,4}-\d{3,6})/i, // pokemoncenter.com/product/100-10326/...
    /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/, // amazon-style ASIN, for later
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

interface WalkOpts {
  productKey?: string | null;
  limit?: number;
  maxNodes?: number;
}

/**
 * Walk a JSON body and return the paths that look like price or stock.
 *
 * Paths inside an object that carries our product id are flagged `onTarget`,
 * and sort first. That single distinction is what separates "the price of the
 * thing you asked about" from "the price of thirty things you didn't".
 */
export function fieldPaths(body: unknown, opts: WalkOpts = {}): FieldPath[] {
  const limit = opts.limit ?? 60;
  const maxNodes = opts.maxNodes ?? 200_000;
  const key = opts.productKey ?? null;

  const out: FieldPath[] = [];
  const seen = new Set<string>();
  let nodes = 0;

  const visit = (node: unknown, path: string, depth: number, onTarget: boolean): void => {
    if (nodes > maxNodes || depth > 14) return;
    nodes += 1;

    if (Array.isArray(node)) {
      // First two entries are enough to learn the shape of a list.
      node.slice(0, 2).forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1, onTarget));
      return;
    }
    if (node === null || typeof node !== 'object') return;

    const entries = Object.entries(node as Record<string, unknown>);

    // Does this object announce itself as the product we asked about? If so,
    // everything beneath it is on target — including nested price objects.
    let here = onTarget;
    if (key && !here) {
      here = entries.some(
        ([k, v]) => ID_KEY.test(k) && typeof v !== 'object' && String(v) === key,
      );
    }

    for (const [k, value] of entries) {
      const child = path ? `${path}.${k}` : k;
      if (value === null || typeof value !== 'object') {
        if (NOT_A_PRICE.test(child)) continue;
        const priceHit = PRICE_KEY.test(k) && plausiblePrice(value);
        const stockHit =
          STOCK_KEY.test(k) && (typeof value === 'string' || typeof value === 'boolean');
        if ((priceHit || stockHit) && !seen.has(child)) {
          seen.add(child);
          out.push({ path: child, value: String(value).slice(0, 60), onTarget: here });
        }
      } else {
        visit(value, child, depth + 1, here);
      }
    }
  };

  visit(body, '', 0, false);

  // On-target first, so the useful lines survive the slice.
  out.sort((a, b) => Number(b.onTarget) - Number(a.onTarget));
  return out.slice(0, limit);
}

export interface ScoreArgs {
  paths: FieldPath[];
  bodyText: string;
  productKey: string | null;
}

/**
 * Rank a response by how much of *our* answer it holds.
 *
 * Off-target findings are capped deliberately. A recommendations carousel will
 * always out-count a single product; letting it out-score one too is how the
 * first run buried the answer under thirty other people's prices.
 */
export function scoreCall({ paths, bodyText, productKey }: ScoreArgs): number {
  const onTarget = paths.filter((p) => p.onTarget);
  const offTarget = paths.filter((p) => !p.onTarget);

  const priceWeight = (p: FieldPath): number => (PRICE_KEY.test(p.path.split('.').pop() ?? '') ? 3 : 1);

  let score = 0;
  for (const p of onTarget) score += priceWeight(p) * 8;
  score += Math.min(
    10,
    offTarget.reduce((n, p) => n + priceWeight(p), 0),
  );
  if (productKey && bodyText.includes(productKey)) score += 15;
  return score;
}

/** Short, stable filename for a captured call. Numbered, because URLs repeat. */
export function callSlug(url: string, id: number): string {
  const path = url.replace(/^https?:\/\//, '').split('?')[0] ?? url;
  return `${String(id).padStart(2, '0')}_${path.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}`;
}
