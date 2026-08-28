/**
 * The money rails, tested without spending anything.
 *
 * Every test here is a specific way an unattended buyer loses money at 3am.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, verifyCart, worstCase } from '../src/money.ts';
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
// --------------------------------------------------------------------------

test('cart price drifting above the ceiling stops the submit', () => {
  const v = verifyCart({
    watch: watch({ ceiling: 30 }),
    cartUnitPrice: 54.99,
    cartQuantity: 2,
    budget,
    spent: fresh,
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'price_exceeded');
});

test('cart quantity not matching the mandate stops the submit', () => {
  const v = verifyCart({
    watch: watch({ quantity: 2 }),
    cartUnitPrice: 29.99,
    cartQuantity: 10,
    budget,
    spent: fresh,
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'qty_unavailable');
  assert.match(v.note, /10.*2/);
});

test('an unreadable cart is a failure, never an assumption', () => {
  const noPrice = verifyCart({
    watch: watch(),
    cartUnitPrice: null,
    cartQuantity: 2,
    budget,
    spent: fresh,
  });
  assert.equal(noPrice.ok, false);
  assert.equal(noPrice.outcome, 'failed');

  const noQty = verifyCart({
    watch: watch(),
    cartUnitPrice: 29.99,
    cartQuantity: null,
    budget,
    spent: fresh,
  });
  assert.equal(noQty.ok, false);
});

test('a good cart passes', () => {
  const v = verifyCart({
    watch: watch(),
    cartUnitPrice: 29.99,
    cartQuantity: 2,
    budget,
    spent: fresh,
  });
  assert.equal(v.ok, true);
});

test('the cart gate re-checks budget, not just price', () => {
  const v = verifyCart({
    watch: watch({ ceiling: 100, quantity: 2 }),
    cartUnitPrice: 100,
    cartQuantity: 2,
    budget: { perRun: 150, perDay: 1000 },
    spent: fresh,
  });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, 'budget_exceeded');
});

test('worst case sums armed watches only', () => {
  const ws: Watch[] = [
    watch({ id: 'a', ceiling: 30, quantity: 2 }),
    watch({ id: 'b', ceiling: 25, quantity: 1 }),
    watch({ id: 'c', ceiling: 99, quantity: 5, armed: false }),
  ];
  assert.equal(worstCase(ws), 85, '(30×2) + (25×1), the disarmed one excluded');
});
