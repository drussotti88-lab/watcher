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

/** Everything that existed before ownership did belongs to the first user. */
const USER = 1;

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import { identifyListing } from '../src/parsers/identify.ts';
import type { Env } from '../src/types.ts';

const TOKEN = 'Phantom-token';
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

/**
 * The same call, against an env of this test's choosing.
 *
 * Used by the routing tests, which need webhooks CONFIGURED to have anything
 * to route. The URLs point at a closed local port on purpose: post() swallows
 * a failed send by design, so this exercises every line of the routing and
 * refuses instantly at the wire instead of resolving a fake hostname.
 */
const callWith = async (
  db: TestDb,
  over: Partial<Env>,
  method: string,
  path: string,
  body?: unknown,
) => {
  const res = await createHandler(db, { ...env, ...over })(
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

/** Closed ports. post() fails at connect and swallows it, which is the point. */
const MAIN_ROOM = 'http://127.0.0.1:1/main';
const WALMART_ROOM = 'http://127.0.0.1:1/walmart';

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
  const m = await store.getMission(db, USER, missionId);
  assert.equal(m?.enabled, true);
  assert.equal(m?.armed, false, 'arming is never the default');
  assert.equal(m?.sellerPolicy, 'retailer_only', 'nor is buying from anyone who turns up');
});

test('ARMING WITHOUT A CEILING IS REFUSED — an open cheque is not a mandate', async () => {
  const { db, listingId } = await withMission();
  // A cap exists, so the refusal under test is the ceiling one. Arming with
  // no cap at all is its own refusal, tested in authorise.test.ts.
  await store.setSettings(db, USER, { spendCapDay: 500 });
  const { status, body } = await call(db, 'POST', '/api/missions', { listingId, armed: true });
  assert.equal(status, 400);
  assert.match(body.error, /ceiling before arming/);
  assert.match(body.error, /open cheque/);

  const still = await store.getMission(db, USER, (await store.listMissions(db, USER))[0]!.id);
  assert.equal(still?.armed, false, 'and the refusal must not half-apply');
});

test('arming with a ceiling is allowed', async () => {
  const { db, listingId } = await withMission();
  await store.setSettings(db, USER, { spendCapDay: 500 });
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
  await store.setSettings(db, USER, { spendCapDay: 500 });
  await call(db, 'POST', '/api/missions', { listingId, armed: true, ceiling: 40 });
  await call(db, 'POST', '/api/missions', { listingId, armed: true, ceiling: 60 });

  const all = await store.listMissions(db, USER);
  assert.equal(all.length, 1, 'the second is an edit of the first, never a second buyer');
  assert.equal(all[0]!.ceiling, 60, 'and the edit took effect');
});

test('a mission can be paused without losing its settings', async () => {
  const { db, listingId } = await withMission();
  await call(db, 'POST', '/api/missions', { listingId, ceiling: 45, quantity: 3, enabled: false });
  const [m] = await store.listMissions(db, USER);
  assert.equal(m!.enabled, false);
  assert.equal(m!.ceiling, 45, 'pausing is not forgetting');

  const active = await store.activeMissions(db, USER);
  assert.equal(active.length, 0, 'and a paused mission is not polled');
});

test('deleting a product takes its listings, missions and runs with it', async () => {
  const { db, key } = await withProduct();
  const listing = await call(db, 'POST', '/api/listings', { productKey: key, url: TARGET_URL });
  const mission = await call(db, 'POST', '/api/missions', { listingId: listing.body.listing.id });
  await store.recordRun(db, USER, mission.body.mission.id, { outcome: 'failed', reason: 'test' });

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
  await store.recordRun(db, USER, missionId, { outcome: 'failed' });
  const [run] = await store.missionRuns(db, USER, missionId);
  assert.ok(run!.reason.length > 0);
  assert.match(run!.reason, /no reason recorded/);
});

test('a supplied reason is kept verbatim', async () => {
  const { db, missionId } = await withMission();
  await store.recordRun(db, USER, missionId, {
    outcome: 'declined',
    reason: 'price 73.76 is over the 49.99 ceiling',
    price: 73.76,
    state: 'in',
  });
  const [run] = await store.missionRuns(db, USER, missionId);
  assert.equal(run!.outcome, 'declined');
  assert.match(run!.reason, /over the 49.99 ceiling/);
  assert.equal(run!.price, 73.76);
});

test('a run records how long it took, which is how we learn our real speed', async () => {
  const { db, missionId } = await withMission();
  const id = await store.startRun(db, USER, missionId);
  await new Promise((r) => setTimeout(r, 25));
  await store.finishRun(db, USER, id, { outcome: 'bought', quantity: 1, total: 49.99 });

  const [run] = await store.missionRuns(db, USER, missionId);
  assert.equal(run!.outcome, 'bought');
  assert.ok(run!.ms !== null && run!.ms >= 20, `expected a measured duration, got ${run!.ms}`);
  assert.equal(run!.total, 49.99);
});

test('a run that never finishes stays visibly running', async () => {
  // Exactly the signal you want: something started and nothing closed it.
  const { db, missionId } = await withMission();
  await store.startRun(db, USER, missionId);
  const [run] = await store.missionRuns(db, USER, missionId);
  assert.equal(run!.outcome, 'running');
  assert.equal(run!.finishedAt, '');
});

test('Phantom can post a finished run over HTTP', async () => {
  const { db, missionId } = await withMission();
  const { status } = await call(db, 'POST', '/api/runs', {
    missionId,
    outcome: 'blocked',
    reason: 'Cloudflare challenge — backing off for 20 minutes',
    state: 'unknown',
  });
  assert.equal(status, 200);
  const [run] = await store.missionRuns(db, USER, missionId);
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
  await store.recordRun(db, USER, missionId, { outcome: 'failed', reason: 'mine' });
  await store.recordRun(other.db, USER, other.missionId, { outcome: 'failed', reason: 'theirs' });

  const runs = await store.missionRuns(db, USER, missionId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.reason, 'mine');
});

// ── Images ───────────────────────────────────────────────────────────────────

test('the first image Phantom sees is kept, and never overwritten', async () => {
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, {
    listingId,
    state: 'out',
    imageUrl: 'https://target.scene7.com/first.jpg',
  });
  assert.equal((await store.listProducts(db, USER))[0]!.imageUrl, 'https://target.scene7.com/first.jpg');

  // Retailer CDN URLs churn. A working image beats a newer one.
  await store.recordObservation(db, USER, {
    listingId,
    state: 'in',
    imageUrl: 'https://target.scene7.com/second.jpg',
  });
  assert.equal((await store.listProducts(db, USER))[0]!.imageUrl, 'https://target.scene7.com/first.jpg');
});

test('a reading with no image leaves the product alone', async () => {
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'out', imageUrl: 'https://x/a.jpg' });
  await store.recordObservation(db, USER, { listingId, state: 'in' });
  assert.equal((await store.listProducts(db, USER))[0]!.imageUrl, 'https://x/a.jpg');
});

test('the seller Phantom saw is remembered on the listing', async () => {
  // So a mission's seller policy has something to read before the next check.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, {
    listingId,
    state: 'in',
    sellerKind: 'marketplace',
    sellerName: 'Rares Market L.L.C.',
  });
  const [l] = await store.listListings(db, USER);
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

test('active missions are what Phantom polls, and carry the mandate', async () => {
  const { db, listingId } = await withMission();
  await store.setSettings(db, USER, { spendCapDay: 500 });
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

// ── Quick add ────────────────────────────────────────────────────────────────

test('quick add turns one URL into a watched mission', async () => {
  const db = await TestDb.create();
  const { status, body } = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });

  assert.equal(status, 201);
  assert.equal(body.alreadyTracked, false);
  assert.equal(body.listing.retailer, 'Target');
  assert.equal(body.listing.externalId, '1012644666');
  assert.ok(body.mission.id);
});

test('QUICK ADD NEVER ARMS ANYTHING', async () => {
  // Arming is a decision. A decision does not belong inside a shortcut you
  // press on a phone while walking.
  const db = await TestDb.create();
  const { body } = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });

  assert.equal(body.mission.armed, false);
  assert.equal(body.mission.ceiling, null);
  assert.equal(body.mission.enabled, true, 'but it does start watching');
});

test('quick-adding the same URL twice does not make a second buyer', async () => {
  // Two missions on one listing is two checkouts racing each other.
  const db = await TestDb.create();
  const first = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });
  const again = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL + '?ref=whatever' });

  assert.equal(again.body.alreadyTracked, true);
  assert.equal(again.body.mission.id, first.body.mission.id);
  assert.equal((await store.listMissions(db, USER)).length, 1);
});

test('quick add refuses a URL it cannot identify, in words', async () => {
  const db = await TestDb.create();
  const { status, body } = await call(db, 'POST', '/api/quick-add', {
    url: 'https://www.target.com/c/trading-cards/-/N-5tdv0',
  });
  assert.equal(status, 400);
  assert.match(body.error, /could not read a retailer and product id/);
});

test('quick add on a listing that already exists adopts it rather than duplicating', async () => {
  const db = await TestDb.create();
  const product = await call(db, 'POST', '/api/products', { name: 'Pitch Black ETB' });
  const listing = await call(db, 'POST', '/api/listings', {
    productKey: product.body.product.key,
    url: TARGET_URL,
  });

  const { body } = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });
  assert.equal(body.listing.id, listing.body.listing.id);
  assert.equal((await store.listListings(db, USER)).length, 1);
});

test('quick add carries the product details you typed, not just the link', async () => {
  const db = await TestDb.create();
  const { body } = await call(db, 'POST', '/api/quick-add', {
    url: TARGET_URL,
    name: 'Ascended Heroes Elite Trainer Box',
    msrp: 59.99,
    releaseDate: '2026-09-26',
  });

  assert.equal(body.product.name, 'Ascended Heroes Elite Trainer Box');
  assert.equal(body.product.msrp, 59.99);
  assert.equal(body.product.releaseDate, '2026-09-26');
});

test('A SLUG GUESS NEVER OVERWRITES A NAME SOMEONE CHOSE', async () => {
  // Quick-adding a URL that is already tracked must not rename the product to
  // whatever the link happens to say.
  const db = await TestDb.create();
  await call(db, 'POST', '/api/quick-add', { url: TARGET_URL, name: 'Pitch Black ETB', msrp: 49.99 });

  await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });

  const [p] = await store.listProducts(db, USER);
  assert.equal(p!.name, 'Pitch Black ETB');
  assert.equal(p!.msrp, 49.99);
});

test('but details typed against an already-tracked link are saved', async () => {
  const db = await TestDb.create();
  await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });
  await call(db, 'POST', '/api/quick-add', {
    url: TARGET_URL,
    name: 'Pitch Black Elite Trainer Box',
    msrp: 49.99,
  });

  const [p] = await store.listProducts(db, USER);
  assert.equal(p!.name, 'Pitch Black Elite Trainer Box');
  assert.equal(p!.msrp, 49.99);
  assert.equal((await store.listMissions(db, USER)).length, 1, 'and still one mission');
});

test('A PRODUCT IS NOT TIED TO THE URL IT ARRIVED WITH', async () => {
  // The whole reason the URL is optional. One product, the same product, at a
  // second retailer.
  const db = await TestDb.create();
  const first = await call(db, 'POST', '/api/quick-add', {
    url: TARGET_URL,
    name: 'Chaos Rising ETB',
  });
  const key = first.body.product.key;

  await call(db, 'POST', '/api/listings', {
    productKey: key,
    url: 'https://www.walmart.com/ip/Pokemon-TCG-ETB/19988614228',
  });

  const listings = await store.listListings(db, USER, key);
  assert.equal(listings.length, 2);
  assert.deepEqual(
    listings.map((l) => l.retailer).sort(),
    ['Target', 'Walmart'],
    'one product, two places to watch it',
  );
  assert.equal((await store.listProducts(db, USER)).length, 1, 'and still one product');
});

// ── The name a slug guessed at ───────────────────────────────────────────────

test('THE PAGE REPLACES A NAME THE URL GUESSED AT', async () => {
  // Target's slug encodes "Pokémon" as "pok-233-mon", which titleises into
  // "Pok 233 Mon Trading Card Game 30th Celebration Elite Trainer Box". The
  // retailer's own page knows better, so the first real read wins.
  const db = await TestDb.create();
  const added = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });
  assert.match(added.body.product.name, /Pokemon Tin|Pok/i, 'the guess is what a slug gives');

  await call(db, 'POST', '/observations', {
    observations: [
      {
        listingId: added.body.listing.id,
        state: 'out',
        confidence: 'exact',
        productName: 'Pokémon TCG: 30th Celebration Elite Trainer Box',
      },
    ],
  });

  const [p] = await store.listProducts(db, USER);
  assert.equal(p!.name, 'Pokémon TCG: 30th Celebration Elite Trainer Box');
});

test('A NAME YOU TYPED IS NEVER OVERWRITTEN BY THE PAGE', async () => {
  const db = await TestDb.create();
  const added = await call(db, 'POST', '/api/quick-add', {
    url: TARGET_URL,
    name: '30th Celebration ETB',
  });

  await call(db, 'POST', '/observations', {
    observations: [
      {
        listingId: added.body.listing.id,
        state: 'out',
        confidence: 'exact',
        productName: 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box',
      },
    ],
  });

  const [p] = await store.listProducts(db, USER);
  assert.equal(p!.name, '30th Celebration ETB', 'yours, not theirs');
});

test('the page only gets to name it once', async () => {
  // After the first read the name is no longer a guess, so a later page title
  // change does not quietly rename a product you have been watching.
  const db = await TestDb.create();
  const added = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });
  const obs = (productName: string) =>
    call(db, 'POST', '/observations', {
      observations: [{ listingId: added.body.listing.id, state: 'out', confidence: 'exact', productName }],
    });

  await obs('30th Celebration Elite Trainer Box');
  await obs('SOMETHING ELSE ENTIRELY');

  const [p] = await store.listProducts(db, USER);
  assert.equal(p!.name, '30th Celebration Elite Trainer Box');
});

test('an empty name from a failed read changes nothing', async () => {
  // A check that could not complete has no name to offer, and must not blank
  // the one we have.
  const db = await TestDb.create();
  const added = await call(db, 'POST', '/api/quick-add', { url: TARGET_URL });
  const before = (await store.listProducts(db, USER))[0]!.name;

  await call(db, 'POST', '/observations', {
    observations: [{ listingId: added.body.listing.id, state: 'unknown', confidence: 'unknown', productName: '' }],
  });

  assert.equal((await store.listProducts(db, USER))[0]!.name, before);
});

// ── Stock appearing, and the question it exists to answer ────────────────────
//
// "Will we see the count go up before a drop?" On all three retailers today the
// answer is no — the number is 0 or absent while out of stock and appears with
// the drop, not before it. But that is an observation about how three websites
// behave this month, not a law, and it was being asserted rather than measured:
// a quantity moving while the state stayed 'out' wrote no history row at all.
//
// These tests make the question answerable from data.

test('A COUNT APPEARING FROM NOTHING IS AN EVENT, EVEN WHILE STILL OUT OF STOCK', async () => {
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'out', availableQuantity: 0 });

  const outcome = await store.recordObservation(db, USER, {
    listingId,
    state: 'out',
    availableQuantity: 40,
  });

  assert.equal(outcome.changed, true, 'inventory appeared and nothing recorded it');
  const history = await store.recentObservations(db, USER, 10);
  assert.equal(history.length, 2, 'the appearance should be in the history, not only the latest row');
});

test('a count going to zero is an event too', async () => {
  // The end of a drop. Worth a row for the same reason the start is.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'in', availableQuantity: 12 });
  const outcome = await store.recordObservation(db, USER, {
    listingId,
    state: 'in',
    availableQuantity: 0,
  });
  assert.equal(outcome.changed, true);
});

test('THE STEPS IN BETWEEN ARE NOT EVENTS', async () => {
  // A live drop ticks 20, 18, 14, 9. A row for each is the flood this table
  // exists to prevent — that time series belongs in the activity log, which
  // records every check by design.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'in', availableQuantity: 20 });

  for (const q of [18, 14, 9]) {
    const outcome = await store.recordObservation(db, USER, {
      listingId,
      state: 'in',
      availableQuantity: q,
    });
    assert.equal(outcome.changed, false, `${q} should not be an event on its own`);
  }
  assert.equal((await store.recentObservations(db, USER, 10)).length, 1);
});

test('a retailer that never states a count does not look like a change', async () => {
  // Pokemon Center gives availability and no number, ever. Null must not read
  // as "the count went away".
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'out' });
  const outcome = await store.recordObservation(db, USER, { listingId, state: 'out' });
  assert.equal(outcome.changed, false);
});

// ── Keeping and forgetting ───────────────────────────────────────────────────

async function withDiscovery(): Promise<{ db: TestDb; id: number }> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('target-tcg', 'Target TCG', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, true)`,
  );
  await store.recordDiscoveries(db, USER, 'target-tcg', [
    {
      externalId: '1010892076',
      name: 'Pokemon 30th Celebration Elite Trainer Box',
      url: 'https://www.target.com/p/-/A-1010892076',
      price: 69.99,
      kind: 'elite trainer box',
      confidence: 'sealed',
      foundBy: 'pokemon elite trainer box',
    },
  ], true);
  const [found] = await store.discoveriesToReview(db, USER);
  return { db, id: found!.id };
}

test('a sweep result waits for a decision, carrying what the sweep thought', async () => {
  const { db } = await withDiscovery();
  const [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.status, 'new');
  assert.equal(found!.kind, 'elite trainer box');
  assert.equal(found!.confidence, 'sealed');
  assert.equal(found!.foundBy, 'pokemon elite trainer box');
  assert.equal(found!.alreadyHave, false);
});

test('KEEPING MAKES SOMETHING WATCHED AND NOTHING ARMED', async () => {
  // The safety property is about money, not about missions: a sweep is a
  // machine's guess and spending is a decision, so nothing a Keep creates may
  // be armed. But keeping IS the decision to watch — this used to stop at the
  // listing, and the difference was invisible until release week: seventeen
  // kept finds, three missions, nothing polling the rest. Eyes, not a wallet.
  const { db, id } = await withDiscovery();
  const kept = await store.keepDiscovery(db, USER, id);

  const products = await store.listProducts(db, USER);
  const listings = await store.listListings(db, USER);
  const missions = await store.listMissions(db, USER);

  assert.equal(products.length, 1);
  assert.equal(listings.length, 1);
  assert.equal(listings[0]!.externalId, '1010892076');
  assert.equal(kept.productKey, products[0]!.key);
  assert.equal(missions.length, 1, 'kept means watched — a mission exists');
  assert.equal(missions[0]!.id, kept.missionId);
  assert.equal(missions[0]!.enabled, true, 'watching from the moment it is kept');
  assert.equal(missions[0]!.armed, false, 'and NEVER armed — arming is its own act');
  assert.equal(missions[0]!.ceiling, null, 'no ceiling either: nothing here can spend');
});

test('a kept find leaves the review list', async () => {
  const { db, id } = await withDiscovery();
  await store.keepDiscovery(db, USER, id);
  assert.equal((await store.discoveriesToReview(db, USER)).length, 0);
});

test('FORGETTING IS REMEMBERED, SO THE NEXT SWEEP DOES NOT RE-OFFER IT', async () => {
  // The property that makes the feed usable. Without it, every sweep re-offers
  // the thirty things already rejected and the feed becomes noise.
  const { db, id } = await withDiscovery();
  assert.equal(await store.forgetDiscovery(db, USER, id), true);
  assert.equal((await store.discoveriesToReview(db, USER)).length, 0);

  // The same sweep runs again and finds the same thing.
  const known = await store.knownIds(db, USER, 'target-tcg');
  assert.ok(known.has('1010892076'), 'a forgotten row is still a row that has been seen');
});

test('a decision cannot be made twice', async () => {
  const { db, id } = await withDiscovery();
  await store.forgetDiscovery(db, USER, id);
  assert.equal(await store.forgetDiscovery(db, USER, id), false);
  await assert.rejects(() => store.keepDiscovery(db, USER, id), /already forgotten/);
});

test('a find you already watch says so rather than hiding', async () => {
  const { db, id } = await withDiscovery();
  await store.keepDiscovery(db, USER, id);

  await store.recordDiscoveries(db, USER, 'target-tcg', [
    { externalId: '1010892076', name: 'the same box again', url: 'u', price: 69.99 },
  ], true);
  // The unique key means it is the same row, already decided, so it does not
  // come back. That is the desired behaviour and worth pinning.
  assert.equal((await store.discoveriesToReview(db, USER)).length, 0);
});

test('FINDS ARE SHARED, BUT DECIDING THEM IS CURATION', async () => {
  // INVERTED 1 Sep 2026. A find used to belong to whoever swept it up. The
  // sweep is now one sweep, so the finds are one list — but "keep this" mints
  // catalogue rows everybody watches against, and "forget this" is a judgement
  // that sticks for everybody. Reading is open; deciding is a role.
  const { db, id } = await withDiscovery();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");

  assert.ok((await store.discoveriesToReview(db, 2)).length > 0, 'a member sees the finds');

  assert.equal(await store.forgetDiscovery(db, 2, id), false, 'but cannot bury one');
  await assert.rejects(() => store.keepDiscovery(db, 2, id), /may not add to the catalogue/);

  // Still there, still undecided, for the person whose job it is.
  assert.ok((await store.discoveriesToReview(db, USER)).some((d) => d.id === id));
});

// ── When a sweep is due ──────────────────────────────────────────────────────
//
// Deliberately the Hub's decision. Phantom restarts — sometimes twice a
// minute while something is being fixed — and a restart must not mean another
// sweep of the whole catalogue.

test('a source that has never been swept is due immediately', () => {
  assert.equal(store.isSweepDue(null, 24, Date.parse('2026-08-30T00:00:00Z')), true);
});

test('a sweep from an hour ago is not due on a daily schedule', () => {
  const hourAgo = '2026-08-29T23:00:00Z';
  assert.equal(store.isSweepDue(hourAgo, 24, Date.parse('2026-08-30T00:00:00Z')), false);
});

test('a sweep from yesterday is due', () => {
  const yesterday = '2026-08-28T23:00:00Z';
  assert.equal(store.isSweepDue(yesterday, 24, Date.parse('2026-08-30T00:00:00Z')), true);
});

test('ZERO HOURS MEANS NEVER, NOT ALWAYS', () => {
  // The failure that would sweep the catalogue every ninety seconds forever.
  assert.equal(store.isSweepDue(null, 0, Date.now()), false);
  assert.equal(store.isSweepDue('2020-01-01T00:00:00Z', 0, Date.now()), false);
});

test('an unreadable timestamp is treated as never swept, not as just swept', () => {
  // Failing towards doing the work. The opposite would be a sweep that
  // silently never runs again.
  assert.equal(store.isSweepDue('not a date', 24, Date.now()), true);
});

// ── Asking by hand ───────────────────────────────────────────────────────────

async function withSource(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('target-tcg', 'Target TCG', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, true)`,
  );
  return db;
}

test('THE BUTTON BEATS THE SCHEDULE', async () => {
  // Swept a minute ago, so nothing is due — but pressing the button is a
  // clearer statement of intent than any interval.
  const db = await withSource();
  await store.finishSweep(db, USER, 'target-tcg', 'ok', 5, true);
  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), false);

  await store.requestSweep(db, USER, 'target-tcg');
  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), true);
});

test('the button works even when sweeping is switched off entirely', async () => {
  const db = await withSource();
  await store.finishSweep(db, USER, 'target-tcg', 'ok', 5, true);
  await store.requestSweep(db, USER, 'target-tcg');
  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 0), true);
});

test('A REQUEST IS CLEARED BY FINISHING, NEVER BY ASKING', async () => {
  // A sweep that was requested and never ran must stay queued. Clearing on
  // read would drop it silently the first time Phantom was asleep.
  const db = await withSource();
  await store.requestSweep(db, USER, 'target-tcg');

  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), true);
  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), true, 'still queued after a read');

  await store.finishSweep(db, USER, 'target-tcg', 'Phantom: 3 new', 20, true);
  assert.equal((await store.sweepState(db, USER, 'target-tcg', 24)).queued, false);
});

test('a disabled source is never swept, by hand or by schedule', async () => {
  const db = await withSource();
  await db.query("UPDATE sources SET enabled = false WHERE user_id = $1 AND id = 'target-tcg'", [USER]);
  assert.equal(await store.requestSweep(db, USER, 'target-tcg'), false);
  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), false);
});

test('a source that does not exist is not an error, just not due', async () => {
  const db = await TestDb.create();
  assert.equal(await store.sweepDue(db, USER, 'nope', 24), false);
  assert.deepEqual(await store.sweepState(db, USER, 'nope', 24), {
    queued: false, lastSweptAt: null, lastStatus: '',
  });
});

test('MY SWEEP REQUEST IS NOT YOURS', async () => {
  const db = await withSource();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");
  assert.equal(await store.requestSweep(db, 2, 'target-tcg'), false);
  assert.equal(await store.sweepDue(db, 2, 'target-tcg', 24), false);
});


// ── found_by has to name every query, not just the first ─────────────────────
//
// It named only the first, and that made a working sweep look broken: the same
// TCIN comes back for half a dozen queries, so query one claimed every product
// and the twelve after it appeared to find nothing.

async function withTargetSource(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('target-tcg', 'Target TCG', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, true)`,
  );
  return db;
}

const sighting = (over: Record<string, unknown> = {}) => ({
  externalId: '1010892076',
  name: 'Pokemon 30th Celebration Elite Trainer Box',
  url: 'https://www.target.com/p/-/A-1010892076',
  price: 69.99,
  kind: 'elite trainer box',
  confidence: 'sealed',
  foundBy: 'pokemon elite trainer box',
  ...over,
});

test('A SECOND QUERY THAT FINDS THE SAME THING IS RECORDED, NOT DISCARDED', async () => {
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting()], true);
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ foundBy: 'pokemon ex box' })], true);

  const [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.foundBy, 'pokemon elite trainer box, pokemon ex box');
});

test('the same query twice does not repeat itself', async () => {
  const db = await withTargetSource();
  for (let i = 0; i < 3; i += 1) {
    await store.recordDiscoveries(db, USER, 'target-tcg', [sighting()], true);
  }
  const [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.foundBy, 'pokemon elite trainer box');
});

test('A QUERY THAT IS A PREFIX OF ANOTHER IS STILL RECORDED', async () => {
  // The reason the check is against a comma-delimited list and not a bare
  // substring: "pokemon tin" sits inside "pokemon tin bundle", so a substring
  // test would decide it was already there and quietly drop it.
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ foundBy: 'pokemon tin bundle' })], true);
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ foundBy: 'pokemon tin' })], true);

  const [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.foundBy, 'pokemon tin bundle, pokemon tin');
});

test('the list of queries cannot grow without limit', async () => {
  const db = await withTargetSource();
  for (let i = 0; i < 60; i += 1) {
    await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ foundBy: `query number ${i}` })], true);
  }
  const [found] = await store.discoveriesToReview(db, USER);
  assert.ok(found!.foundBy.length < 500, `found_by grew to ${found!.foundBy.length}`);
});

test('a label fills in when it was blank, and is never overwritten once set', async () => {
  // Rows added before the classifier existed get labelled the next time they
  // are seen. A row already labelled is not relabelled by a query that guessed
  // worse.
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ kind: '', confidence: '' })], true);
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting()], true);
  let [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.kind, 'elite trainer box');
  assert.equal(found!.confidence, 'sealed');

  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ kind: 'tin', confidence: 'unsure' })], true);
  [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.kind, 'elite trainer box', 'the first confident answer stands');
});

test('a repeat sighting does not resurrect something already decided', async () => {
  // Forget has to mean forget. Otherwise every sweep re-offers what was
  // rejected, which is the whole reason the status column exists.
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting()], true);
  const [found] = await store.discoveriesToReview(db, USER);
  await store.forgetDiscovery(db, USER, found!.id);

  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ foundBy: 'pokemon ex box' })], true);
  assert.equal((await store.discoveriesToReview(db, USER)).length, 0);
});

// ── A sweep is not finished until its last query ─────────────────────────────

test('A MID-SWEEP REPORT DOES NOT MARK THE SWEEP DONE', async () => {
  // Every query used to stamp last_swept_at and clear the manual request, so a
  // sweep declared itself finished after its first of thirteen queries — and a
  // restart part-way through lost the rest with nothing due again for a day.
  const db = await withTargetSource();
  await store.requestSweep(db, USER, 'target-tcg');

  await store.finishSweep(db, USER, 'target-tcg', 'Phantom: 1 new', 24, true, 0, false);

  const state = await store.sweepState(db, USER, 'target-tcg', 24);
  assert.equal(state.queued, true, 'the request must survive until the sweep really ends');
  assert.equal(state.lastSweptAt, null, 'and nothing has been swept yet');
  assert.equal(state.lastStatus, 'Phantom: 1 new', 'but progress is still reported');
});

test('the last query does finish it', async () => {
  const db = await withTargetSource();
  await store.requestSweep(db, USER, 'target-tcg');
  await store.finishSweep(db, USER, 'target-tcg', 'Phantom: 1 new', 24, true, 0, false);
  await store.finishSweep(db, USER, 'target-tcg', 'Phantom: 3 new', 24, true, 0, true);

  const state = await store.sweepState(db, USER, 'target-tcg', 24);
  assert.equal(state.queued, false);
  assert.ok(state.lastSweptAt, 'and the clock starts for the next one');
});

test('a caller that says nothing is treated as finishing, so the CLI still works', async () => {
  const db = await withTargetSource();
  await store.requestSweep(db, USER, 'target-tcg');
  await store.finishSweep(db, USER, 'target-tcg', 'ok', 24, true);
  assert.equal((await store.sweepState(db, USER, 'target-tcg', 24)).queued, false);
});

// ── The picture, through the discovery path ──────────────────────────────────

test('A KEPT FIND BRINGS ITS PICTURE TO THE PRODUCT', async () => {
  // Otherwise every product created from a sweep starts blank and stays blank
  // until Phantom happens to read its page.
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [
    sighting({ imageUrl: 'https://target.scene7.com/is/image/Target/GUEST_abc?wid=300' }),
  ], true);

  const [found] = await store.discoveriesToReview(db, USER);
  assert.match(found!.imageUrl, /GUEST_abc/);

  await store.keepDiscovery(db, USER, found!.id);
  const [product] = await store.listProducts(db, USER);
  assert.match(product!.imageUrl, /GUEST_abc/, 'the product should have the photo already');
});

test('an image fills in when it was missing, and is never replaced', async () => {
  // These CDN URLs churn. A working image beats a newer one, which is the same
  // rule products already follow.
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ imageUrl: '' })], true);
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ imageUrl: 'https://cdn/one' })], true);
  let [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.imageUrl, 'https://cdn/one');

  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ imageUrl: 'https://cdn/two' })], true);
  [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.imageUrl, 'https://cdn/one', 'the first working URL stands');
});

test('a find with no picture is blank rather than broken', async () => {
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [sighting({ imageUrl: undefined })], true);
  const [found] = await store.discoveriesToReview(db, USER);
  assert.equal(found!.imageUrl, '');
});

test('a kept find brings its street date to the product', async () => {
  // The sweep read the date off the retailer's own page. Dropping it at Keep
  // left every kept product saying "no release date" while the discovery row
  // underneath knew better.
  const db = await withTargetSource();
  await store.recordDiscoveries(db, USER, 'target-tcg', [
    sighting({ releaseDate: '2026-09-16' }),
  ], true);
  const [found] = await store.discoveriesToReview(db, USER);
  await store.keepDiscovery(db, USER, found!.id);
  const [product] = await store.listProducts(db, USER);
  assert.equal(product!.releaseDate, '2026-09-16');
});

// ── Shops on and off, and the drop window ────────────────────────────────────

test('A SHOP CAN BE SWITCHED OFF WITHOUT TOUCHING THE OTHERS', async () => {
  const db = await TestDb.create();
  const saved = await store.setSettings(db, 1, { pausedRetailers: ['Walmart'] });
  assert.deepEqual(saved.pausedRetailers, ['Walmart']);
  // It survives the round trip through the key-value table.
  assert.deepEqual((await store.getSettings(db, 1)).pausedRetailers, ['Walmart']);
  // And clearing it puts every shop back on.
  const cleared = await store.setSettings(db, 1, { pausedRetailers: [] });
  assert.deepEqual(cleared.pausedRetailers, []);
  await db.close();
});

test('a shop this system does not watch cannot be toggled', async () => {
  const db = await TestDb.create();
  await assert.rejects(
    () => store.setSettings(db, 1, { pausedRetailers: ['Costco'] }),
    /not a shop this system watches/,
  );
  await db.close();
});

test('THE DROP-WINDOW SPACING REFUSES A FLOOR THAT WOULD GET US BLOCKED', async () => {
  const db = await TestDb.create();
  await assert.rejects(
    () => store.setSettings(db, 1, { burstSpacingSeconds: 2 }),
    /at least 5 seconds/,
    'below five seconds is not a setting, it is a way to be blocked mid-drop',
  );
  await assert.rejects(
    () => store.setSettings(db, 1, { burstSpacingSeconds: 90 }),
    /slower than the ordinary pace/,
  );
  // Zero is the honest spelling of "off".
  assert.equal((await store.setSettings(db, 1, { burstSpacingSeconds: 0 })).burstSpacingSeconds, 0);
  assert.equal((await store.setSettings(db, 1, { burstSpacingSeconds: 8 })).burstSpacingSeconds, 8);
  await db.close();
});

test('a drop window cannot be opened days ahead — it exists to be brief', async () => {
  const db = await TestDb.create();
  const soon = new Date(Date.now() + 60 * 60_000).toISOString();
  assert.equal((await store.setSettings(db, 1, { dropModeUntil: soon })).dropModeUntil, soon);
  await assert.rejects(
    () => store.setSettings(db, 1, {
      dropModeUntil: new Date(Date.now() + 48 * 3600_000).toISOString(),
    }),
    /more than 12 hours ahead/,
  );
  await assert.rejects(
    () => store.setSettings(db, 1, { dropModeUntil: 'sometime tuesday' }),
    /must be a timestamp/,
  );
  await db.close();
});

// ── A read that failed is not a reading ─────────────────────────────────────
//
// 6 Sep 2026, 06:28. The house internet dropped for about forty-five seconds
// and three checks came back ERR_INTERNET_DISCONNECTED. The watcher reported
// them honestly as state 'unknown'; this file then treated "we could not look"
// as news about the shelf. Two consequences, and the second is the dangerous
// one.

test('A FAILED READ DOES NOT RESET THE RESTING RAMP', async () => {
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'out', price: 31.99 });

  const before = (await store.listMissions(db, USER)).find((m) => m.listingId === listingId)!;

  const outcome = await store.recordObservation(db, USER, {
    listingId,
    state: 'unknown',
    confidence: 'unknown',
    note: 'could not read the page: net::ERR_INTERNET_DISCONNECTED',
  });

  assert.equal(outcome.changed, false, 'a dropped packet is not a change of stock');

  const after = (await store.listMissions(db, USER)).find((m) => m.listingId === listingId)!;
  assert.equal(
    after.lastChangedAt,
    before.lastChangedAt,
    'the clock the cadence rests on must not move',
  );

  // 290 reads is what this cost on the day it was found: three listings kicked
  // off the ramp by one blip, still reading three times as often nine hours
  // later — 17% of that whole day's traffic.
  const history = await store.recentObservations(db, USER, 10);
  assert.equal(history.length, 1, 'and it writes no history row either');
});

test('A FAILED READ DOES NOT ERASE WHAT THE SHELF LAST SAID', async () => {
  // The worse half. `alwaysFast` keys off state === 'in', so overwriting a
  // known state with 'unknown' would take the ONE listing that must never rest
  // and put it on the ramp — because of a dropped packet, mid-drop.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, {
    listingId,
    state: 'in',
    price: 44.99,
    availableQuantity: 12,
  });

  await store.recordObservation(db, USER, {
    listingId,
    state: 'unknown',
    confidence: 'unknown',
    note: 'could not read the page: net::ERR_INTERNET_DISCONNECTED',
  });

  const m = (await store.listMissions(db, USER)).find((m) => m.listingId === listingId)!;
  assert.equal(m.state, 'in', 'it was in stock a minute ago and nothing has said otherwise');
  assert.equal(m.price, 44.99);

  // But the staleness is honest: we did go and look, and the page can say so.
  assert.ok(m.lastCheckedAt, 'last_checked_at still moves — the read did happen');
});

test('the first sighting of a listing is allowed to be unknown', async () => {
  // Nothing to preserve. A listing whose very first read fails has to record
  // that it failed, or the page shows an empty row with no explanation.
  const { db, listingId } = await withMission();
  const outcome = await store.recordObservation(db, USER, {
    listingId,
    state: 'unknown',
    confidence: 'unknown',
    note: 'could not read the page',
  });
  assert.equal(outcome.isFirst, true);
  const m = (await store.listMissions(db, USER)).find((m) => m.listingId === listingId)!;
  assert.equal(m.state, 'unknown');
});

// ── Bulk, at the endpoint ───────────────────────────────────────────────────

test('A BULK ENDPOINT REPORTS WHAT MOVED, NOT WHAT WAS ASKED FOR', async () => {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO products (key, name) VALUES ('a','A'),('b','B'),('c','C')`,
  );
  await db.query(`UPDATE products SET archived_at = now() WHERE key = 'c'`);

  const res = await call(db, 'POST', '/api/products/bulk',
    { keys: ['a', 'b', 'c'], action: 'archive' });
  assert.equal(res.status, 200);
  // Three asked for, two moved: 'c' was already archived. Saying "3" would be
  // the kind of true-sounding number that teaches you not to trust the next.
  assert.equal(res.body.moved, 2);

  const left = await call(db, 'GET', '/api/dashboard');
  assert.deepEqual(left.body.products.map((p: { key: string }) => p.key), []);
  assert.equal(left.body.archivedProducts.length, 3);
});

test('ARCHIVING IS NOT DELETING, AND IT PAUSES WHAT IT HIDES', async () => {
  // Deleting cascades to listings, missions, runs and observations. Archiving
  // keeps all of it — and stops the reads, because spending requests on
  // something you have tidied away is the thing being tidied away.
  const db = await TestDb.create();
  await db.query(`INSERT INTO products (key, name) VALUES ('p','P')`);
  await db.query(
    `INSERT INTO listings (id, user_id, product_key, retailer, external_id, url)
     VALUES (1, 1, 'p', 'Target', '123', 'https://t.test/1')`,
  );
  await db.query(
    `INSERT INTO missions (id, user_id, listing_id, label, enabled)
     VALUES (1, 1, 1, 'P', true)`,
  );

  await call(db, 'POST', '/api/products/bulk', { keys: ['p'], action: 'archive' });

  const listings = await db.query(`SELECT id FROM listings WHERE product_key = 'p'`);
  assert.equal(listings.length, 1, 'the listing survives');
  const [mission] = await db.query<{ enabled: boolean }>(`SELECT enabled FROM missions WHERE id = 1`);
  assert.equal(mission?.enabled, false, 'and it stops being read');

  // Restoring shows it again and deliberately does NOT start the reads: "show
  // me this again" and "spend requests on this again" are different decisions
  // and only one of them costs anything.
  await call(db, 'POST', '/api/products/bulk', { keys: ['p'], action: 'restore' });
  const [after] = await db.query<{ enabled: boolean }>(`SELECT enabled FROM missions WHERE id = 1`);
  assert.equal(after?.enabled, false);
});

test('ONE DATE ACROSS A SELECTION, AND A BLANK ONE CLEARS IT', async () => {
  // Target published 2026-09-15 for seven of the nine 30th Celebration
  // products and nothing for the two Battle Decks, so the two that most needed
  // the release-week cadence were the two resting hardest.
  const db = await TestDb.create();
  await db.query(`INSERT INTO products (key, name) VALUES ('a','A'),('b','B')`);

  const res = await call(db, 'POST', '/api/products/bulk',
    { keys: ['a', 'b'], action: 'release-date', releaseDate: '2026-09-15' });
  assert.equal(res.body.moved, 2);
  const rows = await db.query<{ release_date: string }>(
    `SELECT release_date FROM products ORDER BY key`,
  );
  assert.equal(rows.length, 2);
  // Postgres hands a DATE back as a Date object through this driver, so the
  // assertion is on the day rather than on a string prefix.
  assert.ok(rows.every((r) => new Date(String(r.release_date)).toISOString().slice(0, 10) === '2026-09-15'),
    JSON.stringify(rows.map((r) => String(r.release_date))));

  // A wrong date is worse than none, so the way out is as easy as the way in.
  await call(db, 'POST', '/api/products/bulk',
    { keys: ['a'], action: 'release-date', releaseDate: '' });
  const [a] = await db.query<{ release_date: unknown }>(
    `SELECT release_date FROM products WHERE key = 'a'`,
  );
  assert.equal(a?.release_date, null);

  const bad = await call(db, 'POST', '/api/products/bulk',
    { keys: ['b'], action: 'release-date', releaseDate: 'next tuesday' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /YYYY-MM-DD/);
});

test('A BULK ENDPOINT REFUSES AN EMPTY OR ENORMOUS SELECTION', async () => {
  const db = await TestDb.create();
  const none = await call(db, 'POST', '/api/products/bulk', { keys: [], action: 'archive' });
  assert.equal(none.status, 400);
  const many = await call(db, 'POST', '/api/missions/bulk',
    { ids: Array.from({ length: 501 }, (_, i) => i + 1), action: 'pause' });
  assert.equal(many.status, 400);
});

test('BULK NEVER ARMS, AT THE ENDPOINT AS WELL AS ON THE PAGE', async () => {
  // The page not offering it is a courtesy. The endpoint refusing it is the
  // rule: a ceiling and a tick are a decision about money, and the whole value
  // of a bulk action is that you stop reading each row.
  const db = await TestDb.create();
  for (const action of ['arm', 'disarm', 'buy', 'delete']) {
    const res = await call(db, 'POST', '/api/missions/bulk', { ids: [1], action });
    assert.equal(res.status, 400, action + ' must not be a bulk action');
    assert.match(res.body.error, /unknown action/);
  }
});

test('AN ARCHIVED PRODUCT TAKES ITS MISSIONS OFF THE WATCH LIST TOO', async () => {
  // Archiving already paused them, and paused was not enough: thirty-four rows
  // vanished from Products and stayed on Missions wearing a paused badge, so
  // tidying up moved the mess rather than clearing it.
  const db = await TestDb.create();
  await db.query(`INSERT INTO products (key, name) VALUES ('keep','Keep'),('gone','Gone')`);
  await db.query(
    `INSERT INTO listings (id, user_id, product_key, retailer, external_id, url)
     VALUES (1, 1, 'keep', 'Target', '1', 'https://t.test/1'),
            (2, 1, 'gone', 'Walmart', '2', 'https://w.test/2')`,
  );
  await db.query(
    `INSERT INTO missions (id, user_id, listing_id, label, enabled)
     VALUES (1, 1, 1, 'Keep', true), (2, 1, 2, 'Gone', true)`,
  );

  assert.equal((await store.listMissions(db, USER)).length, 2);
  await call(db, 'POST', '/api/products/bulk', { keys: ['gone'], action: 'archive' });

  const left = await store.listMissions(db, USER);
  assert.deepEqual(left.map((m) => m.label), ['Keep'], 'off the watch list, not merely paused');

  // Still there, and still findable by id: hidden is not deleted.
  const direct = await store.missionForListing(db, USER, 2);
  assert.ok(direct, 'the mission itself survives');
  assert.equal(direct.enabled, false);

  // And Phantom must not read it either.
  const active = await store.activeMissions(db, USER);
  assert.deepEqual(active.map((m) => m.label), ['Keep']);

  // Putting the product back brings the mission back with it, still paused:
  // restoring is "show me this again", not "start spending requests again".
  await call(db, 'POST', '/api/products/bulk', { keys: ['gone'], action: 'restore' });
  const back = await store.listMissions(db, USER);
  assert.equal(back.length, 2);
  assert.equal(back.find((m) => m.label === 'Gone')?.enabled, false);
});

test('A SIGHTING KNOWS WHEN THE WINDOW CLOSED', async () => {
  // The whole point of the section: how long it lasted. Found by looking
  // forward from the sighting to the next reading that was not 'in'.
  const { db, listingId } = await withMission();

  await store.recordObservation(db, USER, { listingId, state: 'out', price: 49.99 });
  await store.recordObservation(db, USER, { listingId, state: 'in', price: 49.99, availableQuantity: 4 });

  const open = await store.recentSightings(db, USER);
  assert.equal(open.length, 1, 'going into stock is the sighting; going out is not');
  assert.equal(open[0]?.endedAt, null, 'still up');
  assert.equal(open[0]?.price, 49.99);

  await store.recordObservation(db, USER, { listingId, state: 'out', price: 49.99 });
  const shut = await store.recentSightings(db, USER);
  assert.equal(shut.length, 1, 'and it is still one sighting, not two');
  assert.ok(shut[0]?.endedAt, 'which now has an end');
  assert.ok(new Date(shut[0]!.endedAt!).getTime() >= new Date(shut[0]!.at).getTime());
});

test('A PRE-ORDER SIGHTING IS RECORDED AS ONE', async () => {
  // Stock and a pre-order both read 'in' — both go in a basket — and
  // afterwards the observation row is the only record of which it was.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'out' });
  await store.recordObservation(db, USER, {
    listingId, state: 'in', price: 24.99, isPreOrder: true,
  });
  const [seen] = await store.recentSightings(db, USER);
  assert.equal(seen?.isPreOrder, true);
});

test('an archived product keeps its sightings off the dashboard', async () => {
  // Tidied away means tidied away. A product archived off both lists should
  // not come back through the dashboard.
  const { db, listingId } = await withMission();
  await store.recordObservation(db, USER, { listingId, state: 'out' });
  await store.recordObservation(db, USER, { listingId, state: 'in', price: 49.99 });
  assert.equal((await store.recentSightings(db, USER)).length, 1);

  const [row] = await db.query<{ product_key: string }>(
    `SELECT product_key FROM listings WHERE id = $1`, [listingId],
  );
  await store.archiveProducts(db, USER, [row!.product_key], true);
  assert.equal((await store.recentSightings(db, USER)).length, 0);
});

// ── Walmart drawings ────────────────────────────────────────────────────────

const draw = (over: Record<string, unknown> = {}) => ({
  externalId: '21009455186',
  name: 'Pokémon TCG: 30th Celebration ex Box Bundle',
  url: 'https://www.walmart.com/ip/x/21009455186',
  price: 69.49, orderLimit: 3, phase: 'announced',
  windowLabel: 'Drawing starts', windowText: 'Sep 16, 2:00pm PDT',
  windowAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  ...over,
});

test('OPENED IS AN EDGE, SAID ONCE — NOT A STATE SAID EVERY PASS', async () => {
  // "A drawing is open" stays true for hours. Announcing it every two minutes
  // is how a channel gets muted, and a muted channel misses the next one.
  const db = await TestDb.create();

  const first = await store.recordDrawings(db, USER, 'Walmart', [draw()]);
  assert.equal(first[0]?.isNew, true);
  assert.equal(first[0]?.justOpened, false, 'announced is not open');

  const again = await store.recordDrawings(db, USER, 'Walmart', [draw()]);
  assert.equal(again[0]?.isNew, false, 'and seeing it again is not news');
  assert.equal(again[0]?.justOpened, false);

  const opened = await store.recordDrawings(db, USER, 'Walmart', [draw({ phase: 'open' })]);
  assert.equal(opened[0]?.justOpened, true, 'THIS is the moment');
  assert.ok(opened[0]?.row.openedAt);

  const still = await store.recordDrawings(db, USER, 'Walmart', [draw({ phase: 'open' })]);
  assert.equal(still[0]?.justOpened, false, 'and it is only a moment once');
  assert.equal(still[0]?.row.openedAt, opened[0]?.row.openedAt, 'the stamp never moves');
});

test('A DRAWING OFF THE PAGE IS RETIRED, NOT DELETED — AND COMES BACK', async () => {
  // A window you meant to enter and did not is worth keeping, and the record
  // of how long they stay open is the only way we will ever learn it. And a
  // carousel pulled for ten minutes during an edit must not permanently retire
  // a drawing that is still going to happen.
  const db = await TestDb.create();
  await store.recordDrawings(db, USER, 'Walmart', [draw(), draw({ externalId: 'b', name: 'B' })]);

  const retired = await store.retireMissingDrawings(db, USER, 'Walmart', ['21009455186']);
  assert.equal(retired, 1);
  assert.deepEqual((await store.liveDrawings(db, USER)).map((d) => d.externalId), ['21009455186']);

  await store.recordDrawings(db, USER, 'Walmart', [draw({ externalId: 'b', name: 'B' })]);
  const back = await store.liveDrawings(db, USER);
  assert.equal(back.length, 2, 'back on the page is back');
  assert.ok(back.every((d) => d.goneAt === null));
});

test('THE CLOSING REMINDER FIRES ONCE, AND NEVER FOR ONE ALREADY ENTERED', async () => {
  // With a lottery you lose by forgetting, not by being slow: you had hours
  // and the hours went by.
  const db = await TestDb.create();
  const soon = new Date(Date.now() + 30 * 60000).toISOString();
  await store.recordDrawings(db, USER, 'Walmart', [
    draw({ externalId: 'open', phase: 'open', windowAt: soon }),
    draw({ externalId: 'done', phase: 'open', windowAt: soon }),
  ]);

  const [entered] = (await store.liveDrawings(db, USER)).filter((d) => d.externalId === 'done');
  await store.markDrawingEntered(db, USER, entered!.id, true);

  const first = await store.claimClosingDrawings(db, USER, 60);
  assert.deepEqual(first.map((d) => d.externalId), ['open'], 'not the one already dealt with');

  const second = await store.claimClosingDrawings(db, USER, 60);
  assert.deepEqual(second, [], 'claimed once, so a re-read cannot repeat it');
});

test('an announced drawing is never nagged about', async () => {
  // Nagging about one that was announced and never opened is nagging about
  // Walmart's schedule.
  const db = await TestDb.create();
  await store.recordDrawings(db, USER, 'Walmart', [
    draw({ windowAt: new Date(Date.now() + 20 * 60000).toISOString() }),
  ]);
  assert.deepEqual(await store.claimClosingDrawings(db, USER, 60), []);
});

test('THE DISCORD CARD FOR A DRAWING DOES NOT READ LIKE A DROP', async () => {
  const { buildDrawEmbeds } = await import('../src/notify.ts');
  const now = new Date().toISOString();
  const [card] = buildDrawEmbeds([{
    name: '30th Celebration ex Box Bundle', retailer: 'Walmart',
    url: 'https://walmart.test/x', imageUrl: '', price: 69.49, orderLimit: 3,
    windowText: 'Sep 18, 2:00pm PDT', windowLabel: 'Drawing ends',
    windowAt: new Date(Date.parse(now) + 3 * 3600000).toISOString(),
  }], now, 'opened');

  assert.match(card!.title, /^DRAWING OPEN · /);
  const f = (name: string) => card!.fields.find((x: any) => x.name === name)?.value;
  assert.equal(f('Price'), '$69.49');
  assert.equal(f('Open until'), 'Sep 18, 2:00pm PDT', "Walmart's words, not ours");
  assert.equal(f('Time left'), 'in 3 hours');
  assert.equal(f('Limit'), '3 per entry');
  // The footer is the honesty: entering early is worth no more than entering
  // late, and a card that implies otherwise is spending adrenaline on a coin
  // toss — which makes the next real drop alert worth less.
  assert.match(card!.footer.text, /drawn at random/i);
  assert.match(card!.footer.text, /entering early is worth no more/i);
});

test('GIVEN ROWS AND RECOGNISING NONE IS A 400, NOT A CHEERFUL 200', async () => {
  // The bug this exists to have caught. The watcher's reader calls Walmart's
  // id `usItemId`; this contract calls it `externalId`. Every row fell through
  // `if (!externalId) continue`, the endpoint answered 200 with recorded: 0,
  // and for two hours Phantom logged four drawings while the Hub held none —
  // both halves believing they had done their job, two days before the drawing
  // the whole thing was built for.
  const db = await TestDb.create();

  const wrong = await call(db, 'POST', '/api/drawings', {
    retailer: 'Walmart',
    drawings: [{ usItemId: '21009455186', name: 'A bundle', phase: 'announced' }],
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /recognised none of them/);
  assert.match(wrong.body.error, /externalId/, 'and it names the field, so the fix is obvious');

  // An empty list is a legitimate "nothing advertised today" and stays a 200.
  // Silence and a mismatch are different answers and must not share a status.
  const empty = await call(db, 'POST', '/api/drawings', { retailer: 'Walmart', drawings: [] });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.recorded, 0);

  const right = await call(db, 'POST', '/api/drawings', {
    retailer: 'Walmart',
    drawings: [{ externalId: '21009455186', name: 'A bundle', phase: 'announced' }],
  });
  assert.equal(right.status, 200);
  assert.equal(right.body.recorded, 1);
});

test('THE OPENS-SOON ALERT DOES NOT WAIT FOR A FLAG NOBODY HAS SEEN MOVE', async () => {
  // `justOpened` fires on Walmart's own showDrawCTA. That is the right signal
  // and it is also one this project has never watched change — every row in
  // the capture it was built from had it false, so "the flag will flip" is a
  // prediction dressed as an observation. This is the belt to that brace: it
  // fires on the start time Walmart PRINTED, in words, on the page.
  const db = await TestDb.create();

  // Two days out, nothing is said. A drawing announced on Sunday must not ping
  // on Sunday about a window that opens on Tuesday.
  await store.recordDrawings(db, USER, 'Walmart', [draw()]);
  assert.deepEqual(await store.claimOpeningDrawings(db, USER, 30), []);

  // Twenty minutes out, it fires.
  await store.recordDrawings(db, USER, 'Walmart', [
    draw({ windowAt: new Date(Date.now() + 20 * 60000).toISOString() }),
  ]);
  const soon = await store.claimOpeningDrawings(db, USER, 30);
  assert.equal(soon.length, 1);
  assert.equal(soon[0]?.externalId, '21009455186');

  // Once. A page re-read every two minutes for the next half hour must not
  // turn one window into fifteen notifications.
  assert.deepEqual(await store.claimOpeningDrawings(db, USER, 30), []);
});

test('OPENS-SOON STAYS QUIET ONCE THE DRAWING HAS ACTUALLY OPENED', async () => {
  // The two alerts must never both shout about the same window. If the flag
  // does behave, the real one is the only one anybody should get.
  const db = await TestDb.create();
  const at = new Date(Date.now() + 20 * 60000).toISOString();
  await store.recordDrawings(db, USER, 'Walmart', [draw({ windowAt: at, phase: 'open' })]);
  assert.deepEqual(
    await store.claimOpeningDrawings(db, USER, 30), [],
    'opened_at is set, so there is nothing to predict',
  );
});

test('OPENS-SOON IS WORDED AS A PREDICTION, BECAUSE THAT IS WHAT IT IS', async () => {
  const { buildDrawEmbeds } = await import('../src/notify.ts');
  const now = new Date().toISOString();
  const [card] = buildDrawEmbeds([{
    name: '30th Celebration ex Box Bundle', retailer: 'Walmart',
    url: 'https://walmart.test/x', imageUrl: '', price: 69.49, orderLimit: 3,
    windowText: 'Sep 16, 2:00pm PDT', windowLabel: 'Drawing starts',
    windowAt: new Date(Date.parse(now) + 25 * 60000).toISOString(),
  }], now, 'soon');

  assert.match(card!.title, /^DRAWING OPENS SOON · /);
  const f = (name: string) => card!.fields.find((x: any) => x.name === name)?.value;
  assert.equal(f('Opens'), 'Sep 16, 2:00pm PDT');
  assert.equal(f('That is'), 'in 25 minutes');
  // It must not claim a button exists. Sending somebody to a page with no
  // control on it is how an alert stops being believed, and the alert that
  // stops being believed is the one that mattered.
  assert.doesNotMatch(card!.footer.text, /enter now/i);
  assert.match(card!.footer.text, /stated start time/i);
  assert.match(card!.footer.text, /may take a few minutes/i);
});

// ── Which room a card goes to ────────────────────────────────────────────────

test('A WALMART CARD GOES TO THE WALMART ROOM AND A TARGET ONE DOES NOT', async () => {
  const { splitByRoom } = await import('../src/notify.ts');
  const rooms = { main: 'https://hook/main', byRetailer: { walmart: 'https://hook/walmart' } };

  const groups = splitByRoom(
    [
      { retailer: 'Target', name: 'a' },
      { retailer: 'Walmart', name: 'b' },
      { retailer: 'Target', name: 'c' },
      { retailer: 'walmart', name: 'd' },
    ],
    rooms,
  );

  assert.equal(groups.length, 2, 'two rooms, not four posts');
  assert.equal(groups[0]!.url, 'https://hook/main', 'first card seen decides the order');
  assert.deepEqual(groups[0]!.items.map((i) => i.name), ['a', 'c']);
  assert.equal(groups[1]!.url, 'https://hook/walmart');
  // Case is Walmart's, not ours: the reader reports whatever the page said.
  assert.deepEqual(groups[1]!.items.map((i) => i.name), ['b', 'd']);
});

test('A ROOM THAT IS NOT CONFIGURED FALLS BACK — IT NEVER SWALLOWS', async () => {
  // The failure mode this is shaped around is a typo in an environment
  // variable name. "Your Walmart alerts arrived in the old channel" is a
  // tidy-up; "your Walmart alerts were silently discarded" is a missed drop,
  // and this project has already lost two hours this week to a config name
  // spelled two ways.
  const { splitByRoom, roomFor } = await import('../src/notify.ts');
  const rooms = { main: 'https://hook/main', byRetailer: {} };

  assert.equal(roomFor(rooms, 'Walmart'), 'https://hook/main');
  assert.equal(roomFor(rooms, ''), 'https://hook/main', 'and so does a card with no shop');
  assert.equal(roomFor(rooms, null), 'https://hook/main');

  const groups = splitByRoom(
    [{ retailer: 'Walmart' }, { retailer: 'Target' }, { retailer: null }],
    rooms,
  );
  assert.equal(groups.length, 1, 'one room');
  assert.equal(groups[0]!.items.length, 3, 'and every card still in it');
});

test('AN EMPTY ROOM STRING IS UNSET, NOT A DESTINATION', async () => {
  // Vercel hands back '' for a variable that exists with no value, and posting
  // to '' is a request to nowhere that fails quietly.
  const { roomFor } = await import('../src/notify.ts');
  assert.equal(
    roomFor({ main: 'https://hook/main', byRetailer: { walmart: '' } }, 'Walmart'),
    'https://hook/main',
  );
});

test('RE-ANNOUNCING SAYS OPEN DRAWINGS AS OPEN, NOT AS UPCOMING', async () => {
  // Adding a channel leaves everything already announced sitting in the old
  // one with no event left to re-fire. The repeat must not tell somebody to
  // wait for a window they are currently standing in.
  const db = await TestDb.create();
  await store.recordDrawings(db, USER, 'Walmart', [
    draw(),
    // A real name, because the repeat is Pokémon-only and 'Already open'
    // names no franchise — which is now a held row, correctly.
    draw({ externalId: 'open-one', name: 'Pokémon TCG: Surging Sparks ETB', phase: 'open' }),
  ]);

  const res = await callWith(
    db,
    { DISCORD_WEBHOOK_URL: MAIN_ROOM, DISCORD_WALMART_WEBHOOK_URL: WALMART_ROOM },
    'POST', '/api/drawings/announce', {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, 2, 'both live drawings said again');
  assert.equal(res.body.rooms, 2, 'one post per kind, since both are Walmart');

  // And it is a repeat, not a state change: nothing was stamped, so the real
  // edge-triggered alerts still have their moment to fire.
  const after = await store.liveDrawings(db, USER);
  assert.equal(after.length, 2);
  assert.ok(after.every((d) => d.enteredAt === null));
});

test('EITHER VARIABLE NAME WORKS, AND THE CARD LANDS IN THE WALMART ROOM', async () => {
  // The whole reason both spellings are read. The channel was set up from a
  // walkthrough that said DRAWS before the scope was settled as "everything
  // Walmart", so the variable that actually got typed into Vercel may be
  // either — and a routing change whose outcome depends on which message
  // somebody was reading is not a routing change, it is a coin toss.
  //
  // Asserted at the wire rather than by reading the code, because the bug this
  // guards against is precisely the code and the config disagreeing.
  const real = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.startsWith('http://127.0.0.1:1/')) {
      posted.push(url);
      return new Response('', { status: 204 });
    }
    return real(input, init);
  }) as typeof fetch;

  try {
    for (const name of ['DISCORD_WALMART_WEBHOOK_URL', 'DISCORD_DRAWS_WEBHOOK_URL'] as const) {
      posted.length = 0;
      const db = await TestDb.create();
      const res = await callWith(
        db,
        { DISCORD_WEBHOOK_URL: MAIN_ROOM, [name]: WALMART_ROOM },
        'POST', '/api/drawings',
        { retailer: 'Walmart', drawings: [draw()] },
      );
      assert.equal(res.status, 200, name);
      assert.equal(res.body.announced, 1, `${name}: the card was built`);
      assert.deepEqual(posted, [WALMART_ROOM], `${name}: and it went to Walmart's room`);
    }

    // And with neither set it falls back rather than vanishing.
    posted.length = 0;
    const db = await TestDb.create();
    await callWith(
      db, { DISCORD_WEBHOOK_URL: MAIN_ROOM },
      'POST', '/api/drawings', { retailer: 'Walmart', drawings: [draw()] },
    );
    assert.deepEqual(posted, [MAIN_ROOM], 'the old channel, never nowhere');
  } finally {
    globalThis.fetch = real;
  }
});

test('THE HUB SAYS WHICH WEBHOOK VARIABLES IT GOT — NAMES, NEVER VALUES', async () => {
  // "I set it and the flag still says false" is unanswerable from inside the
  // process unless the process says what it received. On Vercel each guess at
  // a name costs a full deploy, because an environment change does not reach a
  // build that already exists — so guessing is the expensive way to find out.
  const db = await TestDb.create();
  const res = await callWith(
    db,
    {
      DISCORD_WEBHOOK_URL: MAIN_ROOM,
      WEBHOOK_VAR_NAMES: ['DISCORD_WEBHOOK_URL', 'WALMART_WEBHOOK_URL'],
    },
    'GET', '/api/dashboard',
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.webhookVars, ['DISCORD_WEBHOOK_URL', 'WALMART_WEBHOOK_URL']);
  assert.equal(res.body.discordWalmart, false, 'and that name is not one it routes on');

  // The whole payload, stringified, must not contain a single webhook URL.
  // The names are a diagnostic; the values are credentials and this page is
  // the last place they should ever appear.
  assert.doesNotMatch(JSON.stringify(res.body), /127\.0\.0\.1:1/);
  assert.doesNotMatch(JSON.stringify(res.body), /discord\.com\/api\/webhooks/);
});

// ── Finding the Walmart room whatever it got called ──────────────────────────

const HOOK = (n: string) => 'https://discord.com/api/webhooks/123456789012345678/' + n;

test('A VARIABLE NAMED AFTER THE WEBHOOK STILL FINDS THE WALMART ROOM', async () => {
  // The hour this cost. The variable was called Phantom_Drawings, after the
  // webhook's display name in Discord — a perfectly reasonable thing to call
  // it — and the code was looking for three specific spellings while the
  // diagnostic was filtering on names containing "WEBHOOK". Both missed it,
  // and the diagnostic missing it is what made me say out loud that a
  // correctly-set variable did not exist.
  const { walmartWebhookFrom } = await import('../src/notify.ts');
  const main = HOOK('main');

  assert.equal(
    walmartWebhookFrom({ DISCORD_WEBHOOK_URL: main, Phantom_Drawings: HOOK('wm') }, main),
    HOOK('wm'),
  );
  // And the documented names still win outright, ahead of any scanning.
  assert.equal(
    walmartWebhookFrom(
      { DISCORD_WALMART_WEBHOOK_URL: HOOK('canon'), Phantom_Drawings: HOOK('wm') },
      main,
    ),
    HOOK('canon'),
  );
});

test('THE SCAN CANNOT CAPTURE THE MAIN WEBHOOK, OR PROMOTE A NON-WEBHOOK', async () => {
  // Both sides of the bound. A name that mentions the shop is not enough — the
  // value has to already be a webhook — and the same URL in two rooms would
  // post every Walmart card twice.
  const { walmartWebhookFrom } = await import('../src/notify.ts');
  const main = HOOK('main');

  assert.equal(
    walmartWebhookFrom({ WALMART_NOTES: 'https://example.com/not-a-webhook' }, main), '',
  );
  assert.equal(
    walmartWebhookFrom({ WALMART_DRAW_HOOK: main }, main), '',
    'the same URL in two rooms is every card twice',
  );
  // A name that says nothing about this shop is not scanned at all, however
  // webhook-shaped its value: that is somebody else's channel.
  assert.equal(walmartWebhookFrom({ TEAM_ANNOUNCEMENTS: HOOK('other') }, main), '');
  assert.equal(walmartWebhookFrom({ DISCORD_WEBHOOK_URL: main }, main), '');
});

test('THE DIAGNOSTIC LISTS WEBHOOKS BY SHAPE, NOT BY NAME', async () => {
  // The fix to the tool that lied. It has to be blind to naming convention to
  // be worth having, because the failure it exists to catch IS a name nobody
  // predicted.
  const { webhookVarNames } = await import('../src/notify.ts');
  assert.deepEqual(
    webhookVarNames({
      DISCORD_WEBHOOK_URL: HOOK('a'),
      Phantom_Drawings: HOOK('b'),
      DATABASE_URL: 'postgres://user:pw@host/db',
      APP_PASSWORD: 'hunter2',
      DISCORD_WINS_WEBHOOK_URL: '',
    }),
    ['DISCORD_WEBHOOK_URL', 'Phantom_Drawings'],
    'both webhooks, and nothing else in the environment',
  );
});

test('SET TO THE WRONG THING IS NOT THE SAME AS NEVER SET', async () => {
  // The third state, and the one that kept this ambiguous for an hour. "No
  // variable holds a webhook" is true both when nothing was set and when
  // something was set to an invite link, a half-paste, or a value with a stray
  // space — and those need opposite fixes.
  const { nearMissVarNames, webhookVarNames } = await import('../src/notify.ts');
  const vars = {
    DISCORD_WEBHOOK_URL: HOOK('a'),
    Phantom_Drawings: 'https://discord.gg/abc123',
    WALMART_HOOK: '',
    DATABASE_URL: 'postgres://user:pw@host/db',
  };
  assert.deepEqual(webhookVarNames(vars), ['DISCORD_WEBHOOK_URL']);
  assert.deepEqual(
    nearMissVarNames(vars), ['Phantom_Drawings', 'WALMART_HOOK'],
    'an invite link and an empty one both say "you meant this, it is not that"',
  );
  // And it stays a diagnostic about intent, not an inventory of the box.
  assert.ok(!nearMissVarNames(vars).includes('DATABASE_URL'));
});

// ── Only Pokémon reaches the channel ─────────────────────────────────────────

test('A DRAWING THAT NAMES NO FRANCHISE IS STORED, SHOWN, AND NOT ANNOUNCED', async () => {
  // Walmart raffles its whole collectibles shelf from one page. Dropping an
  // odd title risks losing a real window over an unusual product name, and a
  // lottery does not reopen; announcing it puts whatever is being raffled this
  // week into a channel that exists to mean one thing. So: held, and visible.
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/drawings', {
    retailer: 'Walmart',
    drawings: [
      draw(),
      draw({ externalId: 'mystery', name: 'Collector Chest Surprise Drop', franchise: 'unknown' }),
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded, 2, 'both stored — nothing was thrown away');
  assert.equal(res.body.announced, 1, 'only the Pokémon one was said out loud');
  assert.equal(res.body.held, 1, 'and the count says so, so silence is never the only evidence');

  const live = await store.liveDrawings(db, USER);
  assert.equal(live.length, 2);
  assert.deepEqual(
    live.map((d) => d.franchise).sort(), ['pokemon', 'unknown'],
  );
});

test('A STALE PHANTOM THAT SENDS NO FRANCHISE CANNOT FAIL OPEN', async () => {
  // The field is new. An older Phantom omits it entirely, and an absent
  // franchise defaulting to Pokémon would announce a One Piece window into a
  // Pokémon channel. So the Hub re-reads the title itself and takes the
  // stricter of the two answers.
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/drawings', {
    retailer: 'Walmart',
    drawings: [
      { externalId: 'op1', name: 'One Piece Card Game OP-09 Booster Box', phase: 'announced' },
      { externalId: 'pk1', name: 'Pokémon TCG: Surging Sparks ETB', phase: 'announced' },
    ],
  });
  assert.equal(res.body.recorded, 2);
  assert.equal(res.body.announced, 1, 'the One Piece box was not announced');

  const live = await store.liveDrawings(db, USER);
  const op = live.find((d) => d.externalId === 'op1');
  assert.equal(op?.franchise, 'other', 'read from the title, not taken on trust');
});

test('A CLIENT CLAIMING POKEMON ON A ONE PIECE TITLE IS NOT BELIEVED', async () => {
  // Both halves have to agree. Trusting the wire alone means one bad client
  // can post anything into the channel.
  const db = await TestDb.create();
  await call(db, 'POST', '/api/drawings', {
    retailer: 'Walmart',
    drawings: [{
      externalId: 'liar', name: 'One Piece Card Game Premium Booster',
      phase: 'announced', franchise: 'pokemon',
    }],
  });
  const [row] = await store.liveDrawings(db, USER);
  assert.equal(row?.franchise, 'other');
});

test('THE OPENS-SOON ALERT DOES NOT COUNT DOWN TO SOMEBODY ELSE\'S GAME', async () => {
  const db = await TestDb.create();
  await store.recordDrawings(db, USER, 'Walmart', [
    { externalId: 'mtg', name: 'Magic The Gathering Foundations Box', phase: 'announced',
      windowLabel: 'Drawing starts', windowText: 'soon',
      windowAt: new Date(Date.now() + 20 * 60000).toISOString() },
  ]);
  assert.deepEqual(await store.claimOpeningDrawings(db, USER, 30), []);
});

test('AN OLD PHANTOM THAT SENDS NO FRANCHISE STILL GETS ITS POKEMON ANNOUNCED', async () => {
  // The bug this file caught the night before the drawing. Requiring both
  // halves to say "pokemon" made every row from a Phantom too old to send the
  // field come out 'unknown', which is a silent channel on the one afternoon
  // that mattered. Absent is no opinion; the title is believed.
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/drawings', {
    retailer: 'Walmart',
    drawings: [
      { externalId: '20959422790', phase: 'announced',
        name: 'Pokémon TCG: 30th Celebration Elite Trainer Box (2ct)' },
      { externalId: '20959422791', phase: 'announced',
        name: 'Pokémon TCG: 30th Celebration Tech Sticker Collection (12ct)' },
    ],
  });
  assert.equal(res.body.announced, 2);
  assert.equal(res.body.held, 0);
});

// ── A wall has to reach a phone ──────────────────────────────────────────────

test('A WALL IS ANNOUNCED ONCE PER SHOP, NOT ONCE PER WALLED READ', async () => {
  // With mass press-and-hold a shop can wall a dozen reads in a minute, and a
  // pass that hits a wall drops every other listing queued for that retailer.
  // The person needs to know the shop is walled. Once.
  const db = await TestDb.create();
  const posted: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.startsWith('http://127.0.0.1:1/')) { posted.push(url); return new Response('', { status: 204 }); }
    return real(input, init);
  }) as typeof fetch;

  try {
    const res = await callWith(db, { DISCORD_WEBHOOK_URL: MAIN_ROOM }, 'POST', '/api/activity', {
      lines: [
        { kind: 'check', retailer: 'Target', message: 'blocked: Press-and-hold check, 20m' },
        { kind: 'check', retailer: 'Target', message: 'blocked: Press-and-hold check, 20m' },
        { kind: 'check', retailer: 'Target', message: 'blocked: Press-and-hold check, 40m' },
        { kind: 'check', retailer: 'Target', message: 'out' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(posted.length, 1, 'three walled reads, one card');

    // And it stays quiet while the wall stands, because the second telling
    // adds nothing and a muted channel misses the next real thing.
    posted.length = 0;
    await callWith(db, { DISCORD_WEBHOOK_URL: MAIN_ROOM }, 'POST', '/api/activity', {
      lines: [{ kind: 'check', retailer: 'Target', message: 'blocked: Press-and-hold check, 20m' }],
    });
    assert.equal(posted.length, 0, 'inside the cooldown');
  } finally {
    globalThis.fetch = real;
  }
});

test('A WAITING ROOM IS NOT A WALL, AND WINS WHEN BOTH ARRIVE', async () => {
  // Opposite events: a queue says a drop is live and go stand in it, a wall
  // says this browser has been told to go away. A queue whose door has a human
  // check on it is one event and must read as one — and the queue is the
  // louder, more actionable half.
  assert.equal(store.isWallLine('blocked: Press-and-hold check, 20m'), true);
  assert.equal(store.isWallLine('blocked: Walmart waiting room, 0m'), false);
  assert.equal(store.isWallLine('QUEUE: waiting room up'), false);
  assert.equal(store.isWallLine('out at $29.99'), false);

  const db = await TestDb.create();
  const posted: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.startsWith('http://127.0.0.1:1/')) { posted.push(url); return new Response('', { status: 204 }); }
    return real(input, init);
  }) as typeof fetch;
  try {
    await callWith(db, { DISCORD_WEBHOOK_URL: MAIN_ROOM }, 'POST', '/api/activity', {
      lines: [
        { kind: 'check', retailer: 'Target', message: 'waiting room is up — drop likely live' },
        { kind: 'check', retailer: 'Target', message: 'blocked: Press-and-hold check, 20m' },
      ],
    });
    assert.equal(posted.length, 1, 'one card, not two, for one moment at one shop');
  } finally {
    globalThis.fetch = real;
  }
});

test('THE WALL CARD DOES NOT CRY DROP, AND SAYS WHOSE JOB THE CHECK IS', async () => {
  // A wall is not a drop signal: shops raise defences at drop time AND when a
  // browser simply looks wrong, and one page cannot tell those apart. An alert
  // that resolves that ambiguity in the exciting direction gets muted before
  // the night it mattered.
  const { buildWallEmbed } = await import('../src/notify.ts');
  const now = new Date().toISOString();
  const card = buildWallEmbed(
    { retailer: 'Target', at: now, reason: 'Press-and-hold check', restingMinutes: 20 },
    now,
  );
  assert.match(card.title, /^TARGET PUT A HUMAN CHECK UP$/);
  assert.match(card.description, /standing down and will not touch the check/i);
  assert.match(card.description, /does not on its own mean a drop is live/i);
  assert.match(card.description, /look yourself/i);
  // The quiet is the thing being explained. Without this the channel says
  // nothing and nothing is indistinguishable from nothing happening.
  assert.match(card.description, /treat the quiet as blindness/i);
  assert.match(card.footer.text, /never this program/i);
  assert.doesNotMatch(card.description, /drop is live now|go buy|in stock/i);
});
