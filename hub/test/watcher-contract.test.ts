/**
 * The seam between the two halves.
 *
 * The Watcher and the Hub are separate programs in separate folders that only
 * ever meet over three endpoints. Nothing else in either test suite would
 * notice if one side renamed a field — the Watcher would go on politely
 * reading `undefined` and reporting that everything is out of stock, forever.
 *
 * So these tests are written from the Watcher's side of the wire: they name the
 * exact fields watcher/src/hub.ts destructures, and they go through the real
 * HTTP handler rather than the store, because the wire is what matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import type { Env } from '../src/types.ts';

const TOKEN = 'watcher-token';
const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
  APP_PASSWORD: 'pw',
};

const TARGET_URL = 'https://www.target.com/p/pokemon-tin/-/A-1012644666';

async function call(
  db: TestDb,
  method: string,
  path: string,
  body?: unknown,
  token: string = TOKEN,
): Promise<{ status: number; body: any }> {
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave it as text */
  }
  return { status: res.status, body: parsed };
}

async function withMission(over: Record<string, unknown> = {}) {
  const db = await TestDb.create();
  const product = await call(db, 'POST', '/api/products', {
    name: 'Mega Evolution Elite Trainer Box',
    msrp: 49.99,
  });
  const listing = await call(db, 'POST', '/api/listings', {
    productKey: product.body.product.key,
    url: TARGET_URL,
  });
  const mission = await call(db, 'POST', '/api/missions', {
    listingId: listing.body.listing.id,
    label: 'Mega Evolution ETB',
    checkEverySeconds: 30,
    ...over,
  });
  return { db, listingId: listing.body.listing.id, missionId: mission.body.mission.id };
}

/**
 * Every field watcher/src/hub.ts's `Mission` interface declares.
 *
 * If you add one there, add it here. This list existing is the point: a
 * rename on either side fails a test instead of failing silently at 3am.
 */
const MISSION_FIELDS = [
  'id',
  'listingId',
  'productKey',
  'productName',
  'retailer',
  'externalId',
  'url',
  'enabled',
  'armed',
  'ceiling',
  'quantity',
  'sellerPolicy',
  'preOrderPolicy',
  'checkEverySeconds',
  'state',
  'price',
  'lastCheckedAt',
  'checkNow',
] as const;

test('/api/missions/active gives the Watcher every field it reads', async () => {
  const { db } = await withMission();
  const { status, body } = await call(db, 'GET', '/api/missions/active');

  assert.equal(status, 200);
  assert.ok(Array.isArray(body.missions), 'the Watcher does `data.missions ?? []`');
  const [m] = body.missions;
  for (const field of MISSION_FIELDS) {
    assert.ok(field in m, `the Watcher reads mission.${field} and the Hub did not send it`);
  }
});

test('the mission the Watcher receives can actually be acted on', async () => {
  // Not just present — usable. `url` is what Playwright navigates to and
  // `externalId` is what the per-retailer readers match on; a blank either way
  // is a mission that can never succeed.
  const { db } = await withMission();
  const { body } = await call(db, 'GET', '/api/missions/active');
  const [m] = body.missions;

  assert.equal(m.retailer, 'Target');
  assert.equal(m.externalId, '1012644666');
  assert.match(m.url, /^https:\/\/www\.target\.com\//);
  assert.equal(typeof m.checkEverySeconds, 'number');
  assert.ok(m.checkEverySeconds >= 30);
});

test('a never-checked mission sends lastCheckedAt as empty, which the Watcher reads as due', async () => {
  // watcher/src/rate.ts: `isDue(m.lastCheckedAt || null, …)` returns true for
  // null. If this ever became the string "null" or an epoch date, a brand new
  // mission would sit there looking already-checked.
  const { db } = await withMission();
  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.missions[0].lastCheckedAt, '');
});

test('a paused mission is not handed to the Watcher at all', async () => {
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/api/missions', { listingId, enabled: false });
  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.deepEqual(body.missions, []);
});

test('the Watcher can post exactly the observation shape it builds', async () => {
  // Copied field-for-field from watcher/src/watch.ts's judge(), including the
  // ones that are usually null.
  const { db, listingId } = await withMission();
  const { status, body } = await call(db, 'POST', '/observations', {
    observations: [
      {
        listingId,
        state: 'in',
        confidence: 'exact',
        price: 49.99,
        sellerKind: 'retailer',
        sellerName: 'Target',
        availableQuantity: null,
        orderLimit: 4,
        isPreOrder: false,
        releaseDate: null,
        imageUrl: 'https://target.scene7.com/is/image/Target/GUEST_x',
        note: '',
      },
    ],
  });

  assert.equal(status, 200);
  const { body: after } = await call(db, 'GET', '/api/missions/active');
  const [m] = after.missions;
  assert.equal(m.state, 'in', 'the reading has to come back out again');
  assert.equal(m.price, 49.99);
  assert.notEqual(m.lastCheckedAt, '', 'and the mission is no longer never-checked');
});

test('a pre-order release date survives the round trip', async () => {
  // Half B is built on this date. A string that goes in and comes back as a
  // timestamp, or not at all, is a wrong cash-needed-on figure later.
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/observations', {
    observations: [
      { listingId, state: 'queue', confidence: 'exact', isPreOrder: true, releaseDate: '2026-09-26' },
    ],
  });
  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.missions[0].isPreOrder, true);
  assert.equal(body.missions[0].releaseDate, '2026-09-26');
});

test('the Watcher can post exactly the run shape it builds', async () => {
  const { db, missionId } = await withMission();
  const { status, body } = await call(db, 'POST', '/api/runs', {
    missionId,
    outcome: 'declined',
    reason: 'would have bought 1 at $49.99 ($49.99 total) — checkout is not built yet',
    state: 'in',
    price: 49.99,
    sellerKind: 'retailer',
    sellerName: 'Target',
    quantity: 1,
    total: 49.99,
  });

  assert.equal(status, 200);
  assert.ok(body.run, 'the Watcher checks nothing, but a silent no-op would be worse');

  const runs = await call(db, 'GET', `/api/missions/${missionId}/runs`);
  const [run] = runs.body.runs;
  assert.equal(run.outcome, 'declined');
  assert.match(run.reason, /checkout is not built yet/);
  assert.equal(run.total, 49.99);
});

test('every outcome the Watcher can produce is one the Hub accepts', async () => {
  // watcher/src/hub.ts's RunOutcome union, in full. A value the Hub rejects
  // would be buffered and retried forever, silently, by design.
  const { db, missionId } = await withMission();
  for (const outcome of ['in_stock', 'bought', 'declined', 'failed', 'blocked']) {
    const { status } = await call(db, 'POST', '/api/runs', {
      missionId,
      outcome,
      reason: `contract test: ${outcome}`,
    });
    assert.equal(status, 200, `the Hub refused outcome "${outcome}"`);
  }
});

test('the Watcher without its token gets nothing', async () => {
  // The mirror of the above: these endpoints are the Watcher's, and a wrong
  // INGEST_TOKEN must fail loudly rather than look like an empty watchlist.
  const { db, listingId } = await withMission();

  const missions = await call(db, 'GET', '/api/missions/active', undefined, 'wrong');
  assert.equal(missions.status, 401);

  const observations = await call(
    db,
    'POST',
    '/observations',
    { observations: [{ listingId, state: 'in' }] },
    'wrong',
  );
  assert.equal(observations.status, 401);
});

// ── Test run ─────────────────────────────────────────────────────────────────

test('a test run is queued, not performed — and says so', async () => {
  // The Hub has no browser. Answering 200 "checking now" would be a small lie
  // that makes every later timing question unanswerable.
  const { db, missionId } = await withMission();
  const { status, body } = await call(db, 'POST', `/api/missions/${missionId}/check-now`);

  assert.equal(status, 202, 'accepted, not done');
  assert.match(body.note, /next pass/);

  const active = await call(db, 'GET', '/api/missions/active');
  assert.equal(active.body.missions[0].checkNow, true, 'and the Watcher is told');
});

test('a test run on a mission that does not exist is a 404, not a silent no-op', async () => {
  const { db } = await withMission();
  const { status } = await call(db, 'POST', '/api/missions/9999/check-now');
  assert.equal(status, 404);
});

test('THE FLAG CLEARS WHEN THE READING ARRIVES, not when the button is pressed', async () => {
  // Clearing on request would tick the box for a check that never happened —
  // and a test run that silently did nothing is worse than no button.
  const { db, listingId, missionId } = await withMission();
  await call(db, 'POST', `/api/missions/${missionId}/check-now`);

  const stillPending = await call(db, 'GET', '/api/missions/active');
  assert.equal(stillPending.body.missions[0].checkNow, true);

  await call(db, 'POST', '/observations', {
    observations: [{ listingId, state: 'out', confidence: 'exact' }],
  });

  const after = await call(db, 'GET', '/api/missions/active');
  assert.equal(after.body.missions[0].checkNow, false);
});

test('an ordinary mission is not flagged for a test run', async () => {
  const { db } = await withMission();
  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.missions[0].checkNow, false);
});

// ── Settings: the half of the mandate that is not on the mission ─────────────

test('the Watcher is sent the settings its ceiling rule depends on', async () => {
  // A ceiling means item + tax. Without a rate the Watcher cannot judge a
  // listed price against it, so this travels with the watchlist.
  const { db } = await withMission();
  const { body } = await call(db, 'GET', '/api/missions/active');

  assert.ok(body.settings, '/api/missions/active must carry settings');
  assert.equal(typeof body.settings.taxRate, 'number');
  assert.equal(typeof body.settings.shippingAllowance, 'number');
});

test('settings default to the safe direction, not to nothing', async () => {
  // Zero tax means "do not estimate" — the real number is caught at the cart.
  // Zero shipping allowance means postage must be free. Both refuse rather
  // than assume.
  const { db } = await withMission();
  const { body } = await call(db, 'GET', '/api/settings');
  assert.equal(body.settings.taxRate, 0);
  assert.equal(body.settings.shippingAllowance, 0);
  // And the newer half of the mandate, which must also default to "no rule"
  // rather than to an accidental window that silently stops all watching.
  assert.equal(body.settings.activeFrom, '');
  assert.equal(body.settings.activeUntil, '');
  assert.equal(body.settings.paused, false);
});

test('settings round-trip through the API', async () => {
  const { db } = await withMission();
  const saved = await call(db, 'POST', '/api/settings', {
    taxRate: 0.0975,
    shippingAllowance: 9.99,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.taxRate, 0.0975);

  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.settings.taxRate, 0.0975);
  assert.equal(body.settings.shippingAllowance, 9.99);
});

test('A PERCENTAGE IN THE RATE FIELD IS REFUSED', async () => {
  // 9.75 where 0.0975 was meant would put every mission over its own ceiling
  // forever, and it would look like the prices were wrong.
  const { db } = await withMission();
  const { status, body } = await call(db, 'POST', '/api/settings', { taxRate: 9.75 });
  assert.equal(status, 400);
  assert.match(body.error, /looks like a percentage/);
});

test('negative money is refused in both fields', async () => {
  const { db } = await withMission();
  assert.equal((await call(db, 'POST', '/api/settings', { taxRate: -0.01 })).status, 400);
  assert.equal((await call(db, 'POST', '/api/settings', { shippingAllowance: -1 })).status, 400);
});

test('one setting can be changed without clearing the other', async () => {
  const { db } = await withMission();
  await call(db, 'POST', '/api/settings', { taxRate: 0.07, shippingAllowance: 5 });
  await call(db, 'POST', '/api/settings', { shippingAllowance: 8 });

  const { body } = await call(db, 'GET', '/api/settings');
  assert.equal(body.settings.taxRate, 0.07, 'a partial save must not blank what it omits');
  assert.equal(body.settings.shippingAllowance, 8);
});

// ── The fourth endpoint: the activity log ────────────────────────────────────

/**
 * Driven by the *real* Watcher classes, not by a hand-written request.
 *
 * Everything above names the fields watcher/src/hub.ts destructures, which
 * catches a rename on the Hub's side. This catches the other direction: it
 * imports the Watcher's own Activity and Hub, points their fetch at this
 * handler, and asserts the line survives the whole round trip. If either side
 * changes the shape, this stops compiling or stops passing.
 */
const watcherSrc = resolve(import.meta.dirname, '..', '..', 'watcher', 'src');
const haveWatcher = existsSync(join(watcherSrc, 'activity.ts'));

test('THE WATCHER OWN CODE CAN POST A LOG LINE THIS HUB ACCEPTS', async (t) => {
  if (!haveWatcher) return t.skip('the Watcher is not checked out beside the Hub');

  const { Activity } = await import(join(watcherSrc, 'activity.ts'));
  const { Hub } = await import(join(watcherSrc, 'hub.ts'));

  const db = await TestDb.create();
  const handler = createHandler(db, env);

  const hub = new Hub({
    url: 'https://hub.test',
    token: TOKEN,
    fetchImpl: ((input: RequestInfo, init?: RequestInit) =>
      handler(new Request(input as string, init))) as typeof fetch,
  });

  // No dir: this test is about the wire, and a temp directory it never reads
  // is one more thing to clean up.
  const log = new Activity({ sink: hub, secrets: [TOKEN], batchSize: 1 });
  log.record({
    kind: 'check',
    level: 'error',
    retailer: 'Target',
    ms: 1180,
    state: 'unknown',
    message: `could not read ${TARGET_URL}?visitor_id=018F2A9C3B4D5E6F7A8B`,
  });

  const { sent } = await log.flush(true);
  assert.equal(sent, 1, 'the Hub rejected what the Watcher actually sends');

  const exported = await call(db, 'GET', '/api/activity/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.counts.lines, 1);

  const [line] = exported.body.lines;
  assert.equal(line.retailer, 'Target', 'the retailer did not survive the wire');
  assert.equal(line.level, 'error');
  assert.equal(line.ms, 1180);
  assert.ok(line.message.includes('target.com'), 'the diagnosis did not survive');
  assert.ok(!line.message.includes('018F2A9C3B4D5E6F7A8B'), 'the visitor id survived, and must not');
  assert.deepEqual(exported.body.warnings, []);
});

test('THE PRE-ORDER POLICY REACHES THE WATCHER, OR IT CANNOT ENFORCE IT', async () => {
  // judge() declines a pre-order on this field. If the Hub stopped sending it
  // the Watcher would read undefined, which is not 'allow' — so it would fail
  // safe — but it would also silently ignore a mission set to allow them.
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/api/missions', { listingId, preOrderPolicy: 'allow' });

  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.missions[0].preOrderPolicy, 'allow');
});

test('a mission defaults to skipping pre-orders', async () => {
  // The safe direction, and the one a person who did not think about it wants:
  // a mission set up to catch a restock should not buy a November ship date.
  const { db } = await withMission();
  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.missions[0].preOrderPolicy, 'skip');
});

test('a nonsense policy is refused rather than stored', async () => {
  const { db, listingId } = await withMission();
  const res = await call(db, 'POST', '/api/missions', { listingId, preOrderPolicy: 'maybe' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /skip.*allow/);
});
