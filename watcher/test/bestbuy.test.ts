/**
 * Best Buy: alerts only, off until switched on, and unknown before a guess.
 *
 * Written 19 Oct 2026 from Best Buy's button wording rather than a captured
 * invite window, so most of what is pinned here is what the reader must NOT
 * say: a carousel's Add to Cart is not this product's, a label it has never
 * seen is not a state, and an open invite list is not "in stock".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readBestBuy,
  meaningOf,
  buttonsForSku,
  type PageButton,
} from '../src/readers/bestbuy.ts';
import { readFor } from '../src/read.ts';
import { retailerOn } from '../src/drop.ts';
import { hostsFrom } from '../src/nevertouch.ts';
import { judge } from '../src/watch.ts';
import { DEFAULT_SETTINGS, type Mission, type Settings } from '../src/hub.ts';
import type { Reading } from '../src/read.ts';

const SKU = '6606082';

const button = (over: Partial<PageButton> = {}): PageButton => ({
  text: 'Add to Cart', state: 'ADD_TO_CART', sku: SKU, disabled: false, inBuyBox: true, ...over,
});

const LD = [{
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Pokémon TCG: Mega Evolution Elite Trainer Box',
  sku: SKU,
  offers: { '@type': 'Offer', price: 49.99, priceCurrency: 'USD', seller: { name: 'Best Buy' } },
}];

test('AN OPEN INVITE LIST IS AN INVITE, NOT "IN STOCK"', () => {
  // Calling it in stock would fire the in-stock card at a page with no Add to
  // Cart on it. The invite has its own card.
  for (const text of ['Ask for Invite', 'Request Invite', 'Invite', 'Ask for an invitation', 'Get Invite']) {
    const r = readBestBuy({ ld: LD, buttons: [button({ text, state: '' })] }, SKU);
    assert.equal(r.invite, 'open', text);
    assert.equal(r.state, 'out', `${text}: not buyable`);
    assert.notEqual(r.addToCart, true);
  }
});

test('"INVITATION REQUESTED" IS NOT AN OPEN WINDOW', () => {
  // It contains the word the open rule looks for, which is why it is checked
  // first. Saying "go and ask" to somebody who already asked is noise.
  for (const text of ['Invitation Requested', 'Invite requested', "You're on the list"]) {
    assert.equal(readBestBuy({ ld: LD, buttons: [button({ text, state: '' })] }, SKU).invite, 'requested', text);
  }
});

test('ADD TO CART AND SOLD OUT READ AS THEMSELVES, WITH PRICE AND SELLER FROM THE MARKUP', () => {
  const inStock = readBestBuy({ ld: LD, buttons: [button()] }, SKU);
  assert.equal(inStock.state, 'in');
  assert.equal(inStock.price, 49.99);
  assert.equal(inStock.seller.kind, 'retailer');
  assert.equal(inStock.addToCart, true);
  assert.equal(inStock.invite, null);

  const gone = readBestBuy({ ld: LD, buttons: [button({ text: 'Sold Out', state: 'SOLD_OUT' })] }, SKU);
  assert.equal(gone.state, 'out');

  // A greyed-out Add to Cart is a page that will not sell.
  assert.deepEqual(meaningOf({ text: 'Add to Cart', state: '', disabled: true }), { kind: 'out' });
});

test('A LABEL THE READER HAS NEVER SEEN IS UNKNOWN, NEVER A GUESS', () => {
  const r = readBestBuy({ ld: LD, buttons: [button({ text: 'Notify me', state: 'SOMETHING_NEW' })] }, SKU);
  assert.equal(r.state, 'unknown');
  assert.equal(r.confidence, 'unknown');
  assert.equal(r.invite, null);
  assert.match(r.note, /Notify me/, 'and it says what it saw');
});

test('ANOTHER PRODUCT’S ADD TO CART IS NOT THIS ONE’S', () => {
  // Every "customers also bought" tile has its own button. One stamped with
  // a different sku is somebody else's product, whatever it says.
  const carousel = button({ sku: '9999999', inBuyBox: false });
  const r = readBestBuy({ ld: LD, buttons: [carousel] }, SKU);
  assert.equal(r.state, 'unknown');
  assert.deepEqual(buttonsForSku([carousel], SKU), []);

  // Without any sku on the page, only the buy box speaks.
  const loose = [button({ sku: '', inBuyBox: false }), button({ sku: '', inBuyBox: true, text: 'Sold Out', state: '' })];
  assert.equal(readBestBuy({ ld: LD, buttons: loose }, SKU).state, 'out');
});

test('TWO BUTTONS FOR THE SAME SKU THAT DISAGREE ARE NOT AN ANSWER', () => {
  const r = readBestBuy({ ld: LD, buttons: [button(), button({ text: 'Sold Out', state: 'SOLD_OUT' })] }, SKU);
  assert.equal(r.state, 'unknown');
});

test('A SELLER THE MARKUP DOES NOT NAME IS UNKNOWN, AND ANOTHER NAME IS A RESELLER', () => {
  const noSeller = [{ ...LD[0], offers: { price: 49.99 } }];
  assert.equal(readBestBuy({ ld: noSeller, buttons: [button()] }, SKU).seller.kind, 'unknown');
  const reseller = [{ ...LD[0], offers: { price: 89.99, seller: { name: 'Cards R Us LLC' } } }];
  assert.equal(readBestBuy({ ld: reseller, buttons: [button()] }, SKU).seller.kind, 'marketplace');
});

test('the dispatcher sends Best Buy to its own reader', () => {
  const r = readFor('Best Buy', SKU, { ld: LD, nextData: null, ogImage: '', buttons: [button({ text: 'Request Invite', state: '' })] }, []);
  assert.equal(r.invite, 'open');
  // And a scrape that carried no buttons at all is unknown, not a crash.
  assert.equal(readFor('Best Buy', SKU, { ld: LD, nextData: null, ogImage: '' }, []).state, 'unknown');
});

test('BEST BUY IS OFF UNTIL SWITCHED ON', () => {
  // Unknown shops are on by design (a new reader must not go dark), and this
  // is the one deliberate exception: starting to read another retailer from
  // this house's address is the owner's decision.
  const s = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
  assert.equal(retailerOn(s(), 'Best Buy'), false, 'off by default');
  assert.equal(retailerOn(s({ enabledRetailers: ['Best Buy'] }), 'Best Buy'), true);
  assert.equal(retailerOn(s({ enabledRetailers: ['best buy'] }), 'Best Buy'), true, 'case-blind');
  // Paused still wins, so one switch can never undo the other.
  assert.equal(retailerOn(s({ enabledRetailers: ['Best Buy'], pausedRetailers: ['Best Buy'] }), 'Best Buy'), false);
  // And nothing else changed.
  assert.equal(retailerOn(s(), 'Target'), true);
  assert.equal(retailerOn(s(), 'Costco'), true, 'an unknown shop is still on');
});

test('"Best Buy" in neverTouch means bestbuy.com', () => {
  assert.deepEqual(hostsFrom(['Best Buy']), ['bestbuy.com']);
});

test('THE INVITE TRAVELS ON THE OBSERVATION ONLY WHEN THE READER HAD AN OPINION', () => {
  const mission = {
    id: 1, listingId: 7, productKey: 'p', productName: 'ETB', retailer: 'Best Buy',
    externalId: SKU, url: 'https://www.bestbuy.com/site/x/6606082.p', enabled: true, armed: false,
    ceiling: null, quantity: 1, sellerPolicy: 'any', preOrderPolicy: 'skip',
    checkEverySeconds: 60, state: 'out', price: null, lastCheckedAt: '', checkNow: false,
  } as unknown as Mission;
  const reading = (over: Partial<Reading>): Reading => ({
    ...readBestBuy({ ld: LD, buttons: [button({ text: 'Request Invite', state: '' })] }, SKU),
    challenged: false, challengeReason: '', imageUrl: '', ms: 10, ...over,
  } as Reading);

  const v = judge(mission, reading({}));
  assert.equal(v.observation.invite, 'open');
  assert.equal(v.run, null, 'out of stock with an invite list open is not a run');
  assert.ok(!v.buy, 'and never a buy');

  // A Target reading says nothing about invites, and must not grow the field.
  const { invite: _drop, ...plain } = reading({});
  const t = judge({ ...mission, retailer: 'Target' } as Mission, plain as Reading);
  assert.equal('invite' in t.observation, false);
});
