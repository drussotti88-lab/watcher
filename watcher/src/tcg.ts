/**
 * Is this actually a sealed Pokémon TCG product?
 *
 * The seeded `target-tcg` source filters on `["pokemon", "pokémon"]`, which was
 * fine for a sitemap and is useless against a search page. Of twenty-eight real
 * results captured for "pokemon elite trainer box", that filter keeps two
 * action figures, a boy's t-shirt, a carry-case playset and an Ultra PRO
 * binder. A discovery feed that cries wolf five times out of twenty-eight gets
 * ignored, and then the one that mattered gets ignored with it.
 *
 * ── Three outcomes, not two ─────────────────────────────────────────────────
 *
 * The two errors here are not symmetrical. Showing you a poster collection you
 * did not want costs you two seconds. Silently dropping a real drop costs you
 * the drop. So anything this cannot place confidently comes back as `unsure`
 * and is shown to you rather than filtered away — and the corpus below is full
 * of genuinely ambiguous things, because Pokémon sells sticker collections and
 * poster collections that do contain booster packs.
 *
 * ── Written from the catalogue, not from imagination ────────────────────────
 *
 * Every rule here exists because a real captured title needed it. The test
 * file runs all twenty-eight through and asserts the verdict on each one by
 * name, so a rule that starts eating something it should not is caught by the
 * title it eats.
 */

export type TcgVerdict = 'sealed' | 'unsure' | 'no';

export interface TcgClassification {
  verdict: TcgVerdict;
  /** What kind of sealed product, when it could tell. '' otherwise. */
  kind: string;
  /** The rule that decided, in words. */
  why: string;
  /** Not the English-language retail release. */
  language: string;
  /** A reseller's multipack or lot rather than a retail SKU. */
  isBundle: boolean;
}

/** Fold accents and case so "Pokémon" and "pokemon" are one word. */
export function fold(s: string): string {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Things that are Pokémon and are not cards.
 *
 * Precise on purpose. Every one of these is a phrase that never appears in a
 * genuine sealed-product name — "figure" alone would be too broad, because a
 * set is sometimes described by the figures on the box.
 */
const NOT_CARDS: { term: string; kind: string }[] = [
  { term: 'action figure', kind: 'figure' },
  { term: 'super-articulated', kind: 'figure' },
  { term: 'plush', kind: 'plush' },
  { term: 't-shirt', kind: 'apparel' },
  { term: 'tee shirt', kind: 'apparel' },
  { term: 'hoodie', kind: 'apparel' },
  { term: 'sweatshirt', kind: 'apparel' },
  { term: 'pajama', kind: 'apparel' },
  { term: 'socks', kind: 'apparel' },
  { term: 'costume', kind: 'apparel' },
  { term: 'backpack', kind: 'bag' },
  { term: 'lunch box', kind: 'bag' },
  { term: 'carry case', kind: 'toy' },
  { term: 'playset', kind: 'toy' },
  { term: 'funko', kind: 'toy' },
  { term: 'mega construx', kind: 'toy' },
  { term: 'jigsaw', kind: 'toy' },
  { term: 'water bottle', kind: 'homeware' },
  { term: 'blanket', kind: 'homeware' },
  // Card *storage* is not cards. "sleeved booster" is checked before this, so
  // the word "sleeve" alone is deliberately not here.
  { term: 'ultra pro', kind: 'accessory' },
  { term: 'portfolio', kind: 'accessory' },
  { term: 'binder', kind: 'accessory' },
  { term: 'card sleeves', kind: 'accessory' },
  { term: 'deck protector', kind: 'accessory' },
  { term: 'deck box', kind: 'accessory' },
  { term: 'playmat', kind: 'accessory' },
  { term: 'toploader', kind: 'accessory' },
  { term: 'top loader', kind: 'accessory' },
];

/**
 * Forms that are unambiguously sealed product.
 *
 * Longest and most specific first: "elite trainer box" must win before the
 * bare word "box" is ever considered.
 */
const SEALED: { term: string; kind: string }[] = [
  { term: 'elite trainer box', kind: 'elite trainer box' },
  { term: 'elite trainer boxes', kind: 'elite trainer box' },
  { term: 'build & battle', kind: 'build & battle' },
  { term: 'build and battle', kind: 'build & battle' },
  { term: 'booster bundle', kind: 'booster bundle' },
  { term: 'booster display', kind: 'booster box' },
  { term: 'booster box', kind: 'booster box' },
  { term: 'sleeved booster', kind: 'booster packs' },
  { term: 'booster packs', kind: 'booster packs' },
  { term: 'booster pack', kind: 'booster pack' },
  { term: 'ultra premium collection', kind: 'ultra premium collection' },
  { term: 'ultra-premium collection', kind: 'ultra premium collection' },
  { term: 'super premium collection', kind: 'super premium collection' },
  { term: 'premium collection', kind: 'premium collection' },
  { term: 'knock out collection', kind: 'collection box' },
  { term: 'ex box', kind: 'ex box' },
  { term: 'v box', kind: 'v box' },
  { term: 'blister', kind: 'blister' },
  { term: 'mini tin', kind: 'tin' },
  { term: 'poke ball tin', kind: 'tin' },
  { term: 'battle deck', kind: 'deck' },
  { term: 'theme deck', kind: 'deck' },
  { term: 'starter deck', kind: 'deck' },
  { term: 'trainer toolkit', kind: 'toolkit' },
  { term: 'surprise box', kind: 'collection box' },
  { term: 'holiday calendar', kind: 'advent calendar' },
  { term: 'advent calendar', kind: 'advent calendar' },
];

/**
 * Forms that are sealed product *sometimes*.
 *
 * Pokémon really does sell poster collections and sticker collections with
 * booster packs inside, and really does sell posters and stickers on their own.
 * Neither the title nor the price reliably separates them, so these are handed
 * to a person instead of guessed at.
 */
const MAYBE: { term: string; kind: string }[] = [
  { term: 'poster collection', kind: 'poster collection' },
  { term: 'sticker collection', kind: 'sticker collection' },
  { term: 'gift box', kind: 'gift box' },
  { term: 'collection box', kind: 'collection box' },
  { term: 'special collection', kind: 'collection' },
  { term: 'collection', kind: 'collection' },
  { term: 'bundle', kind: 'bundle' },
  { term: 'tin', kind: 'tin' },
];

/**
 * Abbreviations, matched as whole words rather than as substrings.
 *
 * This table exists separately from SEALED for one reason: `includes('upc')`
 * is true of "upcoming", and a rule that quietly classified "Pokémon TCG
 * upcoming releases" as an Ultra Premium Collection would be worse than not
 * having the rule at all. Anything three letters long has to be a word.
 *
 * `spc` is left deliberately vague in its kind. The community uses it for both
 * "Special Collection" and "Super Premium Collection" depending on who is
 * writing, and inventing a distinction the source data does not make would put
 * a wrong label on the review card.
 */
const ABBREVIATIONS: { term: string; kind: string }[] = [
  { term: 'upc', kind: 'ultra premium collection' },
  { term: 'spc', kind: 'premium collection' },
  { term: 'etb', kind: 'elite trainer box' },
  { term: 'ttb', kind: 'top trainer box' },
];

/** True when `term` appears as its own word, not buried inside a longer one. */
function hasWord(hay: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(hay);
}

const LANGUAGES = ['japanese', 'chinese', 'korean', 'german', 'french', 'spanish', 'italian'];

/** A reseller's multipack. Sealed, but not a SKU the retailer ever drops. */
function bundleOf(hay: string): boolean {
  if (hay.includes(' lot')) return true;
  if (hay.includes('2-pack') || hay.includes('3-pack') || hay.includes('2 pack')) return true;
  if (hay.includes('case of')) return true;
  return false;
}

function firstMatch(
  hay: string,
  table: { term: string; kind: string }[],
): { term: string; kind: string } | null {
  for (const entry of table) if (hay.includes(entry.term)) return entry;
  return null;
}

/**
 * Place one product title.
 *
 * Order is the whole design: sealed forms are checked *before* the exclusions,
 * so a hypothetical "Elite Trainer Box Binder Bundle" is still recognised as
 * containing an elite trainer box rather than being thrown out as storage.
 * Exclusions then catch everything that named no sealed form at all.
 */
export function classifyTcg(title: string): TcgClassification {
  const hay = fold(title);
  const language = LANGUAGES.find((l) => hay.includes(l)) ?? '';
  const isBundle = bundleOf(hay);

  const blank: TcgClassification = {
    verdict: 'no',
    kind: '',
    why: '',
    language,
    isBundle,
  };

  if (!hay.trim()) return { ...blank, why: 'no title to read' };

  // It has to be Pokémon at all. A search for "elite trainer box" returns other
  // games, and a Magic box arriving in a Pokémon feed is the same false alarm
  // as a t-shirt.
  const isPokemon = hay.includes('pokemon');
  if (!isPokemon) {
    return { ...blank, why: 'not a Pokémon product' };
  }

  const sealed = firstMatch(hay, SEALED);
  if (sealed) {
    return {
      ...blank,
      verdict: 'sealed',
      kind: sealed.kind,
      why: `names a sealed form: "${sealed.term}"`,
    };
  }

  const abbreviated = ABBREVIATIONS.find((a) => hasWord(hay, a.term));
  if (abbreviated) {
    return {
      ...blank,
      verdict: 'sealed',
      kind: abbreviated.kind,
      why: `names a sealed form: "${abbreviated.term.toUpperCase()}"`,
    };
  }

  const excluded = firstMatch(hay, NOT_CARDS);
  if (excluded) {
    return {
      ...blank,
      verdict: 'no',
      kind: excluded.kind,
      why: `${excluded.kind}, not cards: "${excluded.term}"`,
    };
  }

  const maybe = firstMatch(hay, MAYBE);
  if (maybe) {
    return {
      ...blank,
      verdict: 'unsure',
      kind: maybe.kind,
      why: `"${maybe.term}" is sometimes sealed product and sometimes merchandise`,
    };
  }

  // Pokémon, no accessory word, no sealed word. Could be a new form nobody has
  // seen — which is precisely the thing a discovery feed exists to catch — so
  // it is shown rather than dropped.
  if (hay.includes('trading card') || hay.includes('tcg')) {
    return {
      ...blank,
      verdict: 'unsure',
      kind: '',
      why: 'says trading cards but names no form we recognise — worth a look',
    };
  }

  return { ...blank, verdict: 'no', why: 'Pokémon, but nothing says cards' };
}
