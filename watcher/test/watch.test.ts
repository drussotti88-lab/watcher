/**
 * What the Watcher decides, and what it writes down.
 *
 * judge() is where money gets spent or refused, so most of these tests are
 * named after the mistake they prevent rather than the function they call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, pass, type ReadFn } from '../src/watch.ts';
import { Pacer, DEFAULT_PACING, type Pacing } from '../src/rate.ts';
import type { Browser } from '../src/browser.ts';
import type { Hub, Mission, ObservationOut, RunOut } from '../src/hub.ts';
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
  sellerPolicy: 'retailer_only',
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
  assert.match(v.run!.reason, /would have bought/);
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
  assert.match(v.run!.reason, /would have bought/);
});

test('an inferred reading is not good enough to spend on', () => {
  const v = judge(
    mission({ armed: true, ceiling: 60 }),
    reading({ state: 'in', price: 49.99, confidence: 'inferred' }),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.match(v.run!.reason, /not exact/);
});

test('a would-be purchase is declined honestly, with the total', () => {
  // Checkout does not exist yet. Saying "bought" here would be a lie the
  // history could not be un-told.
  const v = judge(
    mission({ armed: true, ceiling: 60, quantity: 2 }),
    reading({ state: 'in', price: 49.99 }),
  );
  assert.equal(v.run?.outcome, 'declined');
  assert.equal(v.run?.quantity, 2);
  assert.equal(v.run?.total, 99.98);
  assert.match(v.run!.reason, /would have bought 2 at \$49\.99 \(\$99\.98 total\)/);
  assert.match(v.run!.reason, /checkout is not built yet/);
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
  // "0 checked" and no reason is the same quiet a broken Watcher produces.
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
