/**
 * Reading a Walmart search page.
 *
 * Against a real captured response — thirty rows, twenty-nine sold by Walmart,
 * one ad module — because the two things this reader has to get right are both
 * things a hand-written fixture would never contain: the ad slot sitting in the
 * middle of the product array, and the tracking parameters glued to every URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  readWalmartSearch,
  walmartMeta,
  searchUrl,
  soldByWalmart,
  stockFromWalmart,
  nextData,
  SOLD_BY_WALMART,
} from '../src/readers/walmart-search.ts';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/walmart-search.json', import.meta.url), 'utf8'),
);
const rows = readWalmartSearch(FIXTURE);

test('THE AD SLOT IN THE PRODUCT ARRAY IS NOT A PRODUCT', () => {
  // The captured page has 30 entries and one of them is an ad module with no
  // item id and no name. It is in the same array as the products, on every
  // page. A watchlist entry called "undefined" is how you notice.
  assert.equal(FIXTURE.props.pageProps.initialData.searchResult.itemStacks[0].items.length, 30);
  assert.equal(rows.length, 29);
  for (const r of rows) {
    assert.ok(r.usItemId, 'every row has an item id');
    assert.ok(r.name, 'every row has a name');
  }
});

test('the tracking parameters are cut off the product URL', () => {
  // canonicalUrl arrives with conditionGroupCode, a JSON-encoded filters blob
  // and classType stapled on. A watchlist entry should be the product, not the
  // search that happened to find it.
  for (const r of rows) {
    assert.match(r.url, /^https:\/\/www\.walmart\.com\/ip\//);
    assert.ok(!r.url.includes('?'), `${r.url} still carries a query string`);
    assert.ok(!r.url.includes('filters='), 'no search state in a product link');
  }
});

test('a known row comes back whole', () => {
  const crown = rows.find((r) => r.usItemId === '2541703476');
  assert.ok(crown, 'the Crown Zenith ETB is in this page');
  assert.match(crown.name, /Crown Zenith/);
  assert.equal(crown.price, 49.87);
  assert.equal(crown.state, 'out');
  assert.equal(crown.sellerName, 'Walmart.com');
  assert.equal(crown.isPreOrder, false);
  assert.match(crown.imageUrl, /^https:\/\//);
});

test('the page says how many results the query has, and how many pages', () => {
  const meta = walmartMeta(FIXTURE);
  assert.equal(meta.count, 30);
  assert.equal(meta.maxPage, 1);
});

test('THE SOLD-BY FILTER IS THE WHOLE VALUE OF THIS SOURCE', () => {
  // Without facet=retailer_type:Walmart the same query returns 50 results and
  // NONE of them are Walmart's: $3,275 for a sealed case, $609 for a 151 ETB.
  // With it, 29 of 30 are Walmart.com between $39 and $55.
  assert.equal(SOLD_BY_WALMART, 'retailer_type:Walmart');
  assert.ok(searchUrl('pokemon booster box').includes('retailer_type%3AWalmart'));

  const theirs = rows.filter((r) => soldByWalmart(r.sellerName));
  assert.equal(theirs.length, 29, 'every product row on this page is Walmart-sold');

  // And the prices prove it is the real catalogue rather than the resale one.
  const priced = theirs.filter((r) => r.price !== null);
  const worst = Math.max(...priced.map((r) => r.price!));
  assert.ok(worst < 200, `nothing here should be reseller-priced, saw ${worst}`);
});

test('sold-by is checked, not merely requested', () => {
  // The facet is a request. This is the check. Target taught the lesson: a
  // marketplace listing reading as first-party defeated retailer_only on an
  // armed mission.
  assert.equal(soldByWalmart('Walmart.com'), true);
  assert.equal(soldByWalmart('walmart'), true);
  assert.equal(soldByWalmart('  Walmart.com  '), true);
  assert.equal(soldByWalmart('Rares Market'), false);
  assert.equal(soldByWalmart('931 Sports Cards'), false);
  assert.equal(soldByWalmart(''), false);
  // The one that would matter most if it were wrong.
  assert.equal(soldByWalmart('Walmart Marketplace Deals'), false);
});

test('availability is translated, and an unknown word stays unknown', () => {
  assert.equal(stockFromWalmart('IN_STOCK'), 'in');
  assert.equal(stockFromWalmart('OUT_OF_STOCK'), 'out');
  assert.equal(stockFromWalmart('RETIRED'), 'out');
  // Guessing 'in' for a word we do not know is the direction that spends money.
  assert.equal(stockFromWalmart('SOMETHING_NEW'), 'unknown');
  assert.equal(stockFromWalmart(''), 'unknown');
});

test('the search URL pages without losing the filter', () => {
  const p2 = new URL(searchUrl('pokemon tin', 2));
  assert.equal(p2.searchParams.get('q'), 'pokemon tin');
  assert.equal(p2.searchParams.get('page'), '2');
  assert.equal(p2.searchParams.get('facet'), SOLD_BY_WALMART);
  // Page 1 carries no page parameter, as Walmart's own links do not.
  assert.equal(new URL(searchUrl('pokemon tin')).searchParams.get('page'), null);
});

test('a page that is not a search result returns nothing rather than throwing', () => {
  assert.deepEqual(readWalmartSearch(null), []);
  assert.deepEqual(readWalmartSearch({}), []);
  assert.deepEqual(readWalmartSearch({ props: { pageProps: {} } }), []);
  assert.deepEqual(walmartMeta({}), { count: null, total: null, maxPage: null });
});

test('__NEXT_DATA__ is found even with the nonce attribute Walmart adds', () => {
  // A pattern expecting the tag to close right after type="application/json"
  // finds nothing here, and reports a page with no products rather than an
  // error. That cost a whole probe cycle.
  const withNonce = '<script id="__NEXT_DATA__" type="application/json" nonce="">{"a":1}</script>';
  assert.deepEqual(nextData(withNonce), { a: 1 });
  assert.equal(nextData('<html></html>'), null);
  assert.equal(nextData('<script id="__NEXT_DATA__">nope</script>'), null);
});
