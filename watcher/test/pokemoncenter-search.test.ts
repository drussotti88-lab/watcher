/**
 * Reading a whole Pokémon Center category.
 *
 * Written against a real captured page — 31 products, total 591 — because the
 * value of this reader is that it separates a 2021 battle deck nobody can buy
 * from a 30th Celebration box releasing next month, and you cannot tell whether
 * it does that from a fixture invented to make it pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  readPokemonCenterCategory,
  pokemonCenterMeta,
  rankPokemonCenter,
  worthReviewing,
  isSealedCards,
  categoryUrl,
  productUrl,
  pageCount,
  nextData,
} from '../src/readers/pokemoncenter-search.ts';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/pokemoncenter-tcg-cards.json', import.meta.url), 'utf8'),
);

const rows = readPokemonCenterCategory(FIXTURE);

test('it reads every product on the page', () => {
  assert.equal(rows.length, 31);
  for (const r of rows) {
    assert.ok(r.code, 'every row has a code');
    assert.ok(r.name, 'every row has a name');
  }
});

test('the page says how big the category is', () => {
  const meta = pokemonCenterMeta(FIXTURE);
  assert.equal(meta.total, 591);
  assert.equal(meta.startIndex, 0);
  // 591 at 32 a page. Worth asserting: this is what decides how deep to go.
  assert.equal(pageCount(meta.total), 19);
});

test('THE URL IS BUILT, NEVER TAKEN FROM THE PAGE', () => {
  // Every row's `url` field is the string "-". Trusting it would produce a
  // watchlist of links to https://www.pokemoncenter.com/-
  for (const r of rows) {
    assert.match(r.url, /^https:\/\/www\.pokemoncenter\.com\/product\//);
    assert.ok(!r.url.endsWith('/-'), 'the hyphen must not reach a URL');
  }
});

test('a known product comes back whole', () => {
  const etb = rows.find((r) => r.code === '10-10447-111');
  assert.ok(etb, 'the 30th Celebration Pokémon Center ETB is in this page');
  assert.match(etb.name, /30th Celebration/);
  assert.equal(etb.price, 59.99);
  assert.equal(etb.outOfStock, true);
  assert.equal(etb.releaseDate, '2026-07-15');
  assert.match(etb.imageUrl, /^https:\/\//);
  assert.match(etb.crumb, /TCG Cards/);
});

test('a release timestamp becomes a plain date', () => {
  // "2026-07-15T00:00:00Z" carries a midnight that is not a real time of day.
  // Keeping it would only invite a timezone bug at some later date.
  for (const r of rows) {
    if (r.releaseDate !== null) assert.match(r.releaseDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('the price is what you would pay, not the list price', () => {
  const withPrice = rows.filter((r) => r.price !== null);
  assert.ok(withPrice.length > 20, 'most rows have a price');
  for (const r of withPrice) assert.ok(r.price! > 0, `${r.name} priced at ${r.price}`);
});

test('their own crumb decides accessory or sealed, not the name', () => {
  assert.equal(isSealedCards('TRADING CARD GAME>TCG Cards>Elite Trainer Box'), true);
  assert.equal(isSealedCards('TRADING CARD GAME>TCG Accessories>Playmats'), false);
  assert.equal(isSealedCards('ACCESSORIES>Shoes'), false);
  assert.equal(isSealedCards(''), false);

  // A product in several categories at once. A sleeve that is also part of a
  // collection is still a sleeve.
  assert.equal(
    isSealedCards('TRADING CARD GAME>TCG Accessories>Card Sleeves;COLLECTIONS>30th Celebration'),
    false,
  );
  assert.equal(
    isSealedCards('TRADING CARD GAME>TCG Expansions>Journey Together;TRADING CARD GAME>TCG Cards>Booster Packs'),
    true,
  );
});

test('THE BACK CATALOGUE DOES NOT BECOME A REVIEW QUEUE', () => {
  // The whole point of ranking. Their catalogue goes back to 2020 and most of
  // it has been out of stock for years; 591 items in a review list is the same
  // as no review list.
  const verdicts = rankPokemonCenter(rows, '2026-08-30');
  const worth = worthReviewing(verdicts);

  assert.ok(worth.length > 0, 'something is worth reviewing');
  assert.ok(worth.length < rows.length, 'but not all of it');

  const dormant = verdicts.filter((v) => v.signal === 'dormant');
  assert.ok(dormant.length > 5, `expected the 2020-2022 stock to fall away, got ${dormant.length}`);

  // A 2021 battle deck, out of stock, is not a find.
  const urshifu = verdicts.find((v) => v.row.name.includes('Single Strike Urshifu'));
  assert.equal(urshifu?.signal, 'dormant');
});

test('a recent release stays in the queue even while out of stock', () => {
  // This is the restock case, and it is the one that matters most: the thing
  // sold out three weeks ago is exactly what you want to be watching.
  const verdicts = rankPokemonCenter(rows, '2026-08-30');
  const recent = verdicts.find((v) => v.row.code === '10-10447-111');
  assert.equal(recent?.signal, 'recent');
  assert.match(recent!.why, /released 2026-07-15/);
});

test('something releasing in the future is called scheduled, not recent', () => {
  const future = rankPokemonCenter(
    [{ ...rows[0]!, outOfStock: true, releaseDate: '2026-09-16', crumb: 'TRADING CARD GAME>TCG Cards' }],
    '2026-08-30',
  );
  assert.equal(future[0]!.signal, 'scheduled');
  assert.match(future[0]!.why, /17 days away/);
});

test('in stock beats every other signal', () => {
  const live = rankPokemonCenter(
    [{ ...rows[0]!, outOfStock: false, releaseDate: '2020-01-01', crumb: 'TRADING CARD GAME>TCG Cards' }],
    '2026-08-30',
  );
  // Six years old and still buyable is still buyable.
  assert.equal(live[0]!.signal, 'buyable');
});

test('the category URL leaves page 1 bare and numbers the rest', () => {
  assert.equal(categoryUrl('tcg-cards'), 'https://www.pokemoncenter.com/category/tcg-cards');
  assert.equal(categoryUrl('tcg-cards', 1), 'https://www.pokemoncenter.com/category/tcg-cards');
  assert.equal(categoryUrl('tcg-cards', 2), 'https://www.pokemoncenter.com/category/tcg-cards?page=2');
  assert.equal(categoryUrl('/tcg-cards/'), 'https://www.pokemoncenter.com/category/tcg-cards');
});

test('a product code with awkward characters still makes a usable URL', () => {
  assert.equal(productUrl('10-10447-111'), 'https://www.pokemoncenter.com/product/10-10447-111');
  assert.equal(productUrl(''), '');
  assert.equal(productUrl('  BUNDLE1198  '), 'https://www.pokemoncenter.com/product/BUNDLE1198');
});

test('a page that is not a category does not throw, it returns nothing', () => {
  // Phantom must survive a redirect to a marketing page or a challenge.
  assert.deepEqual(readPokemonCenterCategory(null), []);
  assert.deepEqual(readPokemonCenterCategory({}), []);
  assert.deepEqual(readPokemonCenterCategory({ props: { initialState: {} } }), []);
  assert.deepEqual(pokemonCenterMeta({}), { total: null, startIndex: null });
});

test('__NEXT_DATA__ is found in the page, and its absence is not a crash', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{"a":1}</script></body></html>`;
  assert.deepEqual(nextData(html), { a: 1 });
  assert.equal(nextData('<html></html>'), null);
  assert.equal(nextData('<script id="__NEXT_DATA__">not json</script>'), null);
  assert.equal(nextData(''), null);
});

// ── Sharing one plan between two shops ───────────────────────────────────────

import { interleave, todayLocal } from '../src/plan.ts';

test('the shops are interleaved so none sits behind another', () => {
  // Not a cosmetic property. Pacing is held per retailer, so if every Target
  // step came before every Pokémon Center step, Target's cooldown would be
  // Pokémon Center's cooldown too — which is the bug this replaces.
  assert.deepEqual(interleave(['t1', 't2', 't3'], ['p1', 'p2']), [
    't1', 'p1', 't2', 'p2', 't3',
  ]);
});

test('three shops interleave as evenly as two', () => {
  // There are three now. The fourth should not require touching this.
  assert.deepEqual(interleave(['t1', 't2'], ['p1', 'p2'], ['w1']), [
    't1', 'p1', 'w1', 't2', 'p2',
  ]);

  const out = interleave(
    Array.from({ length: 13 }, (_, i) => `t${i}`),
    Array.from({ length: 6 }, (_, i) => `p${i}`),
    Array.from({ length: 5 }, (_, i) => `w${i}`),
  );
  assert.equal(out.length, 24);
  assert.equal(new Set(out).size, 24, 'nothing duplicated, nothing lost');
  // Every shop gets a turn in the first handful rather than waiting for Target.
  assert.deepEqual(out.slice(0, 3), ['t0', 'p0', 'w0']);
});

test('interleaving a long list with a short one keeps every item exactly once', () => {
  const a = Array.from({ length: 13 }, (_, i) => `t${i}`);
  const b = Array.from({ length: 6 }, (_, i) => `p${i}`);
  const out = interleave(a, b);
  assert.equal(out.length, 19);
  assert.equal(new Set(out).size, 19, 'nothing duplicated, nothing lost');
  // The short list must be exhausted early rather than starved at the end.
  assert.ok(out.indexOf('p5') < 12, 'the last Pokémon Center page comes well before the end');
});

test('interleaving copes with either side being empty', () => {
  assert.deepEqual(interleave([], ['p1', 'p2']), ['p1', 'p2']);
  assert.deepEqual(interleave(['t1'], []), ['t1']);
  assert.deepEqual(interleave([], []), []);
});

test('today is read on the local calendar, not UTC', () => {
  // 7pm Central is already tomorrow in UTC, and "released 41 days ago" is a
  // judgement made on the calendar the person reading it lives on.
  const evening = new Date(2026, 7, 30, 19, 30);
  assert.equal(todayLocal(evening), '2026-08-30');
  assert.equal(todayLocal(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
});
