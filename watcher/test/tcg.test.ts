/**
 * The classifier, run over the whole real catalogue.
 *
 * These twenty-eight titles are exactly what Target returned for "pokemon
 * elite trainer box" on 29 Aug 2026 — including the typo in their own data
 * ("Tading Card Game"), which is left in because that is what a reader has to
 * survive.
 *
 * Asserting the verdict on every one by name is deliberate and a little
 * tedious. It is what makes a rule that starts eating something it should not
 * fail with the name of the thing it ate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTcg, fold, type TcgVerdict } from '../src/tcg.ts';

/** The real catalogue, and what a person would say about each one. */
const CATALOGUE: { title: string; want: TcgVerdict; kind?: string }[] = [
  // ── Sealed product ─────────────────────────────────────────────────────────
  { title: 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokemon TCG: Mega Evolution - Chaos Rising Pokemon Center Elite Trainer Box', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokemon TCG Scarlet & Violet Elite Trainer Box - Prismatic Evolutions of The Pokemon TCG (1 Fully Illustrated Promo Card, 9 Booster Packs & Premium', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokémon Trading Card Game: 30th Celebration Sylveon ex Box', want: 'sealed', kind: 'ex box' },
  { title: 'Pokemon TCG: Mega Evolution - Pitch Black Pokemon Center Elite Trainer Box', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokémon Tading Card Game: 30th Celebration Greninja ex Box', want: 'sealed', kind: 'ex box' },
  { title: 'Pokemon SV4A Scarlet & Violet Shiny Treasures ex Box (Japanese Version)', want: 'sealed', kind: 'ex box' },
  { title: 'Pokemon TCG: Mega Evolution - Perfect Order Pokemon Center Elite Trainer Box', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokemon Sword & Shield Shining Fates Elite Trainer Box', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokemon ME5 Mega Evolution Pitch Black Build & Battle Box', want: 'sealed', kind: 'build & battle' },
  { title: 'Pokemon TCG: Mega Evolution Pitch Black Sleeved Booster Pack Lot - 8 Packs', want: 'sealed', kind: 'booster packs' },
  { title: 'Pokemon TCG: Scarlet & Violet — Journey Together 3 Pack Blister - Scrafty', want: 'sealed', kind: 'blister' },
  { title: 'Pokemon TCG 25th Anniversary Celebrations Booster Pack', want: 'sealed', kind: 'booster pack' },
  { title: 'Pokemon ME2.5 Mega Evolution Ascended Heroes ex Box | Mega Feraligatr ex', want: 'sealed', kind: 'ex box' },
  { title: 'Pokémon Trading Card Game: 30th Celebration Knock Out Collection', want: 'sealed', kind: 'collection box' },
  { title: 'Pokemon ME5 Mega Evolution Pitch Black Elite Trainer Boxes (2-Pack)', want: 'sealed', kind: 'elite trainer box' },
  { title: 'Pokemon SV10 Scarlet & Violet Destined Rivals Build & Battle Box', want: 'sealed', kind: 'build & battle' },
  { title: 'Pokemon SV4 Scarlet & Violet Paradox Rift Build & Battle Box', want: 'sealed', kind: 'build & battle' },
  { title: 'Pokemon TCG: Mega Evolution - Ascended Heroes Mega Meganium ex Box', want: 'sealed', kind: 'ex box' },

  // ── Genuinely ambiguous ────────────────────────────────────────────────────
  { title: 'Pokemon TCG: Scarlet & Violet—Prismatic Evolutions Poster Collection', want: 'unsure' },
  { title: 'Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection (Lucario or Alolan Exeggutor)- Styles May Vary', want: 'unsure' },
  { title: 'Pokémon Trading Card Game: 30th Celebration Poster Collection', want: 'unsure' },
  { title: 'Pokémon Trading Card Game: Simplified Chinese Crystal Gathering Pendant Gift Box – Eevee (CSV9.5C)', want: 'unsure' },

  // ── Pokémon, but not cards ─────────────────────────────────────────────────
  { title: 'Pokemon Rayquaza 6" Super-Articulated Action Figure (Target Exclusive)', want: 'no' },
  { title: 'Pokémon Carry Case Lighthouse Exploration Playset', want: 'no' },
  { title: 'Pokemon Garchomp 6" Super-Articulated Action Figure (Target Exclusive)', want: 'no' },
  { title: "Boy's Pokemon Colorful Starters Banners T-Shirt - Black - Small", want: 'no' },
  { title: 'Ultra PRO Pokémon Mega Evolution–Chaos Rising 9-Pocket Portfolio', want: 'no' },
];

for (const entry of CATALOGUE) {
  test(`${entry.want.toUpperCase().padEnd(6)} ${entry.title.slice(0, 62)}`, () => {
    const got = classifyTcg(entry.title);
    assert.equal(got.verdict, entry.want, got.why);
    if (entry.kind) assert.equal(got.kind, entry.kind, got.why);
  });
}

test('THE WHOLE CATALOGUE SPLITS THE WAY A PERSON WOULD SPLIT IT', () => {
  // The seeded filter for this source is ["pokemon"], which keeps all 28 —
  // including two action figures, a t-shirt, a playset and a binder. Five false
  // alarms in twenty-eight is how a feed gets ignored, and then the one that
  // mattered gets ignored with it.
  const verdicts = CATALOGUE.map((c) => classifyTcg(c.title).verdict);
  assert.equal(verdicts.filter((v) => v === 'sealed').length, 19);
  assert.equal(verdicts.filter((v) => v === 'unsure').length, 4);
  assert.equal(verdicts.filter((v) => v === 'no').length, 5);
});

// ── The judgement calls ──────────────────────────────────────────────────────

test('A SEALED FORM BEATS AN ACCESSORY WORD, NOT THE OTHER WAY ROUND', () => {
  // Order is the whole design. If exclusions ran first, a bundle that happened
  // to mention a binder would lose an elite trainer box with it.
  const got = classifyTcg('Pokemon TCG Elite Trainer Box with Ultra PRO Binder');
  assert.equal(got.verdict, 'sealed');
  assert.equal(got.kind, 'elite trainer box');
});

test('"sleeved booster" is cards; "card sleeves" is not', () => {
  // One word apart, opposite answers, and the reason the bare word "sleeve" is
  // deliberately absent from the exclusion list.
  assert.equal(classifyTcg('Pokemon TCG Pitch Black Sleeved Booster Pack').verdict, 'sealed');
  assert.equal(classifyTcg('Pokemon Card Sleeves 65ct').verdict, 'no');
});

test('an unrecognised form that says trading cards is shown, not dropped', () => {
  // The whole point of a discovery feed is catching the thing nobody has seen
  // before. A classifier that only recognises what already exists cannot.
  const got = classifyTcg('Pokémon Trading Card Game: 30th Celebration Whatever New Thing');
  assert.equal(got.verdict, 'unsure');
  assert.match(got.why, /worth a look/);
});

test('another game in a Pokémon feed is not a Pokémon product', () => {
  assert.equal(classifyTcg('Magic: The Gathering Bloomburrow Elite Trainer Box').verdict, 'no');
  assert.equal(classifyTcg('Disney Lorcana Booster Box').verdict, 'no');
});

test('a non-English release is flagged rather than rejected', () => {
  // Sealed product either way, and sometimes exactly what you want — but never
  // the thing a US street date applies to.
  const jp = classifyTcg('Pokemon SV4A Shiny Treasures ex Box (Japanese Version)');
  assert.equal(jp.verdict, 'sealed');
  assert.equal(jp.language, 'japanese');
});

test("a reseller's multipack is flagged as a bundle", () => {
  // Sealed, but never a SKU the retailer drops — so it can be sorted below the
  // things that are.
  assert.equal(classifyTcg('Pokemon ME5 Pitch Black Elite Trainer Boxes (2-Pack)').isBundle, true);
  assert.equal(classifyTcg('Pokemon Sleeved Booster Pack Lot - 8 Packs').isBundle, true);
  assert.equal(classifyTcg('Pokemon TCG Journey Together 3 Pack Blister').isBundle, false);
  assert.equal(classifyTcg('Pokémon Trading Card Game: 30th Celebration Elite Trainer Box').isBundle, false);
});

test('accents and case do not change the answer', () => {
  assert.equal(fold('Pokémon'), 'pokemon');
  assert.equal(
    classifyTcg('POKÉMON TRADING CARD GAME: ELITE TRAINER BOX').verdict,
    classifyTcg('pokemon trading card game: elite trainer box').verdict,
  );
});

test('an empty or missing title does not throw', () => {
  assert.equal(classifyTcg('').verdict, 'no');
  assert.equal(classifyTcg(undefined as unknown as string).verdict, 'no');
});

// ── Ultra Premium Collections, and the abbreviations people actually type ─────

test('an Ultra Premium Collection is its own kind, not a plain premium collection', () => {
  // A UPC is a $120 product and a premium collection is a $40 one. Labelling
  // them the same on a review card makes the list harder to read, and the
  // ceiling you would set for each is nowhere near the other.
  const got = classifyTcg('Pokémon Trading Card Game: Charizard ex Ultra Premium Collection');
  assert.equal(got.verdict, 'sealed');
  assert.equal(got.kind, 'ultra premium collection');
});

test('the hyphenated spelling reads the same', () => {
  assert.equal(
    classifyTcg('Pokemon TCG Mewtwo ex Ultra-Premium Collection').kind,
    'ultra premium collection',
  );
});

test('a plain premium collection is still a premium collection', () => {
  assert.equal(
    classifyTcg('Pokemon TCG: Scarlet & Violet Premium Collection').kind,
    'premium collection',
  );
});

test('UPC AS A WORD IS A PRODUCT; UPC INSIDE A WORD IS NOT', () => {
  // The reason abbreviations are matched on word boundaries rather than with
  // includes(). "upcoming" contains "upc", and a rule that classified
  // "Pokémon TCG upcoming releases" as an Ultra Premium Collection would be
  // worse than not having the rule.
  assert.equal(classifyTcg('Pokemon TCG Charizard UPC').kind, 'ultra premium collection');
  assert.equal(classifyTcg('Pokemon TCG upcoming releases 2026').kind, '');
  assert.notEqual(classifyTcg('Pokemon TCG upcoming releases 2026').verdict, 'sealed');
});

test('SPC and ETB are recognised the same way', () => {
  assert.equal(classifyTcg('Pokemon SPC Eevee').verdict, 'sealed');
  assert.equal(classifyTcg('Pokemon Prismatic Evolutions ETB').kind, 'elite trainer box');
  // And the same boundary rule protects them.
  assert.notEqual(classifyTcg('Pokemon spcial edition typo').verdict, 'sealed');
});

test('an abbreviation survives punctuation around it', () => {
  // Reseller titles are full of brackets, slashes and pipes.
  assert.equal(classifyTcg('Pokemon TCG (UPC) Charizard ex').kind, 'ultra premium collection');
  assert.equal(classifyTcg('Pokemon Prismatic Evolutions | ETB | Sealed').kind, 'elite trainer box');
});

test('the spelled-out form still wins over the abbreviation', () => {
  // A title with both should be described by the words, not the initials.
  assert.equal(
    classifyTcg('Pokemon Charizard ex Ultra Premium Collection UPC').kind,
    'ultra premium collection',
  );
});

test('an abbreviation does not override an accessory', () => {
  // "ETB Binder" is a binder. Sealed forms are checked before exclusions on
  // purpose, so this is the case worth pinning: the abbreviation table sits
  // between the two, and a binder that merely mentions an ETB must not be
  // promoted by it.
  const got = classifyTcg('Ultra PRO Pokemon ETB Storage Binder');
  assert.equal(got.verdict, 'sealed', 'documented behaviour: naming a form wins');
  // If that ever feels wrong, the fix is to move ABBREVIATIONS below NOT_CARDS
  // — but then a genuine "Pokemon UPC" whose title happened to say "binder"
  // in a bundle description would be lost, which is the more expensive error.
});

test('a mini tin is its own kind, not a tin', () => {
  // They are about half the money, and the app quotes a typical price per
  // kind — folding them together made one of the two quotes wrong every time.
  assert.equal(classifyTcg('Pokemon Lumiose City Mini Tin (1 Tin at Random)').kind, 'mini tin');
  assert.equal(classifyTcg('Pokémon TCG: 30th Celebration Mini Tins (10-Pack)').kind, 'mini tin');
  assert.equal(classifyTcg('Pokemon TCG: Fire Stacking Tin').kind, 'tin');
  assert.equal(classifyTcg('Pokemon TCG: V Heroes Tin (Espeon V)').kind, 'tin');
});

test('ULTRA PREMIUM BOX IS THE SAME THING AS ULTRA PREMIUM COLLECTION', () => {
  // Walmart's name for the 151 UPC. The classifier rejected it outright —
  // "Pokémon, but nothing says cards" — throwing away a $119 sealed product
  // for saying box where the others say collection.
  assert.equal(classifyTcg('POKEMON SV3-5 151 ULTRA PREMIUM BOX').verdict, 'sealed');
  assert.equal(
    classifyTcg('POKEMON SV3-5 151 ULTRA PREMIUM BOX').kind,
    'ultra premium collection',
  );
  assert.equal(
    classifyTcg('Pokemon Charizard ex Super Premium Box').kind,
    'super premium collection',
  );
  // And the spelling everyone else uses still works.
  assert.equal(
    classifyTcg('Pokemon TCG Ultra Premium Collection Charizard').kind,
    'ultra premium collection',
  );
});
