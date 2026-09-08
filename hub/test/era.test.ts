/**
 * Telling a shelf from an archive.
 *
 * The fixture is not invented: it is Roberto's real discovery table as it
 * stood on 8 Sep 2026 — 157 finds, 136 of them Walmart, with the decision he
 * actually made on each one.
 *
 * ── What his decisions are evidence OF ──────────────────────────────────────
 *
 * Not correctness. He said so himself the day this shipped: "i dont
 * neccesarily think that what i have kept and what i have chosen forget on has
 * full authority to decide what is right and what is wrong. i may have made
 * mistakes as i was unsure in the beginning." He is right, and 35 keeps
 * against 25 forgets made in a week of learning what this catalogue even held
 * is a weak thing to call ground truth.
 *
 * So they are used here for the one thing they genuinely establish: **BLAST
 * RADIUS**. "This rule would have discarded sixteen finds he had chosen to
 * keep" is a fact about how much a rule destroys, and it is true whether or
 * not each of those sixteen was the right call. A rule that big had better be
 * standing on something better than a heuristic.
 *
 * Where a rule needs to be justified as RIGHT, the justification is a fact
 * about the world instead — Pokémon stopped printing Sword & Shield in 2023 —
 * and the test says which of the two it is leaning on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  distinctiveWords,
  currentCatalogue,
  eraOf,
  namesRetiredSeries,
  offerOf,
  band,
  MIN_CORPUS,
} from '../src/era.ts';

interface Find {
  retailer: string;
  status: string;
  state: string;
  other_offers: number | null;
  name: string;
}

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/discovery-corpus.json'), 'utf8'),
) as { discoveries: Find[] };

const firstParty = corpus.discoveries.filter((d) => d.retailer !== 'Walmart');
const walmart = corpus.discoveries.filter((d) => d.retailer === 'Walmart');
const catalogue = currentCatalogue(firstParty.map((d) => d.name));

test('the name is what survives when the form and the series are taken away', () => {
  // Both of these are Elite Trainer Boxes, both are Scarlet & Violet, and the
  // whole question is which set they are.
  assert.deepEqual(
    distinctiveWords('Pokemon Trading Card Games Scarlet & Violet 8 Surging Sparks Elite Trainer Box'),
    ['surging', 'sparks'],
  );
  assert.deepEqual(
    distinctiveWords('Pokémon Trading Card Game: 30th Celebration Elite Trainer Box'),
    ['30th', 'celebration'],
  );
  // Set codes are not names. "SAS12.5" says Sword & Shield 12.5 and nothing
  // about Crown Zenith.
  assert.deepEqual(
    distinctiveWords('Pokemon Trading Cards: SAS12.5 Crown Zenith Elite Trainer Box'),
    ['crown', 'zenith'],
  );
  // And a title that is nothing but form words has no name to compare.
  assert.deepEqual(distinctiveWords('Pokemon Trading Card Game Elite Trainer Box'), []);
});

test('THE SERIES IS NOT THE SET, WHICH IS WHY HALF THE ARCHIVE LOOKED CURRENT', () => {
  // The bug in the first version of this, pinned. "Scarlet & Violet" spans
  // nineteen sets across three years; matching on it made Surging Sparks and
  // Shrouded Fable — both thrown away by hand — look like current product.
  for (const w of ['scarlet', 'violet', 'sword', 'shield', 'sun', 'moon']) {
    assert.ok(
      !distinctiveWords('Pokemon Scarlet & Violet Sword & Shield Sun & Moon').includes(w),
      `${w} is a series word and must not identify a set`,
    );
  }
  assert.equal(eraOf('Pokemon Scarlet & Violet 8 Surging Sparks Elite Trainer Box', catalogue).era, 'old');
  assert.equal(eraOf('Pokemon Scarlet & Violet 6.5 Shrouded Fable Elite Trainer Box', catalogue).era, 'old');
});

test('THE CATALOGUE RECOGNISES ITSELF — all 21 of it', () => {
  // The check that would have caught the first version. Every product Target
  // and Pokémon Center are selling right now must come back current, or the
  // corpus is not describing the thing it was built from.
  const missed = firstParty.filter((d) => eraOf(d.name, catalogue).era !== 'current');
  assert.deepEqual(
    missed.map((d) => d.name),
    [],
    'a first-party product that does not match the first-party catalogue',
  );
  assert.ok(firstParty.length >= 20, 'and the fixture really does hold the whole catalogue');
});

test('a current set is recognised across three retailers spelling it three ways', () => {
  // Pokémon Center writes "Mega Evolution-Pitch Black", Target writes "Mega
  // Evolution Chaos Rising", Walmart writes "Mega Evolution 5 Pitch Black".
  assert.equal(eraOf('Pokemon Trading Card Games Mega Evolution 5 Pitch Black Booster Bundle', catalogue).era, 'current');
  assert.equal(eraOf('POKEMON ME2.5 ASCENDED HEROES MINI TIN', catalogue).era, 'current');
  assert.equal(eraOf('Pokemon Trading Card Games Mega Heroes Tin Latias', catalogue).era, 'current');
  assert.equal(eraOf('POKEMON 30TH CELEBRATION BOOSTER BUNDLE', catalogue).era, 'current');
});

test('AN EMPTY OR TINY CATALOGUE JUDGES NOTHING, AND SAYS SO', () => {
  // The failure this project has already shipped once: `coverage.ts` reported
  // "9 of 13 covered" while its substitution had silently failed and it was
  // testing nothing. A corpus of two would call the entire world obsolete, and
  // Discovery would go quiet during a release with no error anywhere.
  for (const size of [0, 1, MIN_CORPUS - 1]) {
    const tiny = currentCatalogue(firstParty.slice(0, size).map((d) => d.name));
    const v = eraOf('Pokemon Scarlet & Violet 8 Surging Sparks Elite Trainer Box', tiny);
    assert.equal(v.era, 'unknown', `a catalogue of ${size} must not conclude anything`);
    assert.match(v.why, /not enough to judge/);
  }
});

test('RETIRED SERIES: A FACT ABOUT POKEMON, NOT A FACT ABOUT OUR CLICKS', () => {
  // The justification for this rule is not that it agrees with anything
  // Roberto did. It is that The Pokémon Company stopped printing these lines —
  // Sword & Shield in 2023, Sun & Moon in 2019, XY in 2016 — and nothing in
  // them is coming back to a Walmart shelf. That claim needs no catalogue, no
  // corpus and nobody's opinion, and it cannot rot in the dangerous direction:
  // a series added here is finished forever.
  //
  assert.equal(namesRetiredSeries('Pokemon SAS6 Chilling Reign Elite Trainer Box'), true);
  assert.equal(namesRetiredSeries('Pokemon XY Fates Collide Elite Trainer Box'), true);
  assert.equal(namesRetiredSeries('Pokemon TCG: Sun and Moon Burning Shadows Elite Trainer Box'), true);
  assert.equal(namesRetiredSeries('Pokémon TCG: Sword & Shield 12 Silver Tempest Elite Trainer Box'), true);

  // And the direction that matters: nothing currently on sale may match.
  const wrong = firstParty.filter((d) => namesRetiredSeries(d.name));
  assert.deepEqual(wrong.map((d) => d.name), [], 'a retired-series rule must never touch live product');

  // Nor these, which are current and were kept by hand.
  assert.equal(namesRetiredSeries('Pokemon Scarlet & Violet Prismatic Evolutions Elite Trainer Box'), false);
  assert.equal(namesRetiredSeries('Pokemon Trading Card Game Scarlet & Violet 10 Destined Rivals Booster Bundle'), false);
  assert.equal(namesRetiredSeries('Pokémon TCG: Mega Evolution — Chaos Rising Elite Trainer Box'), false);
});

test('WHAT AUTO-FORGETTING WOULD COST — BLAST RADIUS, NOT CORRECTNESS', () => {
  // These counts do NOT say the rule is wrong about each row. They say how
  // much it destroys, which is a different and more useful thing: a rule
  // reaching into a third of the finds a person deliberately kept needs to be
  // standing on more than a name-matching heuristic, whether or not every one
  // of those keeps was a good call.
  const kept = walmart.filter((d) => d.status === 'kept');
  const forgotten = walmart.filter((d) => d.status === 'forgotten');
  const unreviewed = walmart.filter((d) => d.status === 'new');

  const hits = (rows: Find[]) => rows.filter((d) => namesRetiredSeries(d.name)).length;

  // Small blast radius, and the one row it does touch is a Crown Zenith tin —
  // Sword & Shield, genuinely retired, so the rule and the keep disagree and
  // the rule is right. That is the shape a safe delete has.
  assert.equal(hits(kept), 1);
  assert.ok(hits(forgotten) >= 8);
  assert.ok(hits(unreviewed) >= 20, 'clearing a quarter of the backlog nobody got to');

  // ── Why the wider rule was rejected ──
  //
  // "old era AND resellers hold the buy box" looked far more powerful and was
  // tested before it was allowed near a delete. It discards sixteen of the
  // thirty-five he kept.
  //
  // The sixteen keeps are the blast radius. What makes the verdict is that two
  // of them are Prismatic Evolutions and Destined Rivals — which he did not
  // merely click on, he asked for BY NAME on 31 Aug: "i want the latest common
  // drop items: 30th collection, destined rivals, prismatic evolutions." A
  // stated want is evidence of a kind a click is not, and a rule that deletes
  // the thing somebody asked for out loud is not a rule, it is a bug. This is
  // why era ranks and never deletes.
  const wide = kept.filter(
    (d) => eraOf(d.name, catalogue).era === 'old'
      && offerOf({ retailer: 'Walmart', state: d.state, otherOffers: d.other_offers }) === 'resellers-hold-it',
  );
  assert.ok(wide.length >= 10, 'kept as evidence: the wider rule is a bad delete, however good it looks');
});

test('the three states a Walmart find can be in', () => {
  const w = (state: string, otherOffers: number | null) =>
    offerOf({ retailer: 'Walmart', state, otherOffers });
  assert.equal(w('in', 0), 'selling');
  assert.equal(w('in', 9), 'selling', 'Walmart having it beats anyone else having it');
  assert.equal(w('out', 6), 'resellers-hold-it');
  assert.equal(w('out', 0), 'nobody-selling');
  assert.equal(w('out', null), 'nobody-selling', 'a count we never read is not a count of resellers');
  // Only Walmart puts every seller on one page, so only Walmart has this problem.
  assert.equal(offerOf({ retailer: 'Target', state: 'out', otherOffers: 4 }), 'not-walmart');
});

test('THE ORDER OF THE REVIEW LIST IS THE POINT', () => {
  const at = (over: Partial<Parameters<typeof band>[0]>) =>
    band({ retailer: 'Walmart', state: 'out', otherOffers: null, isPreOrder: false, era: 'current', ...over });

  assert.equal(at({ state: 'in' }), 0, 'buyable now');
  assert.equal(at({ isPreOrder: true }), 0, 'a published street date is news whatever else is true');
  assert.equal(at({}), 1, 'current, and nobody is selling it — the shape a restock happens to');
  assert.equal(at({ otherOffers: 6 }), 2, 'current, but the page will show a reseller');
  assert.equal(at({ era: 'unknown' }), 3, 'could not place it — shown, not hidden');
  assert.equal(at({ era: 'old' }), 4, 'no longer printed — last, and still keepable');
  assert.equal(at({ era: 'old', state: 'in' }), 0, 'except that in stock beats everything');

  // What this does to the real table: the top of the list stops being a lie.
  const ranked = walmart.map((d) => ({
    name: d.name,
    b: band({
      retailer: 'Walmart',
      state: d.state,
      otherOffers: d.other_offers,
      isPreOrder: false,
      era: eraOf(d.name, catalogue).era,
    }),
  }));
  const top = ranked.filter((r) => r.b <= 2).length;
  assert.ok(top < walmart.length / 3, `${top} of ${walmart.length} reach the top three bands`);
  assert.ok(top >= 5, 'and it does not empty the list either');
});
