/**
 * Sitemap parsing — pure functions, no network, no platform APIs.
 *
 * Sitemaps are a published format with exactly two shapes: a <sitemapindex>
 * listing more sitemaps, or a <urlset> listing pages. Both carry their payload
 * in <loc>. That's the entire spec surface we need, so a regex extractor is
 * appropriate here rather than lazy — there is no XML tree to walk.
 */

const LOC_RE = /<loc>([\s\S]*?)<\/loc>/gi;
const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** 'index' → children are sitemaps. 'urlset' → children are pages. */
export function sitemapKind(xml: string): 'index' | 'urlset' | 'unknown' {
  const head = xml.slice(0, 4000);
  if (/<sitemapindex[\s>]/i.test(head)) return 'index';
  if (/<urlset[\s>]/i.test(head)) return 'urlset';
  return 'unknown';
}

/** Every <loc> value, trimmed, CDATA unwrapped, entities decoded. */
export function extractLocs(xml: string): string[] {
  const out: string[] = [];
  LOC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOC_RE.exec(xml)) !== null) {
    let raw = m[1] ?? '';
    const cdata = CDATA_RE.exec(raw);
    if (cdata) raw = cdata[1] ?? '';
    const value = decodeEntities(raw.trim());
    if (value) out.push(value);
  }
  return out;
}
