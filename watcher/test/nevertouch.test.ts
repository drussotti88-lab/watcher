/**
 * "Not from my computer" has to mean it.
 *
 * The shop toggle in the app stops watching a retailer, and that is the right
 * control for "not now". This is the other one: a local list, in the machine's
 * own config, that no Hub setting and no forgotten code path can talk round.
 *
 * The tests below are mostly about the ways a host match goes wrong, because
 * a block that is too loose looks like a network fault and a block that is too
 * tight is a promise that was not kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isBlocked, hostsFrom } from '../src/nevertouch.ts';

const PC = ['pokemoncenter.com'];

test('A HOST AND ITS SUBDOMAINS, AND NOTHING ELSE', () => {
  assert.equal(isBlocked('https://www.pokemoncenter.com/product/100-10326', PC), true);
  assert.equal(isBlocked('https://pokemoncenter.com/', PC), true);
  assert.equal(isBlocked('https://cdn.assets.pokemoncenter.com/x.js', PC), true);

  // Not the neighbours. These are the two that a naive `url.includes()` gets
  // wrong, and both would be somebody else's site.
  assert.equal(isBlocked('https://pokemoncenter.com.evil.test/', PC), false);
  assert.equal(isBlocked('https://notpokemoncenter.com/', PC), false);

  // And not a mention of the name inside an unrelated request, which is how a
  // string match turns a block into a mystery network error on another site.
  assert.equal(
    isBlocked('https://www.target.com/s?searchTerm=pokemoncenter.com', PC),
    false,
  );
  assert.equal(isBlocked('https://www.target.com/p/-/A-95267143', PC), false);
});

test('an empty list blocks nothing, and nonsense does not throw', () => {
  assert.equal(isBlocked('https://www.pokemoncenter.com/', []), false);
  assert.equal(isBlocked('not a url', PC), false);
  assert.equal(isBlocked('', PC), false);
  assert.equal(isBlocked('https://www.pokemoncenter.com/', ['', '   ']), false);
});

test('the config may say what a person would think to write', () => {
  // The app calls it "Pokemon Center". Somebody copying that into a config
  // file should not have to know it lives on pokemoncenter.com.
  assert.deepEqual(hostsFrom(['Pokemon Center']), ['pokemoncenter.com']);
  assert.deepEqual(hostsFrom(['Pokémon Center']), ['pokemoncenter.com']);
  assert.deepEqual(hostsFrom(['pokemoncenter.com']), ['pokemoncenter.com']);
  assert.deepEqual(hostsFrom(['https://www.pokemoncenter.com/x']), ['www.pokemoncenter.com']);
  assert.deepEqual(hostsFrom(undefined), []);
  assert.deepEqual(hostsFrom([]), []);

  // Duplicates collapse, so the same shop named two ways is one rule.
  assert.deepEqual(hostsFrom(['Pokemon Center', 'pokemoncenter.com']), ['pokemoncenter.com']);
});

test('THE LIST IS EMPTY BY DEFAULT', () => {
  // A watcher that silently refuses to look at a shop is worse than one that
  // looks and reports a wall — the first is indistinguishable from a bug. So
  // this is something a machine's owner turns on, and the shipped default
  // must never quietly contain anything.
  const src = readFileSync(resolve(import.meta.dirname, '../src/config.ts'), 'utf8');
  assert.match(src, /neverTouch:\s*\[\s*\]/, 'DEFAULTS.neverTouch must ship empty');

  const example = readFileSync(
    resolve(import.meta.dirname, '../watcher.config.example.json'),
    'utf8',
  );
  const parsed = JSON.parse(example) as { neverTouch?: unknown };
  assert.deepEqual(parsed.neverTouch ?? [], [], 'the example config must ship empty too');
});
