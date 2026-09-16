/**
 * Whose game is this?
 *
 * Mirrored from watcher/src/franchise.ts, which is where it is edited. The two
 * apps are separate packages and scrub.ts lives the same way; a shared module
 * would need a build step neither of them has.
 *
 * ── Why the drawings feed needs this and discovery does not ─────────────────
 *
 * `classifyTcg` already refuses anything that does not say "pokemon", which
 * makes discovery Pokémon-only by construction. The drawings page is different
 * in kind: /shop/collectibles/draw is Walmart's whole collectibles shelf, and
 * they run lotteries on One Piece, Magic, Lorcana, sports boxes and Funko from
 * the same carousel. Four Pokémon drawings today is what the shelf happens to
 * hold, not a rule about what it holds.
 *
 * ── Three answers, because two would be a lie ───────────────────────────────
 *
 * The errors are not symmetrical and they are not symmetrical in the same
 * direction as everywhere else in this project:
 *
 *   - A Magic drawing in the Pokémon channel costs a glance. Annoying.
 *   - A Pokémon drawing DROPPED because its title never said "Pokémon" costs
 *     the drawing, and a lottery cannot be re-entered once the window shuts.
 *
 * So `other` is only returned when another franchise is NAMED - never as the
 * default for "did not say Pokémon". Everything else is `unknown`, which the
 * Hub holds and shows but does not push to Discord: no noise in the channel,
 * and no silent loss either. If something is being held back, it is on the
 * page saying so.
 *
 * ── The mangled é ───────────────────────────────────────────────────────────
 *
 * Folding accents is not enough. Real rows in this owner's own database are
 * named "Pok 233 Mon sv 8 5 Prismatic Evolutions" - that is `Poké` where the
 * entity &#233; was stripped to a bare number somewhere upstream of us. A
 * matcher that only knows "pokemon" and "pokémon" reads that as an unknown
 * franchise. It is the single most likely way this drops something real, so it
 * is handled first and tested by name.
 */

export type Franchise = 'pokemon' | 'other' | 'unknown';

export interface FranchiseCall {
  franchise: Franchise;
  /** The brand that was recognised, when one was. '' otherwise. */
  brand: string;
  /** The rule that decided, in words. */
  why: string;
}

/** Fold accents, case and the mangled forms of é into one comparable string. */
export function fold(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // "pok 233 mon", "pok&#233;mon", "pok#233;mon", "pok233mon" -> "pokemon".
    // The entity for é, stripped to its digits by something upstream.
    .replace(/pok\W*(&#)?233;?\W*mon/g, 'pokemon')
    // "pokmon": the é simply deleted rather than folded.
    .replace(/\bpokmon\b/g, 'pokemon')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Other people's games and brands.
 *
 * Only things that are unambiguously somebody else's. "marvel" is here and
 * "disney" is not, because Pokémon has never been Marvel and a Disney-themed
 * anything is more likely a crossover this list should not be guessing about.
 */
const RIVALS: { term: string; brand: string }[] = [
  { term: 'one piece', brand: 'One Piece' },
  { term: 'magic the gathering', brand: 'Magic: The Gathering' },
  { term: 'mtg', brand: 'Magic: The Gathering' },
  { term: 'yu gi oh', brand: 'Yu-Gi-Oh!' },
  { term: 'yugioh', brand: 'Yu-Gi-Oh!' },
  { term: 'lorcana', brand: 'Disney Lorcana' },
  { term: 'digimon', brand: 'Digimon' },
  { term: 'dragon ball', brand: 'Dragon Ball' },
  { term: 'star wars', brand: 'Star Wars' },
  { term: 'flesh and blood', brand: 'Flesh and Blood' },
  { term: 'weiss schwarz', brand: 'Weiss Schwarz' },
  { term: 'metazoo', brand: 'MetaZoo' },
  { term: 'union arena', brand: 'Union Arena' },
  { term: 'riftbound', brand: 'Riftbound' },
  { term: 'sorcery contested realm', brand: 'Sorcery' },
  { term: 'altered tcg', brand: 'Altered' },
  { term: 'gundam card game', brand: 'Gundam' },
  { term: 'marvel', brand: 'Marvel' },
  { term: 'transformers', brand: 'Transformers' },
  // Sports and collectibles that share the shelf and the word "box".
  { term: 'topps', brand: 'Topps' },
  { term: 'panini', brand: 'Panini' },
  { term: 'bowman', brand: 'Bowman' },
  { term: 'upper deck', brand: 'Upper Deck' },
  { term: 'prizm', brand: 'Panini Prizm' },
  { term: 'donruss', brand: 'Donruss' },
  { term: 'fanatics', brand: 'Fanatics' },
  { term: 'funko', brand: 'Funko' },
  { term: 'squishmallow', brand: 'Squishmallows' },
  { term: 'garbage pail kids', brand: 'Garbage Pail Kids' },
  { term: 'nba', brand: 'NBA' },
  { term: 'nfl', brand: 'NFL' },
  { term: 'mlb', brand: 'MLB' },
  { term: 'wwe', brand: 'WWE' },
  { term: 'ufc', brand: 'UFC' },
  { term: 'formula 1', brand: 'Formula 1' },
];

/**
 * Words that mean Pokémon without saying Pokémon.
 *
 * Kept short and kept to things no other franchise uses. Set names are safe -
 * nobody else ships a "Prismatic Evolutions" - and so are the species that
 * appear on box fronts. Generic form words like "elite trainer box" are NOT
 * here: other games have those too, and this table's job is identity, not form.
 */
const POKEMON_MARKERS = [
  'pokemon', 'poke ball', 'pokeball',
  'scarlet violet', 'sword shield', 'sun moon', 'prismatic evolutions',
  'destined rivals', 'paldean fates', 'surging sparks', 'twilight masquerade',
  'shrouded fable', 'stellar crown', 'paradox rift', 'obsidian flames',
  'temporal forces', 'journey together', 'black bolt', 'white flare',
  'mega evolution',
  'pikachu', 'charizard', 'eevee', 'umbreon', 'espeon', 'sylveon',
  'mewtwo', 'mew ex', 'snorlax', 'gengar', 'lugia', 'rayquaza', 'greninja',
];

/**
 * Place one title.
 *
 * Rivals are checked FIRST and Pokémon second, so a genuine crossover or a
 * comparison title ("Pokémon vs Magic bundle") lands as `other` rather than
 * being pulled into the Pokémon channel. That is the safe way round: a real
 * Pokémon drawing does not name another game in its title, and something that
 * names two is not a thing this should decide silently.
 */
export function franchiseOf(title: string): FranchiseCall {
  const hay = ' ' + fold(title) + ' ';
  if (!hay.trim()) return { franchise: 'unknown', brand: '', why: 'no title to read' };

  for (const r of RIVALS) {
    if (hay.includes(' ' + r.term + ' ') || hay.includes(' ' + r.term)) {
      return { franchise: 'other', brand: r.brand, why: 'names ' + r.brand };
    }
  }

  for (const m of POKEMON_MARKERS) {
    if (hay.includes(' ' + m)) {
      return { franchise: 'pokemon', brand: 'Pokémon', why: 'names "' + m + '"' };
    }
  }

  // Named no franchise at all. NOT dropped - see the note at the top. A
  // lottery window that shuts is not re-openable, and this is the case where
  // the title is simply unlike anything the tables have seen.
  return {
    franchise: 'unknown',
    brand: '',
    why: 'names no franchise this recognises',
  };
}

/** Shorthand for the one question the drawings feed actually asks. */
export function isPokemon(title: string): boolean {
  return franchiseOf(title).franchise === 'pokemon';
}
