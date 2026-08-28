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
  'checkEverySeconds',
  'state',
  'price',
  'lastCheckedAt',
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
