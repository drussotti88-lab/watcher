/**
 * The price sanity check.
 *
 * The value of this is entirely in not crying wolf: first-party prices differ
 * between honest shops by ten or twenty per cent, and a flag that fires on that
 * is a flag nobody reads by the time one matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPICAL_PRICE, overTypical, FLAG_ABOVE } from '../src/msrp.ts';

test('every kind the classifier can produce has a typical price', () => {
  // Not exhaustive by accident — a kind with no entry silently shows nothing.
  for (const kind of [
    'elite trainer box', 'booster box', 'booster bundle', 'booster pack',
    'ultra premium collection', 'premium collection', 'tin', 'mini tin',
    'ex box', 'v box', 'collection box', 'deck', 'blister', 'build & battle',
  ]) {
    assert.ok(TYPICAL_PRICE[kind], `no typical price for "${kind}"`);
  }
});

test('a fair price is close to one', () => {
  // The Lumiose City mini tin at $15.95 against a typical $12.99.
  const x = overTypical('mini tin', 15.95);
  assert.ok(x !== null && x > 1.2 && x < 1.3, `got ${x}`);
  assert.ok(x! < FLAG_ABOVE, 'and is not flagged');
});

test('A RESELLER PRICE IS UNMISTAKABLE', () => {
  // The $190 Unified Minds booster box that started this.
  const x = overTypical('booster box', 190);
  assert.ok(x !== null && x > 1.1, `got ${x}`);
  // And the buy box behind it, at $3,999.99.
  assert.ok(overTypical('booster box', 3999.99)! > 24);
});

test('honest disagreement between two first-party shops is NOT flagged', () => {
  // $9.99 at Pokémon Center, $11.99 at Target, both selling it themselves.
  // A flag that fires here is a flag nobody reads when one matters.
  const x = overTypical('collection box', 11.99);
  assert.ok(x! < FLAG_ABOVE, `${x} should be under the flag threshold`);
});

test('an unknown kind claims nothing rather than guessing', () => {
  assert.equal(overTypical('', 49.99), null);
  assert.equal(overTypical('plush', 49.99), null);
  assert.equal(overTypical('some new product type', 49.99), null);
});

test('a missing or nonsense price claims nothing either', () => {
  assert.equal(overTypical('tin', null), null);
  assert.equal(overTypical('tin', 0), null);
  assert.equal(overTypical('tin', -5), null);
  assert.equal(overTypical('tin', Number.NaN), null);
});

test('the kind is matched without case getting in the way', () => {
  assert.ok(overTypical('Elite Trainer Box', 49.99) !== null);
});

test('the table cannot be edited at runtime', () => {
  // It is quoted on a card next to a price somebody sets a ceiling from.
  assert.throws(() => {
    (TYPICAL_PRICE as Record<string, number>).tin = 1;
  });
});
