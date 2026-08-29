/**
 * The money rails, tested without spending anything.
 *
 * Every test here is a specific way an unattended buyer loses money at 3am.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decide,
  verifyCart,
  worstCase,
  type CartLimits,
  type CartTotals,
} from '../src/money.ts';
import type { Observation, Watch } from '../src/types.ts';

const budget = { perRun: 200, perDay: 500 };
const fresh = { run: 0, day: 0 };

function watch(over: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    retailer: 'target',
    externalId: '94312876',
    url: 'https://www.target.com/p/x/-/A-94312876',
    name: 'Mega Evolution ETB',
    armed: true,
    ceiling: 30,
    quantity: 2,
    ...over,
  };
}

function seen(over: Partial<Observation> = {}): Observation {
  return {
    retailer: 'target',
    externalId: '94312876',
    url: 'https://www.target.com/p/x/-/A-94312876',
    name: 'Mega Evolution ETB',
    state: 'in',
    confidence: 'exact',
    price: 29.99,
    challenged: false,
    seenAt: new Date().toISOString(),
    ...over,
  };
}

const base = {
  budget,
  spent: fresh,
  alreadyBought: new Set<string>(),
  live: true,
  authorised: true,
};

test('the happy path buys, and gets the arithmetic right', () => {
  const d = decide({ ...base, watch: watch(), observation: seen() });
  assert.equal(d.buy, true);
  assert.equal(d.outcome, 'bought');
  assert.equal(d.total, 59.98, '2 × 29.99');
});

test('over the ceiling never buys, however close', () => {
  const d = decide({ ...base, watch: watch({ ceiling: 30 }), observation: seen({ price: 30.01 }) });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'price_exceeded');
  assert.match(d.note, /30\.01.*30\.00/);
});

test('exactly at the ceiling is allowed', () => {
  const d = decide({ ...base, watch: watch({ ceiling: 30 }), observation: seen({ price: 30 }) });
  assert.equal(d.buy, true);
});

test('no visible price refuses rather than finding out later', () => {
  const d = decide({ ...base, watch: watch(), observation: seen({ price: null }) });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'price_exceeded');
  assert.match(d.note, /cannot verify/);
});

test('a bot challenge is never treated as stock information', () => {
  const d = decide({
    ...base,
    watch: watch(),
    observation: seen({ challenged: true, state: 'in' }),
  });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'blocked');
});

test('an unconfident read does not buy', () => {
  const d = decide({ ...base, watch: watch(), observation: seen({ confidence: 'unknown' }) });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'sold_out');
});

test('a queue page does not buy', () => {
  const d = decide({ ...base, watch: watch(), observation: seen({ state: 'queue' }) });
  assert.equal(d.buy, false);
});

test('THE BIG ONE: the same item is never bought twice in a run', () => {
  const w = watch();
  const first = decide({ ...base, watch: w, observation: seen() });
  assert.equal(first.buy, true);

  const bought = new Set([w.externalId]);
  const second = decide({ ...base, watch: w, observation: seen(), alreadyBought: bought });
  assert.equal(second.buy, false);
  assert.equal(second.outcome, 'duplicate_prevented');
});

test('the per-run cap holds', () => {
  const d = decide({
    ...base,
    watch: watch({ ceiling: 100, quantity: 2 }),
    observation: seen({ price: 100 }),
    spent: { run: 50, day: 50 },
  });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'budget_exceeded');
  assert.match(d.note, /per-run/);
});

test('the daily cap holds even when the run cap would allow it', () => {
  const d = decide({
    ...base,
    watch: watch({ ceiling: 60, quantity: 2 }),
    observation: seen({ price: 60 }),
    budget: { perRun: 1000, perDay: 500 },
    spent: { run: 0, day: 420 },
  });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'budget_exceeded');
  assert.match(d.note, /daily/);
});

test('fail closed on spending: no hub authorisation, no purchase', () => {
  const d = decide({ ...base, watch: watch(), observation: seen(), authorised: false });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'not_authorised');
});

test('an unarmed watch never buys, whatever the price', () => {
  const d = decide({ ...base, watch: watch({ armed: false }), observation: seen({ price: 1 }) });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'not_authorised');
});

test('armed with no ceiling is treated as unauthorised, not as unlimited', () => {
  const d = decide({ ...base, watch: watch({ ceiling: null }), observation: seen() });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'not_authorised');
});

test('dry run reaches the decision but never buys', () => {
  const d = decide({ ...base, watch: watch(), observation: seen(), live: false });
  assert.equal(d.buy, false);
  assert.equal(d.outcome, 'dry_run');
  assert.equal(d.total, 59.98, 'still reports what it would have cost');
});

test('every refusal explains itself', () => {
  const refusals = [
    decide({ ...base, watch: watch({ armed: false }), observation: seen() }),
    decide({ ...base, watch: watch(), observation: seen({ price: 999 }) }),
    decide({ ...base, watch: watch(), observation: seen({ challenged: true }) }),
    decide({ ...base, watch: watch(), observation: seen(), authorised: false }),
  ];
  for (const r of refusals) {
    assert.equal(r.buy, false);
    assert.ok(r.note.length > 10, `refusal had no useful reason: ${r.note}`);
  }
});

// --------------------------------------------------------------------------
// The cart gate — what the page said earlier is not what you'll be charged
//
// The ceiling means item + tax, per unit. Shipping is checked separately
// against an account-wide allowance, so a refusal can say which one was too
// much instead of quietly inflating the ceiling to cover postage.
// --------------------------------------------------------------------------

const limits = (over: Partial<CartLimits> = {}): CartLimits => ({
  budget,
  spent: fresh,
  shippingAllowance: 10,
  ...over,
});
const cart = (over: Partial<CartTotals> = {}): CartTotals => ({
  unitPrice: 29.99,
  quantity: 2,
  tax: 5.85,
  shipping: 0,
  ...over,
});

test('a good cart passes, and says what it added up', () => {
  const v = verifyCart({ watch: watch({ ceiling: 33 }), cart: cart(), limits: limits() });
  assert.equal(v.ok, true);
  assert.equal(v.total, 65.83);
  assert.match(v.note, /29\.99.*5\.85 tax.*0\.00 shipping.*65\.83/);
});

test('THE CEILING INCLUDES TAX — a price that fits without it can still fail', () => {
  // $29.99 is under a $30 ceiling. With tax it is not, and tax is what gets
  // charged. This is the whole reason the rule changed.
  const v = verifyCart({
    watch: watch({ ceiling: 30, quantity: 2 }),
    cart: cart({ unitPrice: 29.99, quantity: 2, tax: 5.85 }),
    limits: limits(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'price_exceeded');
  assert.match(v.note, /32\.92 per unit with tax/);
  assert.match(v.note, /\$30\.00 ceiling/);
});

test('cart price drifting above the ceiling stops the submit', () => {
  const v = verifyCart({
    watch: watch({ ceiling: 30 }),
    cart: cart({ unitPrice: 54.99, quantity: 2, tax: 10.72 }),
    limits: limits(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'price_exceeded');
});

test('SHIPPING IS ITS OWN REFUSAL, not a bigger ceiling', () => {
  // Guppy adds $15 to the max price and calls it a shipping buffer, which
  // turns a $30 limit into $45 while the log still says $30. Here the item
  // passes and the postage is refused, by name.
  const v = verifyCart({
    watch: watch({ ceiling: 33 }),
    cart: cart({ shipping: 14.99 }),
    limits: limits({ shippingAllowance: 10 }),
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'shipping_exceeded');
  assert.match(v.note, /shipping is \$14\.99 and the allowance is \$10\.00/);
});

test('shipping exactly at the allowance is allowed', () => {
  const v = verifyCart({
    watch: watch({ ceiling: 33 }),
    cart: cart({ shipping: 10 }),
    limits: limits({ shippingAllowance: 10 }),
  });
  assert.equal(v.ok, true);
});

test('an allowance of zero means free shipping or no purchase', () => {
  const free = verifyCart({
    watch: watch({ ceiling: 33 }),
    cart: cart({ shipping: 0 }),
    limits: limits({ shippingAllowance: 0 }),
  });
  assert.equal(free.ok, true);

  const paid = verifyCart({
    watch: watch({ ceiling: 33 }),
    cart: cart({ shipping: 4.99 }),
    limits: limits({ shippingAllowance: 0 }),
  });
  assert.equal(paid.outcome, 'shipping_exceeded');
});

test('cart quantity not matching the mandate stops the submit', () => {
  const v = verifyCart({
    watch: watch({ quantity: 2 }),
    cart: cart({ quantity: 10 }),
    limits: limits(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'qty_unavailable');
  assert.match(v.note, /10.*2/);
});

test('AN UNREADABLE TAX LINE IS A FAILURE, NEVER ZERO TAX', () => {
  // A missing tax line is not "no tax". It is a checkout page we did not
  // understand, and the ceiling is defined in terms of the number we could not
  // find. Assuming zero here is how you pay 9% more than your mandate.
  const v = verifyCart({
    watch: watch({ ceiling: 33 }),
    cart: cart({ tax: null }),
    limits: limits(),
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'failed');
  assert.match(v.note, /could not read the tax/);
});

test('an unreadable cart is a failure, never an assumption', () => {
  for (const broken of [
    cart({ unitPrice: null }),
    cart({ quantity: null }),
    cart({ shipping: null }),
  ]) {
    const v = verifyCart({ watch: watch({ ceiling: 33 }), cart: broken, limits: limits() });
    assert.equal(v.ok, false, JSON.stringify(broken));
    assert.equal(v.outcome, broken.quantity === null ? 'failed' : 'failed');
  }
});

test('a watch with no ceiling cannot pass the cart gate either', () => {
  // The rule is enforced twice on purpose. One place to forget is one too many.
  const v = verifyCart({
    watch: watch({ ceiling: null }),
    cart: cart(),
    limits: limits(),
  });
  assert.equal(v.ok, false);
  assert.match(v.note, /no price ceiling/);
});

test('the cart gate re-checks budget on the whole order, shipping included', () => {
  const v = verifyCart({
    watch: watch({ ceiling: 120, quantity: 2 }),
    cart: cart({ unitPrice: 100, quantity: 2, tax: 19.5, shipping: 9.99 }),
    limits: limits({ budget: { perRun: 150, perDay: 1000 }, shippingAllowance: 10 }),
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'budget_exceeded');
  assert.match(v.note, /per-run cap/);
});

test('the daily cap is named separately from the per-run one', () => {
  const v = verifyCart({
    watch: watch({ ceiling: 120, quantity: 1 }),
    cart: cart({ unitPrice: 100, quantity: 1, tax: 9.75, shipping: 0 }),
    limits: limits({ budget: { perRun: 200, perDay: 300 }, spent: { run: 0, day: 250 } }),
  });
  assert.equal(v.outcome, 'budget_exceeded');
  assert.match(v.note, /daily cap/);
});

test('worst case counts the shipping allowance once per armed watch', () => {
  // Each armed watch is a separate order, so each can pay postage. Leaving it
  // out understates the night by exactly the amount nobody budgets for.
  const ws: Watch[] = [
    watch({ id: 'a', ceiling: 30, quantity: 2 }),
    watch({ id: 'b', ceiling: 25, quantity: 1 }),
  ];
  assert.equal(worstCase(ws), 85, '30x2 + 25x1');
  assert.equal(worstCase(ws, 10), 105, 'plus postage on each of the two orders');
});

test('worst case sums armed watches only', () => {
  const ws: Watch[] = [
    watch({ id: 'a', ceiling: 30, quantity: 2 }),
    watch({ id: 'b', ceiling: 25, quantity: 1 }),
    watch({ id: 'c', ceiling: 99, quantity: 5, armed: false }),
  ];
  assert.equal(worstCase(ws), 85, '(30×2) + (25×1), the disarmed one excluded');
});
