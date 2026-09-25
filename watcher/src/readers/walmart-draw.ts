/**
 * Reading Walmart's collectibles drawing page.
 *
 * ── What a drawing is, and why it changes the design ────────────────────────
 *
 * Walmart started selling scarce collectibles by lottery in Aug 2026. You
 * enter free, once, from one account, committing a shipping address, a payment
 * method and a quantity; after the window closes they pick at random and
 * PLACE THE ORDER FOR YOU.
 *
 * Which means **speed buys nothing**. Every other reader in this project
 * exists to win a race. An entry submitted in the first second of the window
 * is worth exactly what one submitted an hour before it closes is worth, and
 * the only way to lose is to not know the window opened. So this is not a
 * fast path, and it must not be built like one: the job is to notice, early
 * and reliably, and then leave plenty of time for a person.
 *
 * ── The shape, captured 14 Sep 2026 ─────────────────────────────────────────
 *
 * `/shop/collectibles/draw` is a Next.js content page. The drawings live in a
 * content module, not in a search response:
 *
 *   props.pageProps.initialData.contentLayout.modules[]
 *     └ type: 'PrismItemCarousel'          "(USE THIS) Upcoming Drawing Item Carousel"
 *       └ configs.productsConfig.products[]
 *           usItemId, name, price, canonicalUrl, orderLimit, imageInfo
 *           showDrawCTA                     ← false while announced
 *           badges.groups[].members[]
 *             text:    'Drawing starts '
 *             slaText: 'Sep 16, 2:00pm PDT' ← the window, in words
 *
 * The module is found by the presence of `productsConfig.products`, not by its
 * index or its human name. Walmart's content team edits those — the name in
 * the capture literally begins "(USE THIS)", which is a person talking to
 * another person, and module[2] is dated June. Anchoring on either would be
 * anchoring on somebody's housekeeping.
 *
 * ── Two signals, and what to do when they disagree ──────────────────────────
 *
 * `showDrawCTA` is Walmart's own flag for "the enter button is live", and the
 * badge says in words which side of the window we are on. This reader reports
 * BOTH and refuses to invent a phase when they contradict each other, because
 * the cost of the two mistakes is not symmetrical: calling an open drawing
 * "announced" costs the drawing, and calling an announced one "open" sends
 * somebody to a page with no button and teaches them to ignore the alert.
 *
 * Only `showDrawCTA` was observed false, on an announced drawing. What it does
 * when a window opens has not been seen yet, and this file does not pretend
 * otherwise — `phase` is 'open' only when the flag says so.
 */
import type { StockState } from '../types.ts';

export type DrawPhase =
  /** Walmart has named a start time still ahead of us. */
  | 'announced'
  /** The enter button is live. */
  | 'open'
  /**
   * The window has shut. Terminal: there is nothing left to watch for.
   *
   * Worth having its own phase rather than falling through to `unknown`,
   * which is what happened until 25 Sep 2026. An ended drawing said
   * "Drawing ended", matched none of the start-time rules, came out
   * `unknown` - and `unknown` is not a state the board or the pacer knew
   * how to retire, so the row sat there labelled "announced" until Walmart
   * eventually dropped it from the carousel. A finished lottery advertised
   * as upcoming is the most misleading thing this page could say.
   */
  | 'ended'
  /** The two signals disagree, or neither said anything. */
  | 'unknown';

export interface DrawRow {
  /** Walmart's item id. What a mission is pinned to. */
  usItemId: string;
  name: string;
  url: string;
  price: number | null;
  /** Most one entry may ask for. Walmart states it per item. */
  orderLimit: number | null;
  imageUrl: string;
  phase: DrawPhase;
  /** Walmart's own flag for a live enter button. */
  showDrawCTA: boolean;
  /** "Drawing starts" / "Drawing ends", as Walmart wrote it. */
  windowLabel: string;
  /** "Sep 16, 2:00pm PDT", as Walmart wrote it. Never reformatted here. */
  windowText: string;
  /** That text resolved to an instant, or null when it could not be. */
  windowAt: string | null;
  /** Walmart's own listing, or a marketplace seller's. */
  sellerName: string;
  sellerId: string;
  state: StockState;
}

const asRecord = (v: unknown): Record<string, any> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A price is never zero. Zero is Walmart's way of saying "no offer". */
function positive(n: number | null): number | null {
  return n !== null && n > 0 ? n : null;
}

/**
 * Every product carousel on the page, wherever the content team has put it.
 *
 * Found by shape rather than by index or name: `configs.productsConfig.products`
 * is the contract, and "(USE THIS) Upcoming Drawing Item Carousel Module CC-Web"
 * is somebody's note to a colleague.
 */
export function drawModules(data: unknown): Record<string, any>[] {
  const modules = (data as any)?.props?.pageProps?.initialData?.contentLayout?.modules;
  if (!Array.isArray(modules)) return [];
  const out: Record<string, any>[] = [];
  for (const m of modules) {
    const products = asRecord(m)?.configs?.productsConfig?.products;
    if (Array.isArray(products) && products.length > 0) out.push(m);
  }
  return out;
}

/**
 * The badge that states the window.
 *
 * Walmart splits it in two — `text` is "Drawing starts " with its trailing
 * space, `slaText` is "Sep 16, 2:00pm PDT" — and joins them in the layout. A
 * reader that took only one of them would report either a label with no time
 * or a time with no idea which end of the window it is.
 */
export function windowBadge(product: unknown): { label: string; text: string } {
  const groups = asRecord(product)?.badges?.groups;
  if (!Array.isArray(groups)) return { label: '', text: '' };
  for (const g of groups) {
    const members = asRecord(g)?.members;
    if (!Array.isArray(members)) continue;
    for (const m of members) {
      const label = String(asRecord(m)?.text ?? '').trim();
      const text = String(asRecord(m)?.slaText ?? '').trim();
      if (/draw/i.test(label) || /draw/i.test(String(asRecord(m)?.key ?? ''))) {
        return { label, text };
      }
    }
  }
  return { label: '', text: '' };
}

/**
 * Walmart saying the window has shut, in the past tense.
 *
 * Past tense only. "Drawing ends" is a live drawing telling you when to be
 * done by, and reading that as over would retire a window somebody could still
 * enter - the one mistake in this file that costs a drawing rather than a
 * glance. The present tense is handled separately, and only once its stated
 * time has actually gone by.
 */
const ENDED_WORDS = /\b(ended|closed|has ended|is over|no longer)\b/i;

/** Month names, because Walmart writes the date for a person to read. */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Zones Walmart uses. Offsets in hours from UTC. */
const ZONES: Record<string, number> = {
  PDT: -7, PST: -8, MDT: -6, MST: -7, CDT: -5, CST: -6, EDT: -4, EST: -5, UTC: 0,
};

/**
 * "Sep 16, 2:00pm PDT" → an instant.
 *
 * Written out rather than handed to `Date.parse`, which accepts this shape on
 * some runtimes and returns NaN on others, and silently guesses the LOCAL zone
 * when the abbreviation is one it does not know. A countdown that is three
 * hours wrong is worse than no countdown: it is a countdown somebody trusts.
 *
 * The year is absent from the string, so the NEAREST one is used — see the
 * note at the bottom of the function for why the obvious rule is wrong.
 *
 * Returns null on anything it does not fully understand. The caller shows
 * Walmart's own words in that case, which are never wrong.
 */
export function parseDrawWhen(text: string, now: number = Date.now()): string | null {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*([A-Z]{2,4})?/i
    .exec(String(text ?? ''));
  if (!m) return null;

  const month = MONTHS[String(m[1]).slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  if (!(day >= 1 && day <= 31)) return null;

  let hour = Number(m[3]);
  if (!(hour >= 1 && hour <= 12)) return null;
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (!(minute >= 0 && minute <= 59)) return null;
  if (String(m[5]).toLowerCase() === 'p' && hour !== 12) hour += 12;
  if (String(m[5]).toLowerCase() === 'a' && hour === 12) hour = 0;

  const zone = String(m[6] ?? '').toUpperCase();
  // No zone named is not "assume ours". Walmart has always named one, and
  // guessing would be the three-hours-wrong countdown described above.
  if (!zone || !(zone in ZONES)) return null;

  // ── Which year? The nearest one. ──
  //
  // Walmart writes "Sep 16" with no year, so one has to be supplied, and the
  // obvious rule — this year, rolled forward if it looks past — is wrong in
  // January: a page read on 5 Jan saying "Dec 20" means three weeks ago, and
  // rolling forward puts it eleven months out. A test caught that, which is
  // the only reason this comment exists.
  //
  // Nearest is both simpler and right in every direction. A drawing is
  // announced days or weeks ahead and referred to for days afterwards, so the
  // reading within six months of today is always the one meant.
  const year = new Date(now).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, month, day, hour - ZONES[zone]!, minute, 0, 0);
  let when = at(year);
  for (const candidate of [at(year - 1), at(year + 1)]) {
    if (Math.abs(candidate - now) < Math.abs(when - now)) when = candidate;
  }
  return new Date(when).toISOString();
}

/** Walmart's availability vocabulary, for the few drawing rows that carry it. */
function stockOf(product: Record<string, any>): StockState {
  const raw = String(
    product?.availabilityStatus ?? product?.availabilityStatusV2?.value ?? '',
  ).toUpperCase();
  if (raw === 'IN_STOCK') return 'in';
  if (raw === 'OUT_OF_STOCK' || raw === 'RETIRED') return 'out';
  return 'unknown';
}

/**
 * Every drawing the page is advertising.
 *
 * Announced and open alike. An announced drawing is the more valuable of the
 * two here — it is the one where knowing early still changes anything.
 */
export function readWalmartDraw(data: unknown, now: number = Date.now()): DrawRow[] {
  const rows: DrawRow[] = [];
  const seen = new Set<string>();

  for (const module of drawModules(data)) {
    for (const raw of module.configs.productsConfig.products) {
      const p = asRecord(raw);
      if (!p) continue;
      const usItemId = String(p.usItemId ?? '').trim();
      const name = String(p.name ?? '').trim();
      if (!usItemId || !name || seen.has(usItemId)) continue;
      seen.add(usItemId);

      const badge = windowBadge(p);
      const windowAt = parseDrawWhen(badge.text, now);
      const cta = p.showDrawCTA === true;

      // ── The phase, and the refusal to guess it ──
      //
      // Open only when Walmart's own flag says the button is live. Announced
      // when it is not and the stated time is still ahead. Anything else is
      // unknown and says so: a drawing reported open with no button teaches
      // somebody to ignore the next alert, which is the one that mattered.
      // ── The phase, in the order the signals deserve ──
      //
      // Walmart's own flag first: if it says the button is live, the button is
      // live, whatever the badge reads. Then the past tense, which is the only
      // unambiguous statement of an end. Then a resolved end time that has
      // passed. Only then the start-time rules.
      let phase: DrawPhase = 'unknown';
      if (cta) {
        phase = 'open';
      } else if (ENDED_WORDS.test(badge.label) || ENDED_WORDS.test(badge.text)) {
        // "Drawing ended", "Drawing closed". Walmart said it in the past tense
        // and there is nothing to second-guess.
        phase = 'ended';
      } else if (
        /\bend(s|ing)?\b/i.test(badge.label) &&
        windowAt !== null &&
        Date.parse(windowAt) <= now
      ) {
        // "Drawing ends <time>" where the time has gone by. Present tense, but
        // the clock has answered. Deliberately NOT applied to a start label:
        // a start time in the past means the window opened, not that it shut.
        phase = 'ended';
      } else if (/start/i.test(badge.label) && windowAt !== null && Date.parse(windowAt) > now) {
        phase = 'announced';
      } else if (/start/i.test(badge.label) && badge.text) {
        // A start time we could not resolve is still an announcement.
        phase = windowAt === null ? 'announced' : 'unknown';
      }

      const path = String(p.canonicalUrl ?? '').trim();
      rows.push({
        usItemId,
        name,
        url: path ? `https://www.walmart.com${path.split('?')[0]}` : '',
        price: positive(num(p.price)) ?? positive(num(p.priceInfo?.currentPrice?.price)),
        orderLimit: num(p.orderLimit),
        imageUrl: String(p.imageInfo?.thumbnailUrl ?? p.image ?? '').trim(),
        phase,
        showDrawCTA: cta,
        windowLabel: badge.label,
        windowText: badge.text,
        windowAt,
        sellerName: String(p.sellerName ?? '').trim(),
        sellerId: String(p.sellerId ?? '').trim(),
        state: stockOf(p),
      });
    }
  }
  return rows;
}

/**
 * The page's own feature flag for entries.
 *
 * Worth carrying because it is the difference between "no drawings today" and
 * "Walmart has switched the whole mechanism off", and those look identical in
 * an empty list.
 */
export function drawEntryEnabled(data: unknown): boolean | null {
  const v = (data as any)?.props?.pageProps?.bootstrapData?.cv?.shared?._all_?.enableDrawEntry;
  return typeof v === 'boolean' ? v : null;
}
