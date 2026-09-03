/**
 * The buy attempt, with everything expensive faked.
 *
 * Each test here is one of the ways money is lost at 3am, and the assertions
 * that matter most are about the AUTHORISATION LIFECYCLE: released when
 * nothing was bought, spent when something was, and — the hard one — left
 * alone when nobody can tell, because a grant that stays live keeps its money
 * committed and blocks a second buy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attemptBuy, type BuyDeps } from '../src/buy.ts';
import type { Mission, RunOut, Authorisation, Settings } from '../src/hub.ts';
import type { Reading } from '../src/read.ts';
import type { CartTotals } from '../src/money.ts';
import type { CartDriver } from '../src/checkout/target.ts';
import { DEFAULT_SETTINGS } from '../src/hub.ts';

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: 7,
  listingId: 3,
  productKey: 'prd_etb',
  productName: 'Mega Evolution ETB',
  retailer: 'Target',
  externalId: '111',
  url: 'https://www.target.com/p/-/A-111',
  enabled: true,
  armed: true,
  ceiling: 60,
  quantity: 1,
  sellerPolicy: 'retailer_only',
  preOrderPolicy: 'skip',
  checkEverySeconds: 60,
  state: 'in',
  price: 49.99,
  lastCheckedAt: '',
  ...over,
});

const reading = (): Reading => ({
  name: 'Mega Evolution ETB',
  state: 'in',
  confidence: 'exact',
  price: 49.99,
  seller: { kind: 'retailer', name: 'Target' },
  availableQuantity: 5,
  orderLimit: 2,
  preOrder: { isPreOrder: false, releaseDate: null },
  pickupAvailable: false,
  addToCart: null,
  note: '',
  challenged: false,
  challengeReason: '',
  imageUrl: '',
  ms: 100,
});

/** The cart a well-behaved shop would produce for this mission. */
const goodCart: CartTotals = { unitPrice: 49.99, quantity: 1, tax: 4.87, shipping: 0 };

interface World {
  resolutions: { id: number; result: string; note: string }[];
  cartActions: string[];
  authorise: Authorisation;
  cart: CartTotals;
  browserOpens: number;
  browserCloses: number;
  failAt?: 'goto' | 'addToCart' | 'readCart' | 'placeOrder';
}

function deps(world: World, over: Partial<BuyDeps> = {}): BuyDeps {
  const driver: CartDriver = {
    async addToCart() {
      if (world.failAt === 'addToCart') throw new Error('no add-to-cart button');
      world.cartActions.push('add');
    },
    async readCart() {
      if (world.failAt === 'readCart') throw new Error('cart page did not load');
      world.cartActions.push('read');
      return world.cart;
    },
    async removeFromCart() {
      world.cartActions.push('remove');
    },
    async placeOrder() {
      if (world.failAt === 'placeOrder') throw new Error('place order button missing');
      world.cartActions.push('placeOrder');
    },
  };
  const hub = {
    settings: { ...DEFAULT_SETTINGS, shippingAllowance: 5 } as Settings,
    async authorise() {
      return world.authorise;
    },
    async resolveAuthorisation(id: number, result: 'spent' | 'released', note: string) {
      world.resolutions.push({ id, result, note });
      return true;
    },
  };
  return {
    hub: hub as never,
    openBuyBrowser: async () => {
      world.browserOpens += 1;
      return {
        page: async () =>
          ({
            goto: async () => {
              if (world.failAt === 'goto') throw new Error('page would not open');
            },
          }) as never,
        close: async () => {
          world.browserCloses += 1;
        },
      };
    },
    drivers: { Target: driver },
    live: false,
    ...over,
  };
}

const world = (over: Partial<World> = {}): World => ({
  resolutions: [],
  cartActions: [],
  authorise: { granted: true, id: 42, amount: 65, reason: '' },
  cart: goodCart,
  browserOpens: 0,
  browserCloses: 0,
  ...over,
});

test('A DRY RUN GOES ALL THE WAY TO THE LINE AND RELEASES ITS GRANT', async () => {
  const w = world();
  const run = await attemptBuy(deps(w), mission(), reading());

  assert.equal(run.outcome, 'dry_run');
  assert.match(run.reason, /stopped on the line before the button/);
  assert.deepEqual(w.cartActions, ['add', 'read', 'remove'], 'and the basket is left empty');
  assert.equal(w.resolutions.length, 1);
  assert.equal(w.resolutions[0]!.result, 'released', 'nothing was bought, so the money returns');
  assert.equal(w.browserCloses, 1, 'the buy profile is closed whatever happens');
});

test('LIVE AND VERIFIED BUYS ONCE AND RESOLVES SPENT', async () => {
  const w = world();
  const run = await attemptBuy(deps(w, { live: true }), mission(), reading());

  assert.equal(run.outcome, 'bought');
  assert.deepEqual(w.cartActions, ['add', 'read', 'placeOrder']);
  assert.equal(w.resolutions[0]!.result, 'spent', 'which also disarms the mission, Hub-side');
  assert.equal(run.total, 54.86, 'the recorded total is the cart\'s, tax included');
});

test('a refused authorisation is a run, not an error — and no browser opens', async () => {
  const w = world({
    authorise: { granted: false, refusal: 'duplicate_prevented', reason: 'a live grant exists' },
  });
  const run = await attemptBuy(deps(w), mission(), reading());

  assert.equal(run.outcome, 'duplicate_prevented');
  assert.equal(w.browserOpens, 0, 'no grant, no signed-in browser — the noisy half stays away');
  assert.deepEqual(w.cartActions, []);
});

test('budget_exhausted comes through with the Hub\'s arithmetic', async () => {
  const w = world({
    authorise: { granted: false, refusal: 'budget_exhausted', reason: '$120.00 would pass the $100.00 cap' },
  });
  const run = await attemptBuy(deps(w), mission(), reading());
  assert.equal(run.outcome, 'budget_exhausted');
  assert.match(run.reason, /\$100\.00 cap/);
});

test('THE CART GETS THE FINAL WORD over a page that said something else', async () => {
  // Detected at $49.99; the cart says $75 a unit. The page was evidence, the
  // cart is the charge, and the charge is refused.
  const w = world({ cart: { unitPrice: 75, quantity: 1, tax: 7.31, shipping: 0 } });
  const run = await attemptBuy(deps(w), mission(), reading());

  assert.equal(run.outcome, 'price_exceeded');
  assert.match(run.reason, /the cart got the final word/);
  assert.deepEqual(w.cartActions, ['add', 'read', 'remove'], 'the item does not stay in the basket');
  assert.equal(w.resolutions[0]!.result, 'released');
});

test('a cart with the wrong quantity is refused the same way', async () => {
  const w = world({ cart: { ...goodCart, quantity: 10 } });
  const run = await attemptBuy(deps(w), mission(), reading());
  assert.equal(run.outcome, 'declined');
  assert.match(run.reason, /cart has 10, you asked for 1/);
  assert.equal(w.resolutions[0]!.result, 'released');
});

test('an unreadable tax line is a refusal, never a zero', async () => {
  const w = world({ cart: { ...goodCart, tax: null } });
  const run = await attemptBuy(deps(w), mission(), reading());
  assert.equal(run.outcome, 'declined');
  assert.match(run.reason, /could not read the tax/);
});

test('A FAILURE BEFORE THE CART RELEASES; A FAILURE AFTER IT DOES NOT', async () => {
  // Before the cart nothing can have been bought, so the money returns.
  const before = world({ failAt: 'addToCart' });
  const r1 = await attemptBuy(deps(before), mission(), reading());
  assert.equal(r1.outcome, 'failed');
  assert.equal(before.resolutions[0]!.result, 'released');

  // Mid-checkout is when nobody knows whether money moved. The grant stays
  // live — its money stays committed, a second grant stays blocked, and the
  // run says a person has to look.
  const after = world({ failAt: 'placeOrder' });
  const r2 = await attemptBuy(deps(after, { live: true }), mission(), reading());
  assert.equal(r2.outcome, 'failed');
  assert.deepEqual(after.resolutions, [], 'NOT released, NOT spent — a person decides');
  assert.match(r2.reason, /stays live/);
  assert.match(r2.reason, /orders page/);
  assert.equal(after.browserCloses, 1, 'but the signed-in browser still closes');
});

test('a retailer with no checkout flow is declined by name, before any grant', async () => {
  const w = world();
  const run = await attemptBuy(deps(w, { drivers: {} }), mission({ retailer: 'Walmart' }), reading());
  assert.equal(run.outcome, 'declined');
  assert.match(run.reason, /no checkout flow exists for Walmart/);
  assert.deepEqual(w.resolutions, [], 'no grant was taken for a flow that cannot use it');
});

// ── Where the seconds went ───────────────────────────────────────────────────

import { stopwatch } from '../src/buy.ts';

test('THE STOPWATCH NAMES THE SLOW PHASE INSTEAD OF ONE OPAQUE NUMBER', () => {
  // A drop is decided in the gap between "stock appeared" and "order placed".
  // Knowing that gap was 14s tells you nothing; knowing 11s of it was the cart
  // read tells you what to fix.
  let t = 1_000;
  const clock = stopwatch(() => t);
  t += 400; clock.mark('authorise');
  t += 2_600; clock.mark('browser');
  t += 1_500; clock.mark('open');
  t += 900; clock.mark('cart');

  const summary = clock.summary();
  assert.match(summary, /authorise 0\.4s/);
  assert.match(summary, /browser 2\.6s/);
  assert.match(summary, /cart 0\.9s/);
  assert.match(summary, /5\.4s total/);
  assert.equal(clock.total(), 5_400);
});

test('a stopwatch nobody marked says nothing rather than lying', () => {
  const clock = stopwatch(() => 5_000);
  assert.equal(clock.summary(), '');
  assert.equal(clock.total(), 0);
});
