/**
 * What Phantom decides, and what it writes down.
 *
 * judge() is where money gets spent or refused, so most of these tests are
 * named after the mistake they prevent rather than the function they call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, pass, type ReadFn } from '../src/watch.ts';
import { Pacer, nextUp, DEFAULT_PACING, type Pacing } from '../src/rate.ts';
import type { Browser } from '../src/browser.ts';
import { DEFAULT_SETTINGS } from '../src/hub.ts';
import type { Hub, Mission, ObservationOut, RunOut, Settings } from '../src/hub.ts';
import type { Reading } from '../src/read.ts';

const T0 = 1_700_000_000_000;
const STEADY: Pacing = { ...DEFAULT_PACING, jitterMs: 0 };

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: 1,
  listingId: 11,
  productKey: 'mega-evolution-etb',
  productName: 'Mega Evolution ETB',
  retailer: 'Target',
  externalId: '1012644666',
  url: 'https://www.target.com/p/-/A-1012644666',
  enabled: true,
  armed: false,
  ceiling: null,
  quantity: 1,
  sellerPolicy: 'retailer_only', preOrderPolicy: 'skip',
  checkEverySeconds: 30,
  state: 'out',
  price: null,
  lastCheckedAt: '',
  ...over,
});

const reading = (over: Partial<Reading> = {}): Reading => ({
  name: 'Mega Evolution ETB',
  price: 49.99,
  state: 'out',
  confidence: 'exact',
  availableQuantity: null,
  orderLimit: null,
  pickupAvailable: false,
  seller: { kind: 'retailer', name: 'Target' },
  preOrder: { isPreOrder: false, releaseDate: null },
  note: '',
  challenged: false,
  challengeReason: '',
  imageUrl: 'https://target.scene7.com/x.jpg',
  ms: 812,
  ...over,
});

// ── judge ────────────────────────────────────────────────────────────────────

test('an ordinary out-of-stock check is reported but writes no run', () => {
  // A mission polling a static product for a week would otherwise bury the
  // four rows that matter under ten thousand saying "still out of stock".
  const v = judge(mission(), reading({ state: 'out' }));
  assert.equal(v.run, null);
  assert.equal(v.observation.state, 'out');
});

test('the real product name travels with every reading', () => {
  // The Hub mints a name from the URL slug when a listing is added, because a
  // slug is all it has. Target's encodes "Pokémon" as "pok-233-mon", which
  // titleises into "Pok 233 Mon". The page knows better, so the page wins.
  const v = judge(mission(), reading({ name: 'Pokémon TCG: 30th Celebration Elite Trainer Box' }));
  assert.equal(v.observation.productName, 'Pokémon TCG: 30th Celebration Elite Trainer Box');
});

test('every check reports the observation, run or no run', () => {
  const v = judge(mission(), reading({ state: 'out', price: 49.99, imageUrl: 'https://i/x.jpg' }));
  assert.equal(v.observation.listingId, 11);
  assert.equal(v.observation.price, 49.99);
  assert.equal(v.observation.imageUrl, 'https://i/x.jpg');
  assert.equal(v.observation.sellerKind, 'retailer');
});

test('an unreadable page is a failure with a reason, never a silent out-of-stock', () => {
  // The expensive version of this bug: the page changes, the reader returns
  // nothing, and the dashboard quietly says "out of stock" forever.
  const v = judge(
    mission(),
    reading({ state: 'unknown', confidence: 'unknown', note: 'no price node found' }),
  );
  assert.equal(v.run?.outcome, 'failed');
  assert.equal(v.run?.reason, 'no price node found');
});

test('an unreadable page with no note still explains itself', () => {
  const v = judge(mission(), reading({ state: 'unknown', confidence: 'unknown', note: '' }));
  assert.equal(v.run?.reason, 'the page could not be read');
});

test('a challenge is recorded as blocked, not as failed', () => {
  // Different thing, different fix. "Blocked" is what you want to see when
  // the numbers stop moving.
  const v = judge(
    mission(),
    reading({ challenged: true, challengeReason: 'press and hold', state: 'unknown' }),
  );
  assert.equal(v.run?.outcome, 'blocked');
  assert.match(v.run!.reason, /press and hold/);
});

test('an unarmed mission finding stock says so and stops there', () => {
  const v = judge(mission({ armed: false }), reading({ state: 'in', price: 49.99 }));
  assert.equal(v.run?.outcome, 'in_stock');
  assert.match(v.run!.reason, /\$49\.99/);
  assert.match(v.run!.reason, /watching only/);
});

test('a retailer-only mission refuses a marketplace seller', () => {
  // The Walmart trap: IN_STOCK at $73.76 from Rares Market L.L.C. against a
  // ~$50 MSRP. Price and stock both look fine; the seller is the tell.
  const v = judge(
    mission({ armed: true, ceiling: 80 }),
    reading({
      state: 'in',
      price: 73.76,
      seller: { kind: 'marketplace', name: 'Rares Market L.L.C.' },
    }),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /Rares Market/);
  assert.match(v.run!.reason, /retailer-only/);
});

test('a mission allowing any seller does not refuse on the seller', () => {
  const v = judge(
    mission({ armed: true, ceiling: 80, sellerPolicy: 'any' }),
    reading({ state: 'in', price: 73.76, seller: { kind: 'marketplace', name: 'Rares' } }),
  );
  assert.ok(v.buy, 'the verdict is buy');
  assert.equal(v.run, null, 'and the buy path records the run, not judge()');
});

test('an unknown seller is refused by a retailer-only mission', () => {
  // "Not proven to be the retailer" is not the same as "is the retailer".
  const v = judge(
    mission({ armed: true, ceiling: 80 }),
    reading({ state: 'in', price: 49.99, seller: { kind: 'unknown', name: '' } }),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /retailer-only/);
});

test('armed with no ceiling refuses to spend', () => {
  const v = judge(mission({ armed: true, ceiling: null }), reading({ state: 'in' }));
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /no price ceiling/);
});

test('in stock with no readable price refuses to buy blind', () => {
  const v = judge(
    mission({ armed: true, ceiling: 60 }),
    reading({ state: 'in', price: null, confidence: 'inferred' }),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /no price could be read/);
});

test('a price over the ceiling is refused, and the reason names both numbers', () => {
  const v = judge(mission({ armed: true, ceiling: 59.99 }), reading({ state: 'in', price: 64.99 }));
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /\$64\.99 is over the \$59\.99 ceiling/);
});

test('the ceiling is inclusive — exactly at it is allowed', () => {
  const v = judge(mission({ armed: true, ceiling: 49.99 }), reading({ state: 'in', price: 49.99 }));
  assert.ok(v.buy, 'exactly at the ceiling is a buy verdict');
});

test('an inferred reading is not good enough to spend on', () => {
  const v = judge(
    mission({ armed: true, ceiling: 60 }),
    reading({ state: 'in', price: 49.99, confidence: 'inferred' }),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /not exact/);
});

test('EVERYTHING TRUE IS A VERDICT, NOT A PURCHASE', () => {
  // judge() stays pure. It says "everything a purchase needs is true" and
  // hands the price and quantity to the pass — authorisation from the Hub and
  // the cart's own numbers come after, and the run that gets recorded is the
  // buy path's account of what actually happened.
  const v = judge(
    mission({ armed: true, ceiling: 60, quantity: 2 }),
    reading({ state: 'in', price: 49.99 }),
  );
  assert.deepEqual(v.buy, { unitPrice: 49.99, quantity: 2 });
  assert.equal(v.run, null);
  assert.ok(v.observation, 'the reading still reaches the Hub either way');
});

// ── The ceiling means item + tax ─────────────────────────────────────────────

const taxed = (rate: number, shipping = 0): Settings => ({
  ...DEFAULT_SETTINGS,
  taxRate: rate,
  shippingAllowance: shipping,
});

test('A PRICE UNDER THE CEILING CAN STILL BE OVER IT ONCE TAX IS ON', () => {
  // $29.99 fits a $31 ceiling. At 9.75% it does not, and tax is what gets
  // charged. Finding this out at the checkout instead is how you learn that
  // your ceiling never meant what you thought.
  const v = judge(
    mission({ armed: true, ceiling: 31, quantity: 1 }),
    reading({ state: 'in', price: 29.99 }),
    taxed(0.0975),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /\$32\.91/);
  assert.match(v.run!.reason, /9\.75% tax/);
  assert.match(v.run!.reason, /\$31\.00 ceiling/);
});

test('with no tax rate set, the listed price is judged as-is', () => {
  // Zero is a legitimate answer and means "do not estimate". The real number
  // is still caught by verifyCart before anything is submitted.
  const v = judge(
    mission({ armed: true, ceiling: 31, quantity: 1 }),
    reading({ state: 'in', price: 29.99 }),
    taxed(0),
  );
  assert.ok(v.buy, 'within the ceiling as-is, so the verdict is buy');
});

test('a buy verdict carries the observed price, not a tax-adjusted one', () => {
  // The tax adjustment belongs to the ceiling comparison; what the buy path
  // needs is what the page said, because the cart's own tax line is the real
  // number and verifyCart judges against that.
  const v = judge(
    mission({ armed: true, ceiling: 60, quantity: 2 }),
    reading({ state: 'in', price: 49.99 }),
    taxed(0.0975),
  );
  assert.deepEqual(v.buy, { unitPrice: 49.99, quantity: 2 });
});

test('nothing judge() can return ever says bought', () => {
  const cases: Reading[] = [
    reading({ state: 'in', price: 1 }),
    reading({ state: 'in', price: 10_000 }),
    reading({ state: 'queue' }),
    reading({ challenged: true, challengeReason: 'x' }),
    reading({ state: 'unknown', confidence: 'unknown' }),
  ];
  for (const r of cases) {
    const v = judge(mission({ armed: true, ceiling: 999_999 }), r);
    assert.notEqual(v.run?.outcome, 'bought');
  }
});

test('a pre-order release date is carried through to the Hub', () => {
  // Half B needs this: what is on order, and what cash is needed when.
  const v = judge(
    mission(),
    reading({ preOrder: { isPreOrder: true, releaseDate: '2026-09-26' } }),
  );
  assert.equal(v.observation.isPreOrder, true);
  assert.equal(v.observation.releaseDate, '2026-09-26');
});

// ── pass ─────────────────────────────────────────────────────────────────────

interface Recorder {
  hub: Hub;
  observations: ObservationOut[];
  runs: RunOut[];
}

function recorder(): Recorder {
  const observations: ObservationOut[] = [];
  const runs: RunOut[] = [];
  const hub = {
    backlog: 0,
    async report(o: ObservationOut[]) {
      observations.push(...o);
      return { sent: o.length, buffered: 0 };
    },
    async recordRun(r: RunOut) {
      runs.push(r);
      return true;
    },
  } as unknown as Hub;
  return { hub, observations, runs };
}

const browser = {} as Browser;
const reads = (fn: (retailer: string) => Reading): ReadFn => async (_b, retailer) => fn(retailer);

test('a pass checks one mission per retailer and paces the rest', async () => {
  // The retailer's budget is shared, so two Target missions cannot both go in
  // the same pass. The second is reported as waiting rather than dropped
  // silently.
  const { hub, observations } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const missions = [mission({ id: 1, listingId: 11 }), mission({ id: 2, listingId: 12 })];

  const result = await pass(missions, pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });

  assert.equal(result.checked, 1);
  assert.equal(observations.length, 1);
  assert.deepEqual(result.waitingOn, ['Target (pacing, 20s)']);
});

test('two retailers are checked in the same pass', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const missions = [
    mission({ id: 1, retailer: 'Target' }),
    mission({ id: 2, retailer: 'Walmart' }),
  ];

  const result = await pass(missions, pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });
  assert.equal(result.checked, 2);
  assert.deepEqual(result.waitingOn, []);
});

test('a challenge drops that retailer for the rest of the pass', async () => {
  // Retrying into a bot check is how a soft flag becomes a hard block.
  const { hub, runs } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const missions = [
    mission({ id: 1, retailer: 'Target' }),
    mission({ id: 2, retailer: 'Target' }),
    mission({ id: 3, retailer: 'Walmart' }),
  ];

  const result = await pass(missions, pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads((retailer) =>
      retailer === 'Target'
        ? reading({ challenged: true, challengeReason: 'press and hold', state: 'unknown' })
        : reading(),
    ),
  });

  assert.equal(result.checked, 2, 'the second Target mission was not attempted');
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!, /Target: press and hold, 20m/);
  assert.equal(pacer.standingDown('Target', T0), true);
  assert.equal(pacer.standingDown('Walmart', T0), false);
  assert.deepEqual(runs.map((r) => r.outcome), ['blocked']);
});

test('a challenged retailer is reported as standing down, not merely pacing', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);

  const result = await pass([mission()], pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });

  assert.equal(result.checked, 0);
  assert.deepEqual(result.waitingOn, ['Target (standing down, 1200s)']);
});

test('a clean read forgives an earlier challenge', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);

  await pass([mission()], pacer, {
    browser,
    hub,
    now: () => T0 + STEADY.backoffMs,
    read: reads(() => reading()),
  });
  assert.equal(pacer.challengeStreak('Target'), 0);
});

test('a mission not yet due is neither checked nor reported as waiting', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const recent = mission({ lastCheckedAt: new Date(T0 - 5_000).toISOString() });

  const result = await pass([recent], pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });

  assert.equal(result.checked, 0);
  assert.deepEqual(result.waitingOn, [], 'not due is not the same as being held back');
});

test('a read that throws does not take the pass down with it', async () => {
  // One bad page must not stop the other retailer being checked.
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const missions = [
    mission({ id: 1, retailer: 'Target' }),
    mission({ id: 2, retailer: 'Walmart' }),
  ];

  const result = await pass(missions, pacer, {
    browser,
    hub,
    now: () => T0,
    read: async (_b, retailer) => {
      if (retailer === 'Target') throw new Error('chrome fell over');
      return reading();
    },
  });

  assert.equal(result.checked, 2);
  assert.equal(result.failed, 1);
});

test('a pass that checks nothing says when the next one is due', async () => {
  // "0 checked" and no reason is the same quiet a broken Phantom produces.
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const recent = mission({ checkEverySeconds: 60, lastCheckedAt: new Date(T0 - 42_000).toISOString() });

  const result = await pass([recent], pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });

  assert.equal(result.checked, 0);
  assert.equal(result.nextDueInMs, 18_000);
});

test('the soonest mission is the one reported, not the first', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const missions = [
    mission({ id: 1, checkEverySeconds: 600, lastCheckedAt: new Date(T0 - 60_000).toISOString() }),
    mission({ id: 2, checkEverySeconds: 60, lastCheckedAt: new Date(T0 - 50_000).toISOString() }),
  ];

  const result = await pass(missions, pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });
  assert.equal(result.nextDueInMs, 10_000);
});

test('a pass that checked something does not also claim nothing was due', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const result = await pass([mission()], pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });
  assert.equal(result.checked, 1);
  assert.equal(result.nextDueInMs, null);
});

test('a retailer holding us back is reported as that, not as nothing being due', async () => {
  // Two different silences with two different fixes. Conflating them sends you
  // looking at the schedule when the real answer is a bot check.
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);

  const result = await pass([mission()], pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads(() => reading()),
  });

  assert.equal(result.checked, 0);
  assert.equal(result.nextDueInMs, null);
  assert.deepEqual(result.waitingOn, ['Target (standing down, 1200s)']);
});

test('a pending test run is never reported as "nothing due"', () => {
  // Two silences again. "Nothing due — next in 18s" while a test run sits
  // unhonoured would send you looking at the schedule.
  const pacer = new Pacer(STEADY, () => 0);
  const asked = mission({ lastCheckedAt: new Date(T0 - 1_000).toISOString(), checkNow: true });
  assert.equal(nextUp([asked], pacer, T0)?.id, 1, 'and it is due');
});

// ── A pre-order is orderable, and it is not stock ────────────────────────────
//
// Every reader already knew this and nothing acted on it. schema.org's
// PreOrder maps to state 'in' — correctly, you can put it in a basket — and
// Walmart states preOrder.isPreOrder outright. So an armed mission would have
// paid for something shipping in three months and reported success.

const preordered = (over: Partial<Reading> = {}): Reading =>
  reading({ state: 'in', preOrder: { isPreOrder: true, releaseDate: '2026-11-14' }, ...over });

test('AN ARMED MISSION DOES NOT BUY A PRE-ORDER BY DEFAULT', () => {
  const { run } = judge(mission({ armed: true, ceiling: 60 }), preordered());
  assert.equal(run?.outcome, 'declined');
  assert.match(run!.reason, /pre-order \(releases 2026-11-14\), and this mission buys stock only/);
});

test('the pre-order reason beats the price reason', () => {
  // "This is a pre-order" is a better answer than "it costs too much", and it
  // is the one you want in the log when you come back to ask what happened.
  const { run } = judge(
    mission({ armed: true, ceiling: 10 }),
    preordered({ price: 99.99 }),
  );
  assert.match(run!.reason, /pre-order/);
  assert.ok(!run!.reason.includes('ceiling'));
});

test('a mission told to allow pre-orders gets a buy verdict for one', () => {
  const v = judge(
    mission({ armed: true, ceiling: 60, preOrderPolicy: 'allow' }),
    preordered(),
  );
  assert.ok(v.buy, 'allow means allow');
  assert.equal(v.run, null);
});

test('a pre-order with no date still says so', () => {
  // Pokémon Center states PreOrder availability without a date. "Unknown when"
  // is a reason to decline, not a reason to say nothing.
  const { run } = judge(
    mission({ armed: true, ceiling: 60 }),
    preordered({ preOrder: { isPreOrder: true, releaseDate: null } }),
  );
  assert.match(run!.reason, /no release date given/);
});

test('an ordinary in-stock item is untouched by any of this', () => {
  const v = judge(mission({ armed: true, ceiling: 60 }), reading({ state: 'in' }));
  assert.ok(v.buy, 'plain stock inside the ceiling is a buy verdict');
});

test('a watching-only mission still just reports a pre-order', () => {
  // The policy is about spending. A mission that cannot spend has no decision
  // to make and should not start inventing one.
  const { run } = judge(mission({ armed: false }), preordered());
  assert.equal(run?.outcome, 'in_stock');
});

// ── The pass hands a buy verdict to the buyer ────────────────────────────────

test('THE PASS INVOKES THE BUYER ON A BUY VERDICT, AND RECORDS ITS RUN', async () => {
  const bought: string[] = [];
  const { hub, runs } = recorder();
  const result = await pass(
    [mission({ armed: true, ceiling: 60 })],
    new Pacer(STEADY, () => 0),
    {
      browser,
      hub,
      read: reads(() => reading({ state: 'in', price: 49.99 })),
      buyer: async (m) => {
        bought.push(m.productName);
        return {
          missionId: m.id, outcome: 'dry_run', reason: 'stopped before the button',
          state: 'in', price: 49.99, sellerKind: 'retailer', sellerName: 'Target',
        };
      },
    },
  );
  assert.equal(bought.length, 1, 'the buyer was handed the verdict');
  assert.equal(result.runs, 1);
  assert.equal(runs[0]?.outcome, 'dry_run');
});

test('a Phantom with no buyer still records the honest decline', async () => {
  const { hub, runs } = recorder();
  await pass(
    [mission({ armed: true, ceiling: 60 })],
    new Pacer(STEADY, () => 0),
    { browser, hub, read: reads(() => reading({ state: 'in', price: 49.99 })) },
  );
  assert.equal(runs[0]?.outcome, 'declined');
  assert.match(runs[0]!.reason, /buying is not enabled on this Phantom/);
});

test('a buyer that throws becomes a failed run, not a dead pass', async () => {
  const { hub, runs } = recorder();
  const result = await pass(
    [mission({ armed: true, ceiling: 60 })],
    new Pacer(STEADY, () => 0),
    {
      browser,
      hub,
      read: reads(() => reading({ state: 'in', price: 49.99 })),
      buyer: async () => { throw new Error('the buy machinery exploded'); },
    },
  );
  assert.equal(result.checked, 1, 'the pass survives');
  assert.equal(runs[0]?.outcome, 'failed');
  assert.match(runs[0]!.reason, /the buy attempt itself failed/);
});

test('a watching-only mission never reaches the buyer', async () => {
  let invoked = 0;
  const { hub } = recorder();
  await pass(
    [mission({ armed: false })],
    new Pacer(STEADY, () => 0),
    {
      browser,
      hub,
      read: reads(() => reading({ state: 'in', price: 49.99 })),
      buyer: async () => { invoked += 1; return {} as never; },
    },
  );
  assert.equal(invoked, 0, 'watching means watching');
});

// ── A queue is a signal, not a wall ──────────────────────────────────────────

test('A WAITING ROOM DOES NOT STAND THE RETAILER DOWN', async () => {
  // A wall means "go away"; a queue means "something is dropping RIGHT NOW".
  // Standing down for half an hour on a queue is leaving the store at the
  // moment the doors opened — the pass skips the rest of that retailer (every
  // page is behind the same queue) but the next pass looks again on schedule.
  const { hub, runs } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const missions = [
    mission({ id: 1, retailer: 'Pokemon Center' }),
    mission({ id: 2, retailer: 'Pokemon Center' }),
    mission({ id: 3, retailer: 'Target' }),
  ];

  const result = await pass(missions, pacer, {
    browser,
    hub,
    now: () => T0,
    read: reads((retailer) =>
      retailer === 'Pokemon Center'
        ? reading({ challenged: true, challengeReason: 'Queue-it waiting room', state: 'unknown' })
        : reading(),
    ),
  });

  assert.equal(result.checked, 2, 'the second queued-shop mission was skipped this pass');
  assert.equal(pacer.standingDown('Pokemon Center', T0), false,
    'no long stand-down — the interesting moment is when the queue comes DOWN');
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!, /WAITING ROOM UP/);
  assert.match(result.blocked[0]!, /drop likely live/);
  // The run says what a person should do about it, not that we apologised.
  const blockedRun = runs.find((r) => r.outcome === 'blocked');
  assert.ok(blockedRun);
  assert.match(blockedRun!.reason, /waiting room is up/);
  assert.match(blockedRun!.reason, /get in line yourself/);
  assert.doesNotMatch(blockedRun!.reason, /standing down/);
});

// ── the stock-loaded alarm: the drop precursor ───────────────────────────────

import { stockLoaded, STOCK_LOADED_MIN } from '../src/watch.ts';
import type { ActivityLine } from '../src/activity.ts';
import type { Activity } from '../src/activity.ts';

test('WAREHOUSE STOCK APPEARING FROM NOTHING IS THE ALARM — shelf noise is not', () => {
  // The load-in: hundreds to tens of thousands landing where there was nothing.
  assert.equal(stockLoaded(null, 30000), true);
  assert.equal(stockLoaded(0, 250), true);
  assert.equal(stockLoaded(20, STOCK_LOADED_MIN), true, 'display-capped shelf stock is a small prior');
  // Ordinary shelf quantities (8–20, display-capped) must never cry wolf.
  assert.equal(stockLoaded(null, 20), false);
  assert.equal(stockLoaded(0, 99), false);
  // A live drop draining fires nothing on the way down…
  assert.equal(stockLoaded(30000, 12000), false);
  assert.equal(stockLoaded(120, 90), false);
  // …and a null reading (the page did not say) is never a load-in.
  assert.equal(stockLoaded(0, null), false);
  assert.equal(stockLoaded(null, null), false);
});

test('THE LOAD-IN WRITES A STOCK LOADED LINE THE HUB CAN ALARM ON', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const lines: ActivityLine[] = [];
  const activity = { record: (l: ActivityLine) => { lines.push(l); } } as unknown as Activity;

  await pass([mission({ availableQuantity: 0, state: 'out' })], pacer, {
    browser,
    hub,
    activity,
    now: () => T0,
    read: reads(() => reading({ state: 'out', availableQuantity: 31000 })),
  });

  const alarm = lines.find((l) => l.message.startsWith('STOCK LOADED:'));
  assert.ok(alarm, 'the alarm line exists');
  assert.equal(alarm!.level, 'warn');
  assert.match(alarm!.message, /Mega Evolution ETB/);
  assert.match(alarm!.message, /~31000 units/);
  assert.match(alarm!.message, /drop is likely near/);
});

test('a quantity that was already big fires nothing — one alarm per load-in', async () => {
  const { hub } = recorder();
  const pacer = new Pacer(STEADY, () => 0);
  const lines: ActivityLine[] = [];
  const activity = { record: (l: ActivityLine) => { lines.push(l); } } as unknown as Activity;

  await pass([mission({ availableQuantity: 28000, state: 'out' })], pacer, {
    browser,
    hub,
    activity,
    now: () => T0,
    read: reads(() => reading({ state: 'out', availableQuantity: 27000 })),
  });

  assert.equal(lines.some((l) => l.message.startsWith('STOCK LOADED:')), false);
});
