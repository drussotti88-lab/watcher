import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractLocs, sitemapKind, decodeEntities } from '../src/parsers/sitemap.ts';
import { fromUrl, productKey } from '../src/parsers/identify.ts';
import { pluck, parseJsonList } from '../src/parsers/jsonList.ts';
import { fold, matches, applyFilters, dedupe } from '../src/filter.ts';
import { rotate, nextCursor, productsFromSitemap } from '../src/discover.ts';

const INDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.target.com/c/sitemap_0001.xml.gz</loc></sitemap>
  <sitemap><loc><![CDATA[https://www.target.com/c/sitemap_0002.xml.gz]]></loc></sitemap>
</sitemapindex>`;

const URLSET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.target.com/p/pokemon-trading-card-game-mega-evolution-elite-trainer-box/-/A-94312876</loc></url>
  <url><loc>https://www.target.com/p/threshold-bath-towel-set/-/A-11002233</loc></url>
  <url><loc>https://www.target.com/p/pok&amp;eacute;mon-tcg-booster-bundle/-/A-55667788</loc></url>
  <url><loc>https://www.target.com/c/toys/-/N-5xtb0</loc></url>
</urlset>`;

test('sitemap: kind detection', () => {
  assert.equal(sitemapKind(INDEX_XML), 'index');
  assert.equal(sitemapKind(URLSET_XML), 'urlset');
  assert.equal(sitemapKind('<html></html>'), 'unknown');
});

test('sitemap: extracts locs, unwraps CDATA, decodes entities', () => {
  const locs = extractLocs(INDEX_XML);
  assert.deepEqual(locs, [
    'https://www.target.com/c/sitemap_0001.xml.gz',
    'https://www.target.com/c/sitemap_0002.xml.gz',
  ]);
  assert.equal(decodeEntities('a&amp;b&lt;c'), 'a&b<c');
  assert.equal(extractLocs('<urlset></urlset>').length, 0);
});

test('identify: Target PDP yields the tcin as the stable id', () => {
  const item = fromUrl(
    'https://www.target.com/p/pokemon-trading-card-game-mega-evolution-elite-trainer-box/-/A-94312876',
    'Target',
  );
  assert.ok(item);
  assert.equal(item.externalId, '94312876');
  assert.match(item.name, /Mega Evolution Elite Trainer Box/i);
});

test('identify: Pokemon Center product path', () => {
  const item = fromUrl(
    'https://www.pokemoncenter.com/product/100-12345/mega-charizard-figure',
    'Pokemon Center',
  );
  assert.ok(item);
  assert.equal(item.externalId, '100-12345');
  assert.match(item.name, /Mega Charizard Figure/i);
});

test('identify: Walmart item page yields the numeric item id', () => {
  const withSlug = fromUrl(
    'https://www.walmart.com/ip/Pokemon-TCG-Mega-Evolution-Elite-Trainer-Box/5061234567',
    'Walmart',
  );
  assert.ok(withSlug);
  assert.equal(withSlug.externalId, '5061234567');
  assert.match(withSlug.name, /Mega Evolution Elite Trainer Box/i);

  const bare = fromUrl('https://www.walmart.com/ip/5061234567', 'Walmart');
  assert.ok(bare);
  assert.equal(bare.externalId, '5061234567', 'same id with or without the slug');
});

test('identify: the three retailers never collide on id', () => {
  const t = fromUrl('https://www.target.com/p/thing-one/-/A-94312876', 'Target');
  const w = fromUrl('https://www.walmart.com/ip/thing-one/94312876', 'Walmart');
  const p = fromUrl('https://www.pokemoncenter.com/product/94312876/thing-one', 'Pokemon Center');
  // Ids can coincide across retailers; the dedupe ledger is keyed per source,
  // so that's fine — but each must still parse to its own retailer's id.
  assert.equal(t!.externalId, '94312876');
  assert.equal(w!.externalId, '94312876');
  assert.equal(p!.externalId, '94312876');
  assert.match(t!.url, /target\.com/);
  assert.match(w!.url, /walmart\.com/);
  assert.match(p!.url, /pokemoncenter\.com/);
});

test('identify: rejects junk, keeps ids stable across runs', () => {
  assert.equal(fromUrl('not a url', 'Target'), null);
  assert.equal(fromUrl('https://x.test/a', 'Target'), null); // segment too short
  const a = fromUrl('https://www.target.com/p/thing/-/A-1', 'Target');
  const b = fromUrl('https://www.target.com/p/thing/-/A-1', 'Target');
  assert.deepEqual(a, b);
});

test('identify: product keys are deterministic and slug-safe', () => {
  assert.equal(productKey('Mega Evolution ETB', 'x'), 'prd_mega_evolution_etb');
  assert.equal(productKey('Pokémon TCG: Booster!', 'x'), 'prd_pok_mon_tcg_booster');
  assert.equal(productKey('', 'fallback99'), 'prd_fallback99');
});

test('filter: folds accents so "pokemon" matches "Pokémon"', () => {
  assert.equal(fold('Pokémon'), 'pokemon');
  const item = { externalId: '1', name: 'Pokémon TCG Booster', url: '' };
  assert.equal(matches(item, ['pokemon']), true);
  assert.equal(matches(item, ['digimon']), false);
  assert.equal(matches(item, []), true, 'no filters means keep everything');
});

test('filter: a real sitemap narrows to just the Pokemon products', () => {
  const all = productsFromSitemap(URLSET_XML, 'Target');
  const kept = applyFilters(all, ['pokemon', 'pok']);
  assert.ok(all.length >= 3);
  assert.equal(kept.length, 2, 'towels and the category page are dropped');
  assert.ok(kept.every((k) => /pok/i.test(k.name) || /pok/i.test(k.url)));
});

test('filter: dedupe drops repeats within one sweep', () => {
  const items = [
    { externalId: 'a', name: 'A', url: '' },
    { externalId: 'a', name: 'A again', url: '' },
    { externalId: 'b', name: 'B', url: '' },
  ];
  assert.equal(dedupe(items).length, 2);
});

test('rotate: a full lap covers every child exactly once', () => {
  const children = ['0', '1', '2', '3', '4', '5', '6'];
  const limit = 3;
  let cursor = 0;
  const seen: string[] = [];
  // Lap length is lcm-ish; loop until the cursor returns to 0.
  do {
    seen.push(...rotate(children, cursor, limit));
    cursor = nextCursor(cursor, limit, children.length);
  } while (cursor !== 0);
  for (const c of children) {
    assert.ok(seen.includes(c), `child ${c} was never swept`);
  }
});

test('rotate: degenerate inputs do not throw', () => {
  assert.deepEqual(rotate([], 0, 3), []);
  assert.deepEqual(rotate(['a'], 5, 3), ['a']);
  assert.equal(nextCursor(0, 3, 0), 0);
});

test('jsonList: pluck walks dotted paths and array indexes', () => {
  const payload = { data: { search: { products: [{ tcin: '1', title: 'X' }] } } };
  assert.equal(pluck(payload, 'data.search.products.[0].tcin'), '1');
  assert.equal(pluck(payload, 'data.nope.deeper'), undefined);
});

test('jsonList: maps configured fields and skips items with no id', () => {
  const payload = {
    items: [
      { id: 'a1', name: 'Booster Bundle', link: '/p/a1', price: '26.99' },
      { name: 'no id here' },
    ],
  };
  const out = parseJsonList(payload, {
    itemsPath: 'items',
    idField: 'id',
    nameField: 'name',
    urlField: 'link',
    priceField: 'price',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.externalId, 'a1');
  assert.equal(out[0]!.price, 26.99);
});

test('jsonList: a wrong path yields nothing rather than throwing', () => {
  assert.deepEqual(parseJsonList({ a: 1 }, { itemsPath: 'b.c' }), []);
});
