/**
 * Is this a product anyone is still printing?
 *
 * ── The problem, measured ───────────────────────────────────────────────────
 *
 * 8 Sep 2026. Discovery held 136 Walmart finds. **76 of them had never been
 * reviewed**, and 25 had been thrown away. Reading the thrown-away list is what
 * named the problem: Shrouded Fable, Surging Sparks, Paldean Fates, Temporal
 * Forces, Silver Tempest, Crown Zenith, XY Fates Collide. Every one an Elite
 * Trainer Box. Every one correctly classified by `tcg.ts` as sealed Pokémon
 * product sold by Walmart.
 *
 * The classifier was right every single time. The finds were real. They were
 * just **dead** — sets from 2016 to 2024 that Walmart's catalogue still owns
 * and will never restock. A captured page of `pokemon elite trainer box` under
 * Walmart's own first-party facet returned 29 rows, all 29 out of stock, the
 * set names running from XY through Sun & Moon and the whole of Sword & Shield.
 *
 * So Walmart's faceted search is not a shelf. It is an archive with a shelf
 * buried in it, and nothing in this system could tell the two apart, because
 * "which product form is this" and "is anyone still making it" are different
 * questions and only the first one was being asked.
 *
 * ── Why the answer is not a list of sets ────────────────────────────────────
 *
 * The obvious fix is a list of current sets in a settings page. It works on
 * the day it is written and is wrong three months later, and the way you find
 * out is that Discovery went quiet during a release.
 *
 * So the current era is **derived from what Target and Pokémon Center are
 * listing first-party right now**. Those two shops carry current product and
 * essentially nothing else — Target's entire first-party sealed catalogue was
 * nine items on 31 Aug — so their catalogue *is* the definition of what is
 * being printed, and it updates itself the day a new set lands. Nothing to
 * maintain, and no month where the list is quietly stale.
 *
 * ── Why this ranks and does not delete ──────────────────────────────────────
 *
 * The first version of this was going to auto-forget anything old with
 * resellers on it. Tested against Roberto's own past decisions before it
 * shipped, that rule discarded **16 of the 35 Walmart finds he had kept**,
 * including Prismatic Evolutions and Destined Rivals — the two sets he had
 * asked for by name on 31 Aug.
 *
 * That is not a tuning problem, it is the method's ceiling: the corpus can
 * only see what Target and Pokémon Center list TODAY, and a set that is hot
 * but sold out first-party everywhere looks exactly like a set nobody wants.
 *
 * So `eraOf` is a **ranking** signal. It is the same asymmetry `tcg.ts` is
 * built on: showing a stale Elite Trainer Box costs two seconds, and dropping
 * Prismatic Evolutions costs the drop. The one thing safe to delete lives in
 * `namesRetiredSeries` below, and it is a much narrower claim.
 */

/** Fold accents and case so "Pokémon" and "pokemon" are one word. */
function fold(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Words that appear in every other title and identify nothing.
 *
 * The retailer's branding, the product form (which `tcg.ts` already reads and
 * which is orthogonal to the set), and the packaging noise Walmart writes into
 * its titles. What survives this list is the part of the name that says WHICH
 * product it is.
 */
const NOISE = new Set(
  `pokemon pokemons pokmon tcg trading card cards game games the and with for from
   elite trainer box boxes booster boosters bundle bundles display pack packs sleeved
   premium ultra super collection collections tin tins mini blister blisters deck decks
   battle build vstar vmax set sets special surprise gift poster sticker stickers tech
   knock out toolkit chest calendar holiday advent styles may vary random randomly
   selected one at new sealed official expansion item itm plus edition series wave
   includes foil oversize promo online exclusive pencil school back hanger showcase
   english deluxe easy play pieces figure cards- pks`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * A series is not a set, and matching on one is how everything looks current.
 *
 * "Scarlet & Violet" spans nineteen sets over three years. Half of Walmart's
 * archive says it, so a title sharing those two words with anything current
 * proves nothing at all — the first version of this called Surging Sparks and
 * Shrouded Fable current on exactly that evidence.
 *
 * Six entries, and one more arrives roughly every three years. That is a
 * maintenance cost this can afford; a list of SETS, which turn over quarterly,
 * is not.
 */
const SERIES: readonly (readonly [string, string])[] = [
  ['scarlet', 'violet'],
  ['sword', 'shield'],
  ['sun', 'moon'],
  ['black', 'white'],
  ['diamond', 'pearl'],
  ['mega', 'evolution'],
];

/** Set codes: sas12.5, sv4.5, sm7, me2.5. Never part of a name. */
const CODE = /^(sas|sv|sm|xy|bw|swsh|me)[0-9]*(\.[0-9]+)?$/;

/**
 * The part of a title that says which product this is.
 *
 * Everything else — brand, form, series, set code, bare numbers — is stripped,
 * because all of it is shared by products that have nothing to do with each
 * other.
 */
export function distinctiveWords(title: string): string[] {
  let hay = ` ${fold(title).replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ')} `;
  for (const [a, b] of SERIES) hay = hay.split(` ${a} ${b} `).join(' ');

  const seen = new Set<string>();
  for (const raw of hay.split(' ')) {
    const w = raw.replace(/^\.+|\.+$/g, '');
    if (!w || NOISE.has(w) || CODE.test(w)) continue;
    if (/^\d+(\.\d+)?$/.test(w)) continue;
    if (w.length < 3) continue;
    seen.add(w);
  }
  return [...seen];
}

export type Era = 'current' | 'old' | 'unknown';

export interface EraVerdict {
  era: Era;
  /** In words, for the review card and for arguing with it later. */
  why: string;
}

/**
 * The smallest catalogue this will draw a conclusion from.
 *
 * A corpus of two titles would call the entire world old, and a filter that
 * silently rejects everything is the failure mode this project has already
 * shipped once — `coverage.ts` reported "9 of 13 covered" while testing
 * nothing. So below this, every verdict is `unknown` and says why, and the
 * ranking falls back to the signals that need no catalogue.
 */
export const MIN_CORPUS = 6;

/**
 * Turn the first-party catalogue into something `eraOf` can match against.
 *
 * Pass the product names Target and Pokémon Center are currently listing. Not
 * Walmart's: Walmart is the shop being judged, and letting its archive define
 * what current means would make every set current by construction.
 */
export function currentCatalogue(titles: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const t of titles) {
    const ws = distinctiveWords(t);
    if (ws.length > 0) out.push(ws);
  }
  return out;
}

/**
 * Is this title part of the range currently being printed?
 *
 * Two shared distinctive words, which is one more than a coincidence and is
 * what "30th Celebration" or "Pitch Black" or "Ascended Heroes" costs. A
 * single word is accepted only against a corpus entry that has only one word
 * to give, so a product whose whole identity is one word is not unmatchable.
 */
export function eraOf(title: string, catalogue: readonly string[][]): EraVerdict {
  if (catalogue.length < MIN_CORPUS) {
    return {
      era: 'unknown',
      why: `only ${catalogue.length} first-party products to compare against — not enough to judge`,
    };
  }

  const ws = distinctiveWords(title);
  if (ws.length === 0) {
    return { era: 'unknown', why: 'the title is all form and no name' };
  }

  let best: { shared: string[]; against: string[] } | null = null;
  for (const entry of catalogue) {
    const shared = ws.filter((w) => entry.includes(w));
    const enough = shared.length >= 2 || (shared.length === 1 && entry.length === 1);
    if (!enough) continue;
    if (!best || shared.length > best.shared.length) best = { shared, against: entry };
  }

  if (best) {
    return {
      era: 'current',
      why: `${best.shared.join(' + ')} — also in the first-party catalogue`,
    };
  }
  return {
    era: 'old',
    why: `nothing on sale first-party shares its name (${ws.slice(0, 6).join(' ')})`,
  };
}

/**
 * Does the title name a series that stopped being printed?
 *
 * The one claim confident enough to act on without asking. Sword & Shield
 * ended in 2023, Sun & Moon in 2019, XY in 2016; nothing in those lines is
 * coming back to a Walmart shelf, and no amount of catalogue drift changes
 * that. Unlike `eraOf` this needs no corpus and cannot go stale in the
 * dangerous direction — a series added here is finished forever.
 *
 * Measured against Roberto's 136 Walmart finds before it was allowed to
 * delete anything: it catches 8 of the 25 he had already thrown away and 20 of
 * the 76 he had never got to, and touches exactly ONE of the 35 he kept — a
 * Crown Zenith tin, which is Sword & Shield and is genuinely retired. Against
 * the 21 first-party products Target and Pokémon Center are selling today it
 * matches nothing, which is the check that matters most.
 */
const RETIRED =
  /\b(sword\s*(&|and)?\s*shield|swsh\d|sas\d|sun\s*(&|and)?\s*moon|sm\d+\b|xy\b|xy\d|black\s*(&|and)\s*white|bw\d|diamond\s*(&|and)\s*pearl|call of legends|heartgold|soulsilver)/;

export function namesRetiredSeries(title: string): boolean {
  return RETIRED.test(fold(title));
}

/**
 * What a Walmart find is really offering.
 *
 * `walmartOffer()` has existed in the watcher since 2 Sep and named these
 * three states correctly, and `walmartCandidates` never called it — every row
 * went to the Hub as one undifferentiated "recent". The Hub has the two fields
 * it needs anyway (`state` and `other_offers`), so it works this out itself
 * rather than waiting for a watcher that might be an old build.
 *
 * The distinction is the whole of `walmart-buy-box.md`: `retailer_type:Walmart`
 * selects listings Walmart's catalogue OWNS, not listings Walmart is SELLING,
 * so a find can say "Walmart.com, $49.87, out of stock" — every word true —
 * and open onto a marketplace seller asking $3,999.
 */
export type Offer = 'selling' | 'nobody-selling' | 'resellers-hold-it' | 'not-walmart';

export function offerOf(row: {
  retailer: string;
  state: string;
  otherOffers: number | null;
}): Offer {
  if (row.retailer !== 'Walmart') return 'not-walmart';
  if (row.state === 'in') return 'selling';
  if ((row.otherOffers ?? 0) > 0) return 'resellers-hold-it';
  return 'nobody-selling';
}

/**
 * Where a find sits in the review list. Lower sorts first.
 *
 * The ordering is a statement about what is worth a person's attention, so it
 * is written once, here, rather than as an ORDER BY nobody can read:
 *
 *   0  buyable now, or a published street date — act today
 *   1  the retailer owns it and nobody is selling it, and it is current.
 *      **The best thing to watch**: this is the shape a restock happens to.
 *   2  current, but resellers hold the buy box. Real product, and the page
 *      will not look like the find.
 *   3  we could not place it. Shown rather than hidden, on purpose.
 *   4  no longer printed. Still here, still keepable, just last.
 */
export function band(row: {
  retailer: string;
  state: string;
  otherOffers: number | null;
  isPreOrder: boolean;
  era: Era;
}): number {
  if (row.state === 'in' || row.isPreOrder) return 0;
  const offer = offerOf(row);
  if (row.era === 'old') return 4;
  if (row.era === 'unknown') return 3;
  return offer === 'resellers-hold-it' ? 2 : 1;
}
