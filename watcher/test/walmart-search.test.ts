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
  walmartOffer,
  WALMART_SELLER_ID,
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

test('THE OTHER SELLERS ARE COUNTED, BECAUSE THEY ARE THE SURPRISE', async () => {
  // Every row here is Walmart's own listing, at Walmart's own price, out of
  // stock — and all of that is true. Then the link opens a page where a
  // marketplace seller holds the buy box at forty times the money, because
  // Walmart has none and the box falls to whoever does. Nothing was wrong with
  // the find; the warning was what was missing.
  const withOffers = rows.filter((r) => (r.otherOffers ?? 0) > 0);
  assert.ok(withOffers.length > 10, `expected most rows to have rival offers, got ${withOffers.length}`);

  const crown = rows.find((r) => r.usItemId === '2541703476');
  assert.equal(crown?.otherOffers, 6);
  assert.equal(crown?.state, 'out', "Walmart's own listing is the one out of stock");
  assert.equal(crown?.sellerName, 'Walmart.com');
  assert.equal(crown?.price, 49.87, "and the price is Walmart's, not the buy box's");
});

test('nothing on this page can be put in a basket', async () => {
  // The other half of the same fact, and the one that makes the warning
  // truthful rather than alarmist: Walmart is genuinely out of every one of
  // these, so none is buyable from Walmart at any price today.
  for (const r of rows) {
    assert.equal(r.canAddToCart, false, `${r.name} claims to be addable`);
  }
});

// ── Who is really selling this ───────────────────────────────────────────────
//
// Measured 2 Sep 2026 in a live browser. `pokemon elite trainer box`, no
// facet: 49 rows, 27 distinct seller ids, exactly one of them Walmart's. The
// other 48 were Rares Market, DealDudes, Icy Society, Troll and Toad and two
// dozen more — every one IN_STOCK with canAddToCart true, which is exactly how
// a reseller listing looks more buyable than the real thing.

test('THE SELLER ID DECIDES, BECAUSE A NAME IS A STRING A SELLER PICKED', () => {
  assert.equal(soldByWalmart('Walmart.com', WALMART_SELLER_ID), true);
  assert.equal(soldByWalmart('Walmart.com', '5811F7C53AB1...'), false, 'Rares Market');
  // Lower case, as some captures render it.
  assert.equal(soldByWalmart('', WALMART_SELLER_ID.toLowerCase()), true);
  // A reseller calling itself Walmart cannot get past the id.
  assert.equal(soldByWalmart('Walmart.com', '6AFD69479079'), false);
});

test('the name still answers when Walmart sent no id', () => {
  // Older captures and every existing fixture are in this case. Falling back
  // to the name keeps them working; falling back to `false` would empty the
  // sweep.
  assert.equal(soldByWalmart('Walmart.com'), true);
  assert.equal(soldByWalmart('Walmart', ''), true);
  assert.equal(soldByWalmart('Rares Market L.L.C.', ''), false);
  assert.equal(soldByWalmart('', ''), false);
});

test('A FIND KNOWS WHICH OF THREE THINGS IT IS', () => {
  // Walmart selling it right now.
  assert.equal(
    walmartOffer({ state: 'in', canAddToCart: true, otherOffers: null }),
    'walmart-selling',
  );
  // Walmart owns it, nobody has it. The best thing to watch — this is what a
  // restock happens to.
  assert.equal(
    walmartOffer({ state: 'out', canAddToCart: false, otherOffers: null }),
    'nobody-selling',
  );
  assert.equal(
    walmartOffer({ state: 'out', canAddToCart: false, otherOffers: 0 }),
    'nobody-selling',
  );
  // Walmart out, twelve resellers on the listing. The find will say Walmart at
  // Walmart's price and the page will show a scalper.
  assert.equal(
    walmartOffer({ state: 'out', canAddToCart: false, otherOffers: 12 }),
    'resellers-hold-it',
  );
});

test('in stock but not addable is not Walmart selling it', () => {
  // The 8pm state: IN_STOCK, Walmart.com, canAddToCart false, behind a queue.
  assert.notEqual(
    walmartOffer({ state: 'in', canAddToCart: false, otherOffers: null }),
    'walmart-selling',
  );
});

test('WALMART OUT OF STOCK CARRIES NO PRICE, AND ZERO IS NOT ONE', () => {
  // Measured 3 Sep 2026: every faceted out-of-stock row has price: 0. The
  // only price on that product page is a reseller's, and Walmart's own is
  // simply absent. A find must say nothing rather than $0.00.
  const rows = readWalmartSearch({
    props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: [{
      usItemId: '7762615377', name: 'Pokemon Stellar Crown Elite Trainer Box',
      canonicalUrl: '/ip/x/7762615377', price: 0,
      priceInfo: { currentPrice: { price: 0 } },
      availabilityStatusV2: { value: 'OUT_OF_STOCK' }, canAddToCart: false,
      sellerName: 'Walmart.com', sellerId: WALMART_SELLER_ID, additionalOfferCount: 6,
    }] }] } } } },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.price, null);
  assert.equal(rows[0]!.state, 'out');
  assert.equal(rows[0]!.otherOffers, 6);
});
