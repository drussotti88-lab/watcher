/**
 * The per-retailer readers, tested against responses these sites really sent.
 *
 * The fixtures in test/fixtures are verbatim captures from
 * `npm run inspect`, so these are not tests of my idea of the shape — they are
 * tests of the shape. The only edit is the store's mailing address, scrubbed
 * because it is Roberto's local Target and not test data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities } from '../src/readers/types.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readTargetBodies, productNodes, stockFromStatus } from '../src/readers/target.ts';
import {
  readPokemonCenterOffers,
  stockFromAvailability,
} from '../src/readers/pokemoncenter.ts';
import {
  readWalmartNextData,
  walmartProductNode,
  stockFromWalmart,
} from '../src/readers/walmart.ts';
import { offersFromLd } from '../src/inspect.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8'));

const TCIN = '1012644666';
const targetPrice = fixture('target-price.json');
const targetFulfillment = fixture('target-fulfillment.json');

// ── Target ───────────────────────────────────────────────────────────────────

test('Target: the real captured pair reads as the page displayed it', () => {
  const r = readTargetBodies([targetPrice, targetFulfillment], TCIN);
  // The screenshot showed exactly this: $24.99, Out of stock.
  assert.equal(r.price, 24.99);
  assert.equal(r.state, 'out');
  assert.equal(r.confidence, 'exact');
  assert.equal(r.availableQuantity, 0);
});

test('Target: THE ONE THAT WOULD HAVE COST MONEY — sold_out is not stock', () => {
  // The captured body says sold_out:false on an item that is out of stock.
  // Trusting it means buying nothing at 3am. Prove we ignore it.
  const body = targetFulfillment as Record<string, unknown>;
  const raw = JSON.stringify(body);
  assert.ok(raw.includes('"sold_out":false'), 'fixture must still contain the trap');

  const r = readTargetBodies([targetPrice, targetFulfillment], TCIN);
  assert.equal(r.state, 'out', 'shipping_options.availability_status is the authority');
});

test('Target: price and stock arrive in separate responses and must be merged', () => {
  const priceOnly = readTargetBodies([targetPrice], TCIN);
  const stockOnly = readTargetBodies([targetFulfillment], TCIN);

  assert.equal(priceOnly.price, 24.99);
  assert.equal(priceOnly.state, 'unknown', 'the price response says nothing about stock');
  assert.equal(priceOnly.confidence, 'unknown');

  assert.equal(stockOnly.state, 'out');
  assert.equal(stockOnly.price, null);
  assert.equal(stockOnly.confidence, 'inferred', 'stock without a price is not exact');
});

test('Target: the product is found by tcin, not by position', () => {
  const nodes = productNodes(targetFulfillment, TCIN);
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every((n) => n.tcin === TCIN));

  // Same body, someone else's tcin: nothing.
  assert.deepEqual(productNodes(targetFulfillment, '1008749492'), []);
});

test('Target: a response about other products yields no reading at all', () => {
  const carousel = {
    modules: [
      {
        module_data: {
          recommended_products: [
            { tcin: '1008749492', redsky_product: { price: { current_retail: 69.99 } } },
          ],
        },
      },
    ],
  };
  const r = readTargetBodies([carousel], TCIN);
  assert.equal(r.state, 'unknown');
  assert.equal(r.price, null, 'never inherit a price from a different product');
  assert.match(r.note, /no product node/);
});

test('Target: an unfamiliar availability word refuses rather than guesses', () => {
  assert.equal(stockFromStatus('SOME_NEW_STATUS_2027'), 'unknown');
  assert.equal(stockFromStatus('IN_STOCK'), 'in');
  assert.equal(stockFromStatus('OUT_OF_STOCK'), 'out');
  assert.equal(stockFromStatus('PRE_ORDER_SELLABLE'), 'in');
  assert.equal(stockFromStatus('PRE_ORDER_UNSELLABLE'), 'out');
});

test('Target: IN_STOCK with nothing to promise is a contradiction, not a buy', () => {
  const body = {
    product: {
      tcin: TCIN,
      price: { current_retail: 24.99 },
      fulfillment: {
        shipping_options: { availability_status: 'IN_STOCK', available_to_promise_quantity: 0 },
      },
    },
  };
  const r = readTargetBodies([body], TCIN);
  assert.equal(r.state, 'unknown', 'the two fields disagree, so we decline to answer');
  assert.notEqual(r.confidence, 'exact');
  assert.match(r.note, /refusing/);
});

test('Target: genuinely in stock reads as in stock', () => {
  const body = {
    product: {
      tcin: TCIN,
      price: { current_retail: 24.99 },
      fulfillment: {
        shipping_options: { availability_status: 'IN_STOCK', available_to_promise_quantity: 12 },
      },
    },
  };
  const r = readTargetBodies([body], TCIN);
  assert.equal(r.state, 'in');
  assert.equal(r.confidence, 'exact');
  assert.equal(r.availableQuantity, 12);
});

test('Target: pickup availability is reported but never mistaken for shippable', () => {
  const body = {
    product: {
      tcin: TCIN,
      price: { current_retail: 24.99 },
      fulfillment: {
        shipping_options: { availability_status: 'OUT_OF_STOCK', available_to_promise_quantity: 0 },
        store_options: [{ order_pickup: { availability_status: 'IN_STOCK' } }],
      },
    },
  };
  const r = readTargetBodies([body], TCIN);
  assert.equal(r.state, 'out', 'we are tracking money owed on shipped orders');
  assert.equal(r.pickupAvailable, true, 'but it is worth knowing');
});

test('Target: a zero price is never accepted', () => {
  const body = { product: { tcin: TCIN, price: { current_retail: 0 } } };
  assert.equal(readTargetBodies([body], TCIN).price, null);
});

test('Target: no captures at all does not throw', () => {
  const r = readTargetBodies([], TCIN);
  assert.equal(r.confidence, 'unknown');
  assert.equal(r.price, null);
});

// ── Pokémon Center ───────────────────────────────────────────────────────────

const pcLd = fixture('pokemoncenter-ld.json') as unknown[];
const SKU = '100-10326';

test('Pokémon Center: the real page reads straight off its JSON-LD', () => {
  const r = readPokemonCenterOffers(offersFromLd(pcLd), SKU);
  assert.equal(r.price, 4.49);
  assert.equal(r.state, 'out');
  assert.equal(r.confidence, 'exact');
  assert.match(r.name, /Journey Together/);
});

test('Pokémon Center: the ratings-only second block never wins', () => {
  // The live page ships two Product blocks; the second has no offers and would
  // report a null price. Order must not decide the answer.
  const offers = offersFromLd(pcLd);
  assert.ok(offers.length >= 2, 'fixture still has both blocks');
  assert.ok(offers.some((o) => o.price === null), 'and the stub is still in there');

  const r = readPokemonCenterOffers([...offers].reverse(), SKU);
  assert.equal(r.price, 4.49, 'reversing the blocks changes nothing');
  assert.equal(r.state, 'out');
});

test('Pokémon Center: a page showing a different SKU is not trusted', () => {
  const r = readPokemonCenterOffers(offersFromLd(pcLd), '100-99999');
  assert.notEqual(r.confidence, 'exact');
  assert.match(r.note, /no offer for sku/);
});

test('Pokémon Center: preorder counts as buyable, backorder does not', () => {
  assert.equal(stockFromAvailability('PreOrder'), 'in');
  assert.equal(stockFromAvailability('BackOrder'), 'out');
  assert.equal(stockFromAvailability('LimitedAvailability'), 'in');
  assert.equal(stockFromAvailability('SomethingNew'), 'unknown');
});

test('Pokémon Center: an empty page does not throw', () => {
  const r = readPokemonCenterOffers([], SKU);
  assert.equal(r.confidence, 'unknown');
  assert.match(r.note, /no schema.org Product/);
});

// ── Walmart ──────────────────────────────────────────────────────────────────

const walmartNext = fixture('walmart-next-data.json');
const ITEM = '19988614228';

test('Walmart: the real page reads out of embedded state', () => {
  const r = readWalmartNextData(walmartNext, ITEM);
  assert.equal(r.price, 73.76);
  assert.equal(r.state, 'in');
  assert.equal(r.confidence, 'exact');
  assert.equal(r.orderLimit, 12);
  assert.match(r.name, /Chaos Rising/);
});

test('Walmart: THE ONE THAT WOULD HAVE OVERPAID — the seller comes back too', () => {
  // In stock, priced, buyable, and sold by a marketplace reseller at roughly
  // half again over MSRP. Price and stock alone are not enough to act on.
  const r = readWalmartNextData(walmartNext, ITEM);
  assert.equal(r.seller.kind, 'marketplace');
  assert.match(r.seller.name, /Rares Market/);
  assert.match(r.note, /marketplace seller/);
});

test('Walmart: Walmart selling it itself is a retailer, not a marketplace', () => {
  const own = {
    product: {
      usItemId: ITEM,
      sellerType: 'INTERNAL',
      sellerName: 'Walmart.com',
      availabilityStatus: 'IN_STOCK',
      priceInfo: { currentPrice: { price: 49.99 } },
    },
  };
  const r = readWalmartNextData(own, ITEM);
  assert.equal(r.seller.kind, 'retailer');
  assert.equal(r.price, 49.99);
});

test('Walmart: an unrecognised seller type is unknown, never assumed safe', () => {
  const odd = {
    product: {
      usItemId: ITEM,
      sellerType: 'SOMETHING_NEW',
      sellerName: 'Who Knows',
      availabilityStatus: 'IN_STOCK',
      priceInfo: { currentPrice: { price: 49.99 } },
    },
  };
  const r = readWalmartNextData(odd, ITEM);
  assert.equal(r.seller.kind, 'unknown');
  assert.match(r.note, /could not be identified/);
});

test('Walmart: a used listing is not the product we are watching', () => {
  const used = {
    product: {
      usItemId: ITEM,
      sellerType: 'EXTERNAL',
      sellerName: 'Someone',
      availabilityStatus: 'IN_STOCK',
      isConditionNew: false,
      conditionType: 'Pre-Owned',
      priceInfo: { currentPrice: { price: 40 } },
    },
  };
  const r = readWalmartNextData(used, ITEM);
  assert.equal(r.state, 'unknown', 'a used copy wears the same name and is not the same thing');
  assert.match(r.note, /Pre-Owned/);
});

test('Walmart: a preorder carries its release date, which Half B wants', () => {
  const pre = {
    product: {
      usItemId: ITEM,
      sellerType: 'INTERNAL',
      availabilityStatus: 'IN_STOCK',
      preOrder: { isPreOrder: true, releaseDate: '2026-09-26T04:00:00.000Z' },
      priceInfo: { currentPrice: { price: 49.99 } },
    },
  };
  const r = readWalmartNextData(pre, ITEM);
  assert.equal(r.preOrder.isPreOrder, true);
  assert.equal(r.preOrder.releaseDate, '2026-09-26T04:00:00.000Z');
});

test('Walmart: the item is found by usItemId, not by position', () => {
  assert.ok(walmartProductNode(walmartNext, ITEM));
  assert.equal(walmartProductNode(walmartNext, '19988600000'), null);
});

test('Walmart: a different item on the page is never read as ours', () => {
  const other = { product: { usItemId: '11112222', priceInfo: { currentPrice: { price: 14.99 } } } };
  const r = readWalmartNextData(other, ITEM);
  assert.equal(r.price, null);
  assert.equal(r.state, 'unknown');
  assert.match(r.note, /no product node/);
});

test('Walmart: an unfamiliar availability word refuses rather than guesses', () => {
  assert.equal(stockFromWalmart('IN_STOCK'), 'in');
  assert.equal(stockFromWalmart('OUT_OF_STOCK'), 'out');
  assert.equal(stockFromWalmart('SOME_NEW_STATUS'), 'unknown');
});

test('Walmart: a zero price is never accepted', () => {
  const free = {
    product: { usItemId: ITEM, availabilityStatus: 'IN_STOCK', priceInfo: { currentPrice: { price: 0 } } },
  };
  assert.equal(readWalmartNextData(free, ITEM).price, null);
});

test('every reader answers in the same shape', () => {
  const reads = [
    readTargetBodies([targetPrice, targetFulfillment], TCIN),
    readPokemonCenterOffers(offersFromLd(pcLd), SKU),
    readWalmartNextData(walmartNext, ITEM),
  ];
  for (const r of reads) {
    for (const key of ['name', 'price', 'state', 'confidence', 'seller', 'preOrder', 'note']) {
      assert.ok(key in r, `${key} missing from a reading`);
    }
    assert.ok(['retailer', 'marketplace', 'unknown'].includes(r.seller.kind));
  }
});

// ── Names as a person would write them ───────────────────────────────────────

test("A TITLE'S ENTITIES ARE DECODED, or the name is worse than the guess", () => {
  // Target's title arrives as "Pok&#233;mon …". Stored undecoded it looks like
  // a deliberate name rather than an obvious mistake, which is worse than the
  // slug guess it replaced.
  assert.equal(
    decodeEntities('Pok&#233;mon Trading Card Game: 30th Celebration Elite Trainer Box'),
    'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box',
  );
});

test('the entities that actually appear in product titles all decode', () => {
  assert.equal(decodeEntities('Scarlet &amp; Violet'), 'Scarlet & Violet');
  assert.equal(decodeEntities('Mega Evolution &#8212; Ascended'), 'Mega Evolution — Ascended');
  assert.equal(decodeEntities('&#x2014; dash'), '— dash');
  assert.equal(decodeEntities('Trainer&nbsp;Box'), 'Trainer Box');
  assert.equal(decodeEntities('Trainer&apos;s'), "Trainer's");
});

test('ANYTHING UNRECOGNISED IS LEFT ALONE, never guessed at', () => {
  // A wrong character is harder to notice than an obviously undecoded one.
  assert.equal(decodeEntities('100% &notarealentity; here'), '100% &notarealentity; here');
  assert.equal(decodeEntities('&#999999999;'), '&#999999999;');
  assert.equal(decodeEntities('&#0;'), '&#0;');
  assert.equal(decodeEntities('plain text'), 'plain text');
});

// ── The on-sale date ─────────────────────────────────────────────────────────
//
// The question these were written for: "what tells us something we've been
// waiting for is about to be stocked, before it goes on sale?" The answer
// turned out not to be a quantity creeping upwards — there is no such thing on
// Target, the count is 0 until the moment it is not — but a date the retailer
// publishes outright, weeks ahead, which this reader was discarding.

const streetFixture = JSON.parse(
  readFileSync(new URL('./fixtures/target-street-date.json', import.meta.url), 'utf8'),
);

// 29 Aug 2026. The day the capture was taken; the street date is 18 days out.
const CAPTURE_DAY = Date.parse('2026-08-29T12:00:00Z');

test('TARGET TELLS US THE ON-SALE DATE WHILE THE ITEM IS STILL OUT OF STOCK', async () => {
  const read = readTargetBodies([streetFixture], '1010892076', CAPTURE_DAY);

  assert.equal(read.state, 'out', 'still not buyable');
  assert.equal(read.availableQuantity, 0, 'and no stock, as always before a drop');
  assert.equal(read.preOrder.releaseDate, '2026-09-16', 'but the date was there all along');
});

test('the note says how far away it is, in days', async () => {
  // "on sale 2026-09-16" is a fact. "18d away" is the thing you act on.
  const read = readTargetBodies([streetFixture], '1010892076', CAPTURE_DAY);
  assert.match(read.note, /on sale 2026-09-16 \(18d away\)/);
});

test('AN UNRELEASED ITEM IS NOT CALLED A PRE-ORDER', async () => {
  // They are different things and they call for opposite behaviour. A
  // pre-order can be bought now for later delivery; this cannot be bought at
  // all. Saying otherwise is a lie the decision layer would act on.
  const read = readTargetBodies([streetFixture], '1010892076', CAPTURE_DAY);
  assert.equal(read.preOrder.isPreOrder, false);
  assert.equal(read.state, 'out');
});

test('A PAST STREET DATE IS HISTORY — dropped from the note AND the report', async () => {
  // Same item, read a month later. Target keeps publishing the date long after
  // it has passed (Chaos Rising carried 22 May into September), and because
  // every check overwrites the Hub's stored date, echoing it pinned a dead
  // date to the card forever. What a past date means — released, still not in
  // stock — the state already says.
  const read = readTargetBodies([streetFixture], '1010892076', Date.parse('2026-09-30T12:00:00Z'));
  assert.equal(read.preOrder.releaseDate, null, 'not reported, so it cannot overwrite the Hub');
  assert.ok(!read.note.includes('street date'), 'and not repeated on the card');
  assert.ok(!read.note.includes('away'));
});

test('release DAY still counts — today is a schedule, not history', async () => {
  // The hours logic wakes the Watcher on release day; a reader that nulled
  // today's date would sleep through the one morning that matters.
  const read = readTargetBodies([streetFixture], '1010892076', Date.parse('2026-09-16T08:00:00Z'));
  assert.equal(read.preOrder.releaseDate, '2026-09-16');
  assert.match(read.note, /on sale today/);
});

test('the purchase limit is read, and it is what the quantity is clamped to', async () => {
  // This is why "20 available" showed up on item after item: the promise count
  // is min(stock, limit). A 9 against a limit of 20 means nine. A 20 against a
  // limit of 20 means at least twenty, and possibly a pallet.
  const read = readTargetBodies([streetFixture], '1010892076', CAPTURE_DAY);
  assert.equal(read.orderLimit, 2);
  assert.match(read.note, /limit 2/);
});

test('a zero pre-order count is recorded but not shouted about', async () => {
  // Zero is the entire history of this field so far. A note on every line
  // saying so is noise; the moment it is not zero is the signal.
  const read = readTargetBodies([streetFixture], '1010892076', CAPTURE_DAY);
  assert.ok(!read.note.includes('PRE-ORDER STOCK'));
});

test('PRE-ORDER STOCK LANDING IS THE ONE NUMBER THAT MOVES BEFORE A DROP', async () => {
  // The only counter in Target's whole response that can be non-zero while the
  // item is still unbuyable: an allocation loaded against a store ahead of the
  // street date. Never seen non-zero yet — which is exactly why it is worth
  // recording rather than assuming.
  const loaded = JSON.parse(JSON.stringify(streetFixture));
  loaded.data_source_modules[0].module_data.search_response.products[0]
    .fulfillment.store_options[0].pre_order_location_available_to_promise_quantity = 36;

  const read = readTargetBodies([loaded], '1010892076', CAPTURE_DAY);
  assert.match(read.note, /PRE-ORDER STOCK 36/);
  assert.equal(read.state, 'out', 'and it still must not read as buyable');
});

test('an item with no street date reads exactly as it did before', async () => {
  // Most of the catalogue has none. This must be additive or it is a rewrite.
  const bare = JSON.parse(JSON.stringify(streetFixture));
  delete bare.data_source_modules[0].module_data.search_response.products[0].item.mmbv_content;

  const read = readTargetBodies([bare], '1010892076', CAPTURE_DAY);
  assert.equal(read.preOrder.releaseDate, null);
  assert.equal(read.preOrder.isPreOrder, false);
  assert.ok(!read.note.includes('on sale'));
});

test('a malformed street date is ignored rather than trusted', async () => {
  const bad = JSON.parse(JSON.stringify(streetFixture));
  bad.data_source_modules[0].module_data.search_response.products[0].item.mmbv_content.street_date =
    'coming soon';

  const read = readTargetBodies([bad], '1010892076', CAPTURE_DAY);
  assert.equal(read.preOrder.releaseDate, null, 'a date that is not a date is not a date');
});

// ── Target Plus ──────────────────────────────────────────────────────────────
//
// This reader used to report every target.com listing as sold by Target, on a
// comment that said "Target has no marketplace". That is false, and it mattered:
// `sellerPolicy: 'retailer_only'` is the guard that stops an armed mission
// buying from a reseller, and it compares seller.kind. Saying 'retailer' for
// everything switched the guard off on the one retailer where resellers are the
// only things in stock — 18 of 28 results in one capture, at $179 to $279
// against a $50 box.

test('TARGET MARKETPLACE LISTINGS ARE NOT REPORTED AS SOLD BY TARGET', async () => {
  const mkt = JSON.parse(JSON.stringify(streetFixture));
  const product = mkt.data_source_modules[0].module_data.search_response.products[0];
  product.item.fulfillment.is_marketplace = true;
  product.item.product_vendors = [{ vendor_name: 'Collectors Emporium' }];
  product.fulfillment.shipping_options.availability_status = 'IN_STOCK';
  product.fulfillment.shipping_options.available_to_promise_quantity = 3;
  product.price.current_retail = 219.99;

  const read = readTargetBodies([mkt], '1010892076', CAPTURE_DAY);

  assert.equal(read.seller.kind, 'marketplace', 'a reseller must not read as the retailer');
  assert.equal(read.seller.name, 'Collectors Emporium');
  assert.equal(read.state, 'in', 'it really is in stock — that is the whole trap');
});

test('a Target-sold listing still reads as first party', async () => {
  const read = readTargetBodies([streetFixture], '1010892076', CAPTURE_DAY);
  assert.equal(read.seller.kind, 'retailer');
  assert.equal(read.seller.name, 'Target');
});

test('a marketplace listing with no named vendor is still marketplace', async () => {
  // The kind is what the spending guard reads. A missing name must not
  // downgrade it to 'retailer'.
  const mkt = JSON.parse(JSON.stringify(streetFixture));
  mkt.data_source_modules[0].module_data.search_response.products[0]
    .item.fulfillment.is_marketplace = true;

  const read = readTargetBodies([mkt], '1010892076', CAPTURE_DAY);
  assert.equal(read.seller.kind, 'marketplace');
});

test('a vendor name on a first-party listing does not make it a marketplace one', async () => {
  // product_vendors turns up on Target's own items too. Only is_marketplace
  // decides; the name only labels.
  const odd = JSON.parse(JSON.stringify(streetFixture));
  odd.data_source_modules[0].module_data.search_response.products[0]
    .item.product_vendors = [{ vendor_name: 'Some Distributor' }];

  const read = readTargetBodies([odd], '1010892076', CAPTURE_DAY);
  assert.equal(read.seller.kind, 'retailer');
  assert.equal(read.seller.name, 'Target');
});

test('STOCK COUNTED BUT NOT SELLABLE IS NAMED STAGED, NOT CONTRADICTED', async () => {
  // "shipping OUT_OF_STOCK; atp 31000" reads as the reader disagreeing with
  // itself. It is not a contradiction — it is a drop being loaded in — and
  // the note now says which of the two facts is the news.
  const loaded = JSON.parse(JSON.stringify(streetFixture));
  const product =
    loaded.data_source_modules[0].module_data.search_response.products[0];
  product.fulfillment.shipping_options.available_to_promise_quantity = 31000;

  const read = readTargetBodies([loaded], '1010892076', CAPTURE_DAY);
  assert.equal(read.state, 'out', 'staged stock is still not buyable');
  assert.equal(read.availableQuantity, 31000);
  assert.match(read.note, /atp 31000 STAGED — not sellable yet/);
});

test('stock that IS sellable is just stock', async () => {
  const live = JSON.parse(JSON.stringify(streetFixture));
  const product =
    live.data_source_modules[0].module_data.search_response.products[0];
  product.fulfillment.shipping_options.availability_status = 'IN_STOCK';
  product.fulfillment.shipping_options.available_to_promise_quantity = 14;

  const read = readTargetBodies([live], '1010892076', CAPTURE_DAY);
  assert.equal(read.state, 'in');
  assert.match(read.note, /atp 14/);
  assert.doesNotMatch(read.note, /STAGED/);
});
