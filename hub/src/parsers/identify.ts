/**
 * Turning a product URL into an identity + a readable name.
 *
 * A sitemap gives you URLs and nothing else, so the name has to be recovered
 * from the slug. That's fine for the job step 1 is doing — "a SKU you have
 * never seen just appeared" — and the real name arrives later from a richer
 * source. What matters is that the *id* is stable, because it's the dedupe key.
 */
import type { Discovered } from '../types.ts';

/** Target: /p/<slug>/-/A-<tcin>  — the tcin is the stable id. */
const TARGET_TCIN = /\/-\/A-(\w+)/i;

/** Pokémon Center: /product/<sku>/<slug> or /product/<slug> */
const PC_PRODUCT = /\/product\/([^/?#]+)/i;

/** Walmart: /ip/<slug>/<itemId> — or /ip/<itemId> with no slug. */
const WALMART_IP = /\/ip\/(?:([^/?#]+)\/)?(\d{5,})/i;

function titleise(slug: string): string {
  const cleaned = slug
    .replace(/[-_+]+/g, ' ')
    .replace(/\.(html?|aspx)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .map((w) => (w.length > 2 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function lastSegment(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
}

/**
 * Best-effort identity for a product URL. Returns null when the URL clearly
 * isn't a product page, so callers can skip it rather than invent an id.
 */
export function fromUrl(rawUrl: string, retailer: string): Discovered | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const path = u.pathname;

  const tcin = TARGET_TCIN.exec(path);
  if (tcin) {
    const slug = path.split('/-/')[0]?.replace(/^\/p\//, '') ?? '';
    return {
      externalId: tcin[1]!,
      name: titleise(slug) || tcin[1]!,
      url: `${u.origin}${path}`,
    };
  }

  const wm = WALMART_IP.exec(path);
  if (wm) {
    const slug = wm[1] ?? '';
    const itemId = wm[2]!;
    return {
      externalId: itemId,
      name: titleise(slug) || itemId,
      url: `${u.origin}${path}`,
    };
  }

  const pc = PC_PRODUCT.exec(path);
  if (pc) {
    const id = pc[1]!;
    const rest = path.slice(pc.index + pc[0].length).replace(/^\//, '');
    return {
      externalId: id,
      name: titleise(rest) || titleise(id),
      url: `${u.origin}${path}`,
    };
  }

  // Generic: only treat it as a product if the path looks specific enough.
  const seg = lastSegment(path);
  if (!seg || seg.length < 3) return null;
  return {
    externalId: `${retailer}:${seg}`.toLowerCase(),
    name: titleise(seg),
    url: `${u.origin}${path}`,
  };
}

/** A stable, readable product key. Deterministic so re-runs don't fork identity. */
export function productKey(name: string, fallback: string): string {
  const base = (name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `prd_${base || 'unknown'}`;
}

/**
 * Work out both the retailer and its product id from a URL alone.
 *
 * `fromUrl` above is told which retailer it is looking at, because a sweep
 * always knows. A person pasting a link into the app does not, and asking them
 * to also type "Target" and "1012644666" is asking them to repeat what the URL
 * already says — and to get it wrong occasionally.
 *
 * Matched on hostname rather than on the path shape, because the path patterns
 * are similar enough between retailers to collide, and a listing filed under
 * the wrong retailer would be polled by the wrong reader.
 */
export interface IdentifiedListing {
  retailer: string;
  externalId: string;
  name: string;
  url: string;
}

/**
 * Host, plus the shape a *product* URL takes there.
 *
 * The product pattern is required, not optional. `fromUrl` above is deliberately
 * lenient — a sweep would rather invent an id from a path than drop a URL — and
 * that leniency accepted this:
 *
 *   https://www.target.com/c/trading-cards/-/N-5tdv0
 *
 * as a listing with the id `target:n-5tdv0`. It is a *category* page. A mission
 * pointed at it would poll a page with no product on it, forever, reporting
 * "unknown" and never explaining why. Target's own convention is the tell:
 * `A-` prefixes an item, `N-` prefixes a category, and one character is the
 * whole difference.
 */
const HOSTS: { match: RegExp; product: RegExp; retailer: string }[] = [
  { match: /(^|\.)target\.com$/i, product: /\/p\/(?:[^?#]*\/)?-\/A-\w+/i, retailer: 'Target' },
  {
    match: /(^|\.)pokemoncenter\.com$/i,
    product: /\/product\/[^/?#]+/i,
    retailer: 'Pokemon Center',
  },
  { match: /(^|\.)walmart\.com$/i, product: /\/ip\/(?:[^/?#]+\/)?\d{5,}/i, retailer: 'Walmart' },
];

export function identifyListing(rawUrl: string): IdentifiedListing | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const host = HOSTS.find((h) => h.match.test(u.hostname));
  if (!host) return null;
  if (!host.product.test(u.pathname)) return null;

  const found = fromUrl(u.toString(), host.retailer);
  if (!found?.externalId) return null;

  return {
    retailer: host.retailer,
    externalId: found.externalId,
    name: found.name,
    url: found.url || u.toString(),
  };
}
