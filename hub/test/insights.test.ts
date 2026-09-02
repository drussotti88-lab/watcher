/**
 * The dashboard, and the wins.
 *
 * One question runs through all of it — WHERE ARE WE LOSING IT? — and the rule
 * that makes it worth opening is that every number comes out of a row this
 * system already wrote. Nothing here is estimated, and a figure that cannot be
 * traced back to a table does not belong on the page.
 *
 * The tests that matter most are the ones about small numbers. This account has
 * had exactly one confirmed order; a dashboard that only looks right with
 * thousands of rows is a dashboard nobody will trust on the day it matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import * as store from '../src/store.ts';

const A = 1;

async function seeded() {
  const db = await TestDb.create();
  const product = await store.upsertProduct(db, A, { name: 'Pitch Black ETB', msrp: 49.99 });
  const listing = await store.addListing(db, A, {
    productKey: product.key, retailer: 'Target', externalId: '1012644666',
    url: 'https://www.target.com/p/-/A-1012644666',
  });
  const mission = await store.upsertMission(db, A, { listingId: listing.id, label: 'pitch black' });
  return { db, product, listing, mission };
}

// ── The funnel ───────────────────────────────────────────────────────────────

test('AN EMPTY SYSTEM READS AS EMPTY, NOT AS BROKEN', async () => {
  // The first thing a new account sees. Zeroes everywhere is the correct
  // answer; a crash, or a NaN, is how somebody concludes the app does not work
  // before it has had anything to do.
  const db = await TestDb.create();
  const f = await store.funnel(db, A, 168);
  assert.deepEqual(
    { ...f, outcomes: f.outcomes.length, refusals: f.refusals.length },
    { watching: 0, sawStock: 0, sawStockArmed: 0, authorised: 0, bought: 0, outcomes: 0, refusals: 0 },
  );
  const h = await store.health(db, A, 168);
  assert.equal(h.checks, 0);
  assert.equal(h.uptime, 0);
  assert.ok(Number.isFinite(h.uptime), 'never a division by zero');
});

test('WATCHING COUNTS ENABLED MISSIONS, NOT EVERY ROW EVER', async () => {
  const { db, listing } = await seeded();
  await store.upsertMission(db, A, { listingId: listing.id, enabled: false });
  const f = await store.funnel(db, A, 168);
  assert.equal(f.watching, 0, 'a paused mission is not being watched');
});

test('SAW STOCK IS THE STAGE THE WHOLE PAGE TURNS ON', async () => {
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'out', confidence: 'exact', price: 49.99,
  });
  assert.equal((await store.funnel(db, A, 168)).sawStock, 0, 'out of stock is not stock');

  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
  });
  assert.equal((await store.funnel(db, A, 168)).sawStock, 1);
});

test('a listing counts ONCE however many times it came in stock', async () => {
  // Otherwise a single popular listing checked every five seconds during a drop
  // makes the funnel look like a hundred opportunities, and the conversion rate
  // underneath it becomes meaningless.
  const { db, listing } = await seeded();
  for (let i = 0; i < 5; i += 1) {
    await store.recordObservation(db, A, {
      listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
    });
  }
  assert.equal((await store.funnel(db, A, 168)).sawStock, 1);
});

test('ARMED-WHEN-IT-APPEARED IS THE NUMBER THAT NAMES THE PROBLEM', async () => {
  // The difference between "we are too slow" and "we were not armed" is the
  // difference between rewriting the checkout and ticking a box. This stage is
  // the one that tells them apart.
  const { db, listing, mission } = await seeded();
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
  });

  const before = await store.funnel(db, A, 168);
  assert.equal(before.sawStock, 1);
  assert.equal(before.sawStockArmed, 0, 'it appeared and nothing was armed');

  await store.upsertMission(db, A, { listingId: listing.id, armed: true, ceiling: 60 });
  const after = await store.funnel(db, A, 168);
  assert.equal(after.sawStockArmed, 1);
  assert.equal(mission.armed, false, 'and it really was unarmed to begin with');
});

test('the window is honoured — old stock is not this week s news', async () => {
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
  });
  await db.query("UPDATE observations SET at = now() - interval '40 days'");
  assert.equal((await store.funnel(db, A, 24)).sawStock, 0);
  assert.equal((await store.funnel(db, A, 24 * 90)).sawStock, 1);
});

test('OUTCOMES AND REFUSALS COME BACK MOST COMMON FIRST', async () => {
  const { db, mission } = await seeded();
  const run = (outcome: string, reason: string) =>
    store.recordRun(db, A, mission.id, { outcome, reason, state: 'in' } as never);
  await run('declined', 'sold by Rares Market L.L.C., and this mission is retailer-only');
  await run('declined', 'sold by Venado Inc, and this mission is retailer-only');
  await run('blocked', 'press and hold — standing down');

  const f = await store.funnel(db, A, 168);
  assert.equal(f.outcomes[0]!.outcome, 'declined');
  assert.equal(f.outcomes[0]!.n, 2);

  // CLASSIFIED, not chopped. Splitting on the first comma keeps "sold by Rares
  // Market L.L.C." and throws away "and this mission is retailer-only" — the
  // seller survives and the reason does not, so every row has a count of one
  // and the list says nothing.
  const top = f.refusals[0]!;
  assert.equal(top.n, 2, `two retailer-only refusals should group: ${JSON.stringify(f.refusals)}`);
  assert.equal(top.reason, 'Sold by a marketplace seller');
  assert.ok(f.refusals.some((r) => r.reason === 'The shop asked for a human'));
});

test('a refusal nobody anticipated shows up as itself, not as "other"', async () => {
  // The bucket that swallows the unknown is the bucket that hides the next
  // bug. An unmatched reason keeps its opening words.
  const { db, mission } = await seeded();
  await store.recordRun(db, A, mission.id, {
    outcome: 'declined', reason: 'the moon was in the wrong house', state: 'in',
  } as never);
  const f = await store.funnel(db, A, 168);
  assert.equal(f.refusals[0]!.reason, 'the moon was in the wrong house');
});

// ── The machine ──────────────────────────────────────────────────────────────

test('SPEED IS A MEDIAN PER SHOP, BECAUSE THE SHOPS ARE NOT ALIKE', async () => {
  // Target reads in about 2.5s and Pokémon Center in about 0.4s. One average
  // across both is a number that describes neither.
  const { db } = await seeded();
  const add = (retailer: string, ms: number) =>
    db.query(
      `INSERT INTO activity (user_id, kind, level, retailer, ms, message)
            VALUES ($1, 'check', 'info', $2, $3, 'out')`,
      [A, retailer, ms],
    );
  await add('Target', 2400);
  await add('Target', 2600);
  await add('Target', 20000);
  await add('Pokemon Center', 400);

  const h = await store.health(db, A, 168);
  const target = h.speed.find((s) => s.retailer === 'Target')!;
  assert.equal(target.checks, 3);
  assert.equal(target.medianMs, 2600, 'a median, so one 20-second outlier does not move it');
  assert.equal(h.speed.find((s) => s.retailer === 'Pokemon Center')!.medianMs, 400);
});

test('REPORTING IS COUNTED IN BUCKETS, NOT GUESSED AT', async () => {
  // Phantom writes a line every pass INCLUDING while it rests outside watching
  // hours, so a five-minute slot with nothing in it means the process was not
  // running. Same signal as the silence banner, counted rather than
  // thresholded.
  const { db } = await seeded();
  await db.query(
    `INSERT INTO activity (user_id, at, kind, message)
          SELECT $1, now() - (n || ' minutes')::interval, 'pass', 'ok'
            FROM generate_series(0, 55, 5) AS n`,
    [A],
  );
  const h = await store.health(db, A, 1);
  assert.ok(h.uptime > 0.8, `an hour of steady passes should read as up, got ${h.uptime}`);
  assert.ok(h.uptime <= 1, 'and never above 100%');
});

test('a silent hour reads as down, and says how many gaps', async () => {
  const { db } = await seeded();
  await db.query(
    `INSERT INTO activity (user_id, at, kind, message)
          VALUES ($1, now() - interval '2 minutes', 'pass', 'ok')`,
    [A],
  );
  const h = await store.health(db, A, 1);
  assert.ok(h.uptime < 0.2, `one line in an hour is not uptime, got ${h.uptime}`);
  assert.ok(h.stalls > 8);
});

// ── Wins ─────────────────────────────────────────────────────────────────────

test('A WIN IS A CONFIRMED ORDER AND NOTHING ELSE', async () => {
  // Dry runs, declines and near misses are not wins. The first live attempt
  // recorded "bought" while the pens were still in the cart, and this list is
  // only worth opening because that can no longer happen.
  const { db, mission } = await seeded();
  const run = (outcome: string) =>
    store.recordRun(db, A, mission.id, {
      outcome, reason: outcome, state: 'in', price: 0.99, total: 1.09, quantity: 1,
    } as never);
  await run('dry_run');
  await run('declined');
  await run('in_stock');
  await run('bought');

  const rows = await store.wins(db, A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.total, 1.09);
  assert.equal(rows[0]!.quantity, 1);
  assert.equal(rows[0]!.retailer, 'Target');
  assert.equal(rows[0]!.productName, 'Pitch Black ETB');
  assert.equal(rows[0]!.msrp, 49.99, 'the MSRP rides along so the page can say good or bad');
});

test('a win carries its vault status when there is one, and null when not', async () => {
  const { db, mission } = await seeded();
  await store.recordRun(db, A, mission.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 0.99, total: 1.09, quantity: 1,
  } as never);
  assert.equal((await store.wins(db, A))[0]!.vaultStatus, null, 'no vault row yet');
});

test('WINS ARE THIS ACCOUNT S OWN, however shared the catalogue is', async () => {
  // The shelf is shared. What was bought off it is not.
  const { db, listing } = await seeded();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");
  const theirs = await store.upsertMission(db, 2, { listingId: listing.id, label: 'theirs' });
  await store.recordRun(db, 2, theirs.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 0.99, total: 1.09, quantity: 1,
  } as never);

  assert.equal((await store.wins(db, A)).length, 0, 'not mine');
  assert.equal((await store.wins(db, 2)).length, 1, 'theirs');
  assert.equal((await store.funnel(db, A, 168)).bought, 0);
  assert.equal((await store.funnel(db, 2, 168)).bought, 1);
});
