/**
 * Reading a whole Pokémon Center category in one request.
 *
 * Target had to be read by listening to the calls its own JavaScript makes.
 * Pokémon Center needs none of that: the category page ships its entire result
 * set in a `__NEXT_DATA__` script tag, so one navigation gives thirty-two
 * products with price, stock, release date and image already parsed.
 *
 * ── Why this retailer matters ───────────────────────────────────────────────
 *
 * `/category/tcg-cards` is 591 products and every one of them is sealed TCG —
 * no costumes, no playmats, no mood lights. It is also where the Pokémon
 * Center *exclusives* live: the 30th Celebration Pokémon Center Elite Trainer
 * Box, the Booster Bundle, the Mini Tins ten-pack. Target will never stock
 * those, so no amount of sweeping Target harder would ever have found them.
 *
 * ── The trap in this one ────────────────────────────────────────────────────
 *
 * `product.url` is the string "-" on every row. Not a relative path, not an
 * empty string — a hyphen. Anything that trusted it would write a watchlist
 * full of links to `https://www.pokemoncenter.com/-`. The product URL has to
 * be built from the code, and `/product/<code>` redirects to the canonical
 * slug, so the code is all that is needed.
 */

/** One product as the category page describes it. */
export interface PcRow {
  /** Pokémon Center's SKU, e.g. "10-10447-111". The id everything hangs off. */
  code: string;
  name: string;
  url: string;
  price: number | null;
  /** True when it cannot be bought right now. Their field, their polarity. */
  outOfStock: boolean;
  /** ISO date, or null. Their catalogue goes back to 2020, so this matters. */
  releaseDate: string | null;
  imageUrl: string;
  /**
   * Their own category path, e.g. "TRADING CARD GAME>TCG Cards>Elite Trainer
   * Box". Several are joined with semicolons when a product sits in more than
   * one. Kept because it is a far better signal than guessing from the name.
   */
  crumb: string;
}

export interface PcMeta {
  /** How many products the category holds in total. Null when unstated. */
  total: number | null;
  /** Where this page started. Null when unstated. */
  startIndex: number | null;
}

const PAGE_SIZE = 32;

/** The category URL for one page. Page 1 carries no parameter, as theirs doesn't. */
export function categoryUrl(category: string, page = 1): string {
  const clean = String(category ?? '').replace(/^\/+|\/+$/g, '');
  const base = `https://www.pokemoncenter.com/category/${clean}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

/** How many pages a category of this size has. */
export function pageCount(total: number | null): number {
  if (!total || total < 1) return 1;
  return Math.ceil(total / PAGE_SIZE);
}

/**
 * The product page for a code.
 *
 * `/product/<code>` alone redirects to the slugged URL, so there is no need to
 * reproduce their slug rules — which would be a guess, and would rot.
 */
export function productUrl(code: string): string {
  const clean = String(code ?? '').trim();
  return clean ? `https://www.pokemoncenter.com/product/${encodeURIComponent(clean)}` : '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== '' ? n : null;
}

function isoDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  // "2026-07-15T00:00:00Z" → "2026-07-15". A date is what this is for; the
  // midnight-UTC time on it is noise that would only invite timezone bugs.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : null;
}

/** Dig the search results out of a parsed __NEXT_DATA__ blob. */
function resultsFrom(data: unknown): Record<string, unknown> | null {
  const props = (data as { props?: { initialState?: { search?: { results?: unknown } } } })?.props;
  const results = props?.initialState?.search?.results;
  return results && typeof results === 'object' ? (results as Record<string, unknown>) : null;
}

/** Pull `__NEXT_DATA__` out of the page HTML. Null when it is not there. */
export function nextData(html: string): unknown {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html ?? ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/** Everything the category page said about its products. */
export function readPokemonCenterCategory(data: unknown): PcRow[] {
  const results = resultsFrom(data);
  const products = results?.products;
  if (!Array.isArray(products)) return [];

  const rows: PcRow[] = [];
  for (const raw of products) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, any>;
    const code = String(p.code ?? '').trim();
    if (!code) continue;

    // purchasePrice is what you would pay; listPrice is the pre-discount one.
    // Preferring purchasePrice means a ceiling is judged against the real
    // number rather than against a number nobody is charging.
    const price = num(p.purchasePrice?.amount) ?? num(p.listPrice?.amount);

    const image = Array.isArray(p.images) ? p.images[0] : null;

    rows.push({
      code,
      name: String(p.name ?? '').trim(),
      url: productUrl(code),
      price,
      outOfStock: p.outOfStock === true,
      releaseDate: isoDate(p.releaseDate),
      // The thumbnail, not the full-size original: this is for a card in a
      // list, and their full-size images are several hundred kilobytes each.
      imageUrl: String(image?.thumbnail ?? image?.original ?? '').trim(),
      crumb: String(p.reportingCrumb ?? '').trim(),
    });
  }
  return rows;
}

export function pokemonCenterMeta(data: unknown): PcMeta {
  const results = resultsFrom(data);
  return {
    total: num(results?.total),
    startIndex: num(results?.startIndex),
  };
}

/**
 * Is this row sealed cards rather than an accessory?
 *
 * Their own crumb answers it, which is why this does not go near the product
 * name. "TCG Cards" is the sealed branch; "TCG Accessories" is binders, sleeves,
 * playmats and deck boxes. A product can sit in several categories at once —
 * they are joined with semicolons — so a card sleeve that is also part of a
 * collection still reads as an accessory, correctly.
 */
export function isSealedCards(crumb: string): boolean {
  const s = String(crumb ?? '').toUpperCase();
  if (!s) return false;
  return s.includes('TCG CARDS') || s.includes('TCG EXPANSIONS');
}

export type PcSignal = 'buyable' | 'scheduled' | 'recent' | 'dormant' | 'accessory';

export interface PcVerdict {
  row: PcRow;
  signal: PcSignal;
  why: string;
}

/**
 * Sort a category into what is worth reviewing and what is back catalogue.
 *
 * This exists because the alternative is 591 items in a review queue, and a
 * review queue nobody can face is the same as no review queue. Their catalogue
 * goes back to 2020 and most of it has been out of stock for years — a 2021
 * Urshifu battle deck is not a find.
 *
 * So: buyable now, or scheduled ahead, or released recently enough to still be
 * moving. Everything else is real, and remembered, and not news.
 */
export function rankPokemonCenter(rows: PcRow[], today: string, recentDays = 120): PcVerdict[] {
  const now = Date.parse(`${today}T00:00:00Z`);
  return rows.map((row) => {
    if (!isSealedCards(row.crumb)) {
      return { row, signal: 'accessory' as const, why: 'an accessory, not sealed cards' };
    }
    if (!row.outOfStock) {
      return { row, signal: 'buyable' as const, why: 'in stock at Pokémon Center' };
    }

    const released = row.releaseDate ? Date.parse(`${row.releaseDate}T00:00:00Z`) : NaN;
    if (Number.isFinite(released) && Number.isFinite(now)) {
      const days = Math.round((released - now) / 86_400_000);
      if (days > 0) {
        return { row, signal: 'scheduled' as const, why: `releases ${row.releaseDate}, ${days} days away` };
      }
      if (days > -recentDays) {
        return {
          row,
          signal: 'recent' as const,
          why: `released ${row.releaseDate}, ${Math.abs(days)} days ago — may restock`,
        };
      }
    }
    return {
      row,
      signal: 'dormant' as const,
      why: row.releaseDate ? `out since ${row.releaseDate}` : 'out of stock, no date',
    };
  });
}

/** The ones worth putting in front of a person. */
export function worthReviewing(verdicts: PcVerdict[]): PcVerdict[] {
  return verdicts.filter(
    (v) => v.signal === 'buyable' || v.signal === 'scheduled' || v.signal === 'recent',
  );
}
