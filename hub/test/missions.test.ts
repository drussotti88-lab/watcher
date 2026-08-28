/**
 * Products, listings, missions and runs.
 *
 * The rules worth defending here are the ones about money. A mission is the
 * only thing in this system authorised to spend, so the tests that matter are
 * the ones that stop it: no ceiling means no arming, one mission per listing,
 * and a run that fails has to say why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import { identifyListing } from '../src/parsers/identify.ts';
import type { Env } from '../src/types.ts';

const TOKEN = 'watcher-token';
const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
  APP_PASSWORD: 'pw',
};

const call = async (db: TestDb, method: string, path: string, body?: unknown) => {
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
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
    /* leave as text */
  }
  return { status: res.status, body: parsed };
};

const TARGET_URL = 'https://www.target.com/p/pokemon-tin/-/A-1012644666';

async function withProduct(): Promise<{ db: TestDb; key: string }> {
  const db = await TestDb.create();
  const { body } = await call(db, 'POST', '/api/products', { name: 'Pitch Black Elite Trainer Box' });
  return { db, key: body.product.key };
}

// ── Reading a URL ────────────────────────────────────────────────────────────

test('a pasted URL yields its retailer and id without being told either', async () => {
  // The person has the URL. Asking them to also type "Target" and the tcin is
  // asking them to repeat what the link already says, and to mistype it.
  const cases: [string, string, string][] = [
    [TARGET_URL, 'Target', '1012644666'],
    ['https://www.target.com/p/-/A-1012644666', 'Target', '1012644666'],
    [
      'https://www.pokemoncenter.com/product/100-10326/journey-together',
      'Pokemon Center',
      '100-10326',
    ],
    ['https://www.walmart.com/ip/Pokemon-TCG-ETB/19988614228', 'Walmart', '19988614228'],
  ];
  for (const [url, retailer, id] of cases) {
    const got = identifyListing(url);
    assert.equal(got?.retailer, retailer, url);
    assert.equal(got?.externalId, id, url);
  }
});

test('a URL from somewhere we cannot read is refused, not guessed at', async () => {
  for (const url of [
    'https://www.amazon.com/dp/B0CJ1234',
    // A CATEGORY page, not a product. Target's own convention is the whole
    // difference: A- is an item, N- is a category. A mission pointed here would
    // poll a page with no product on it, forever, and report "unknown".
    'https://www.target.com/c/trading-cards/-/N-5tdv0',
    'https://www.walmart.com/browse/toys/trading-cards/4171_4187',
    'https://www.pokemoncenter.com/category/new-releases',
    'not a url at all',
    'https://www.target.com',
  ]) {
    assert.equal(identifyListing(url), null, url);
  }
});

test('adding a listing from a URL fills in the retailer and id', async () => {
  const { db, key } = await withProduct();
  const { status, body } = await call(db, 'POST', '/api/listings', { productKey: key, url: TARGET_URL });
  assert.equal(status, 200);
  assert.equal(body.listing.retailer, 'Target');
  assert.equal(body.listing.externalId, '1012644666');
});

test('a URL we cannot read comes back as a sentence, not a status code', async () => {
  const { db, key } = await withProduct();
  const { status, body } = await call(db, 'POST', '/api/listings', {
    productKey: key,
    url: 'https://www.amazon.com/dp/B0CJ1234',
  });
  assert.equal(status, 400);
  assert.match(body.error, /could not read a retailer/);
  assert.match(body.error, /target\.com/, 'and says what a good one looks like');
});

// ── Missions and money ───────────────────────────────────────────────────────

async function withMission(): Promise<{ db: TestDb; listingId: number; missionId: number }> {
  const { db, key } = await withProduct();
  const listing = await call(db, 'POST', '/api/listings', { productKey: key, url: TARGET_URL });
  const mission = await call(db, 'POST', '/api/missions', {
    listingId: listing.body.listing.id,
    label: 'Pitch Black ETB',
  });
  return { db, listingId: listing.body.listing.id, missionId: mission.body.mission.id };
}

test('a new mission watches and does not buy', async () => {
  const { db, missionId } = await withMission();
  const m = await store.getMission(db, missionId);
  assert.equal(m?.enabled, true);
  assert.equal(m?.armed, false, 'arming is never the default');
  assert.equal(m?.sellerPolicy, 'retailer_only', 'nor is buying from anyone who turns up');
});

test('ARMING WITHOUT A CEILING IS REFUSED — an open cheque is not a mandate', async () => {
  const { db, listingId } = await withMission();
  const { status, body } = await call(db, 'POST', '/api/missions', { listingId, armed: true });
  assert.equal(status, 400);
  assert.match(body.error, /ceiling before arming/);
  assert.match(body.error, /open cheque/);

  const still = await store.getMission(db, (await store.listMissions(db))[0]!.id);
  assert.equal(still?.armed, false, 'and the refusal must not half-apply');
});

test('arming with a ceiling is allowed', async () => {
  const { db, listingId } = await withMission();
  const { status, body } = await call(db, 'POST', '/api/missions', {
    listingId,
    armed: true,
    ceiling: 49.99,
    quantity: 2,
  });
  assert.equal(status, 200);
  assert.equal(body.mission.armed, true);
  assert.equal(body.mission.ceiling, 49.99);
  assert.equal(body.mission.quantity, 2);
});

test('nonsense mandates are refused in words', async () => {
  const { db, listingId } = await withMission();
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ quantity: 0 }, /whole number/],
    [{ quantity: 999 }, /whole number/],
    [{ ceiling: -5 }, /greater than zero/],
    [{ sellerPolicy: 'whoever' }, /retailer_only or any/],
    [{ checkEverySeconds: 1 }, /30 seconds/],
  ];
  for (const [patch, expected] of bad) {
    const { status, body } = await call(db, 'POST', '/api/missions', { listingId, ...patch });
    assert.equal(status, 400, JSON.stringify(patch));
    assert.match(body.error, expected, JSON.stringify(patch));
  }
});

test('ONE MISSION PER LISTING — two armed missions is two purchases', async () => {
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/api/missions', { listingId, armed: true, ceiling: 40 });
  await call(db, 'POST', '/api/missions', { listingId, armed: true, ceiling: 60 });

  const all = await store.listMissions(db);
  assert.equal(all.length, 1, 'the second is an edit of the first, never a second buyer');
  assert.equal(all[0]!.ceiling, 60, 'and the edit took effect');
});

test('a mission can be paused without losing its settings', async () => {
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/api/missions', { listingId, ceiling: 45, quantity: 3, enabled: false });
  const [m] = await store.listMissions(db);
  assert.equal(m!.enabled, false);
  assert.equal(m!.ceiling, 45, 'pausing is not forgetting');

  const active = await store.activeMissions(db);
  assert.equal(active.length, 0, 'and a paused mission is not polled');
});

test('deleting a product takes its listings, missions and runs with it', async () => {
  const { db, key } = await withProduct();
  const listing = await call(db, 'POST', '/api/listings', { productKey: key, url: TARGET_URL });
  const mission = await call(db, 'POST', '/api/missions', { listingId: listing.body.listing.id });
  await store.recordRun(db, mission.body.mission.id, { outcome: 'failed', reason: 'test' });

  await call(db, 'DELETE', `/api/products/${encodeURIComponent(key)}`);

  for (const table of ['products', 'listings', 'missions', 'mission_runs']) {
    const rows = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0]!.n, 0, `${table} should have cascaded away`);
  }
});

// ── Runs ─────────────────────────────────────────────────────────────────────

test('EVERY FAILURE CARRIES A REASON, even when nobody supplied one', async () => {
  // A run marked 'failed' with an empty reason is the log line you find at 3am
  // and learn nothing from.
  const { db, missionId } = await withMission();
  await store.recordRun(db, missionId, { outcome: 'failed' });
  const [run] = await store.missionRuns(db, missionId);
  assert.ok(run!.reason.length > 0);
  assert.match(run!.reason, /no reason recorded/);
});

test('a supplied reason is kept verbatim', async () => {
  const { db, missionId } = await withMission();
  await store.recordRun(db, missionId, {
    outcome: 'declined',
    reason: 'price 73.76 is over the 49.99 ceiling',
    price: 73.76,
    state: 'in',
  });
  const [run] = await store.missionRuns(db, missionId);
  assert.equal(run!.outcome, 'declined');
  assert.match(run!.reason, /over the 49.99 ceiling/);
  assert.equal(run!.price, 73.76);
});

test('a run records how long it took, which is how we learn our real speed', async () => {
  const { db, missionId } = await withMission();
  const id = await store.startRun(db, missionId);
  await new Promise((r) => setTimeout(r, 25));
  await store.finishRun(db, id, { outcome: 'bought', quantity: 1, total: 49.99 });

  const [run] = await store.missionRuns(db, missionId);
  assert.equal(run!.outcome, 'bought');
  assert.ok(run!.ms !== null && run!.ms >= 20, `expected a measured duration, got ${run!.ms}`);
  assert.equal(run!.total, 49.99);
});

test('a run that never finishes stays visibly running', async () => {
  // Exactly the signal you want: something started and nothing closed it.
  const { db, missionId } = await withMission();
  await store.startRun(db, missionId);
  const [run] = await store.missionRuns(db, missionId);
  assert.equal(run!.outcome, 'running');
  assert.equal(run!.finishedAt, '');
});

test('the Watcher can post a finished run over HTTP', async () => {
  const { db, missionId } = await withMission();
  const { status } = await call(db, 'POST', '/api/runs', {
    missionId,
    outcome: 'blocked',
    reason: 'Cloudflare challenge — backing off for 20 minutes',
    state: 'unknown',
  });
  assert.equal(status, 200);
  const [run] = await store.missionRuns(db, missionId);
  assert.equal(run!.outcome, 'blocked');
  assert.match(run!.reason, /backing off/);
});

test('a run with no settled outcome is refused', async () => {
  const { db, missionId } = await withMission();
  assert.equal((await call(db, 'POST', '/api/runs', { missionId })).status, 400);
  assert.equal(
    (await call(db, 'POST', '/api/runs', { missionId, outcome: 'running' })).status,
    400,
    'a run is recorded when it is over, not while it is going',
  );
});

test('mission run history is per mission, not one global pile', async () => {
  const { db, missionId } = await withMission();
  const other = await withMission();
  await store.recordRun(db, missionId, { outcome: 'failed', reason: 'mine' });
  await store.recordRun(other.db, other.missionId, { outcome: 'failed', reason: 'theirs' });

  const runs = await store.missionRuns(db, missionId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.reason, 'mine');
});

// ── Images ───────────────────────────────────────────────────────────────────

test('the first image the Watcher sees is kept, and never overwritten', async () => {
  const { db, listingId } = await withMission();
  await store.recordObservation(db, {
    listingId,
    state: 'out',
    imageUrl: 'https://target.scene7.com/first.jpg',
  });
  assert.equal((await store.listProducts(db))[0]!.imageUrl, 'https://target.scene7.com/first.jpg');

  // Retailer CDN URLs churn. A working image beats a newer one.
  await store.recordObservation(db, {
    listingId,
    state: 'in',
    imageUrl: 'https://target.scene7.com/second.jpg',
  });
  assert.equal((await store.listProducts(db))[0]!.imageUrl, 'https://target.scene7.com/first.jpg');
});

test('a reading with no image leaves the product alone', async () => {
  const { db, listingId } = await withMission();
  await store.recordObservation(db, { listingId, state: 'out', imageUrl: 'https://x/a.jpg' });
  await store.recordObservation(db, { listingId, state: 'in' });
  assert.equal((await store.listProducts(db))[0]!.imageUrl, 'https://x/a.jpg');
});

test('the seller the Watcher saw is remembered on the listing', async () => {
  // So a mission's seller policy has something to read before the next check.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, {
    listingId,
    state: 'in',
    sellerKind: 'marketplace',
    sellerName: 'Rares Market L.L.C.',
  });
  const [l] = await store.listListings(db);
  assert.equal(l!.sellerKind, 'marketplace');
  assert.match(l!.sellerName, /Rares Market/);
});

// ── The page's payload ───────────────────────────────────────────────────────

test('the dashboard hands the page everything it renders, in one request', async () => {
  const { db } = await withMission();
  const { status, body } = await call(db, 'GET', '/api/dashboard');
  assert.equal(status, 200);
  for (const key of ['missions', 'runs', 'changes', 'products', 'listings']) {
    assert.ok(Array.isArray(body[key]), `${key} missing from the dashboard payload`);
  }
  assert.equal(body.missions.length, 1);
  assert.equal(body.missions[0].state, 'unchecked', 'never polled, and says so');
});

test('active missions are what the Watcher polls, and carry the mandate', async () => {
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/api/missions', { listingId, armed: true, ceiling: 49.99, quantity: 2 });

  const { body } = await call(db, 'GET', '/api/missions/active');
  assert.equal(body.missions.length, 1);
  const m = body.missions[0];
  assert.equal(m.url, TARGET_URL, 'it needs somewhere to look');
  assert.equal(m.retailer, 'Target', 'and which reader to use');
  assert.equal(m.armed, true);
  assert.equal(m.ceiling, 49.99, 'a number, not a Postgres string');
  assert.equal(m.sellerPolicy, 'retailer_only');
});
