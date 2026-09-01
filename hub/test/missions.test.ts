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

test('the Watcher can post a finished run over HTTP', async () => {
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

test('the first image the Watcher sees is kept, and never overwritten', async () => {
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

test('the seller the Watcher saw is remembered on the listing', async () => {
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

test('active missions are what the Watcher polls, and carry the mandate', async () => {
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

test('MY FINDS ARE NOT YOUR FINDS', async () => {
  const { db, id } = await withDiscovery();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");

  assert.equal((await store.discoveriesToReview(db, 2)).length, 0);
  assert.equal(await store.forgetDiscovery(db, 2, id), false);
  await assert.rejects(() => store.keepDiscovery(db, 2, id), /no such discovery/);
});

// ── When a sweep is due ──────────────────────────────────────────────────────
//
// Deliberately the Hub's decision. The Watcher restarts — sometimes twice a
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
  // read would drop it silently the first time the Watcher was asleep.
  const db = await withSource();
  await store.requestSweep(db, USER, 'target-tcg');

  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), true);
  assert.equal(await store.sweepDue(db, USER, 'target-tcg', 24), true, 'still queued after a read');

  await store.finishSweep(db, USER, 'target-tcg', 'watcher: 3 new', 20, true);
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

  await store.finishSweep(db, USER, 'target-tcg', 'watcher: 1 new', 24, true, 0, false);

  const state = await store.sweepState(db, USER, 'target-tcg', 24);
  assert.equal(state.queued, true, 'the request must survive until the sweep really ends');
  assert.equal(state.lastSweptAt, null, 'and nothing has been swept yet');
  assert.equal(state.lastStatus, 'watcher: 1 new', 'but progress is still reported');
});

test('the last query does finish it', async () => {
  const db = await withTargetSource();
  await store.requestSweep(db, USER, 'target-tcg');
  await store.finishSweep(db, USER, 'target-tcg', 'watcher: 1 new', 24, true, 0, false);
  await store.finishSweep(db, USER, 'target-tcg', 'watcher: 3 new', 24, true, 0, true);

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
  // until the Watcher happens to read its page.
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
