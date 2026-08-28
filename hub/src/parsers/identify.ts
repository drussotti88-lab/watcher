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
