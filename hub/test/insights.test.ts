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
    { watching: 0, sawStock: 0, sawStockArmed: 0, resellerOnly: 0, staged: 0, stagedPeak: 0,
      authorised: 0, bought: 0, outcomes: 0, refusals: 0 },
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
    sellerKind: 'retailer',
  });
  assert.equal((await store.funnel(db, A, 168)).sawStock, 0, 'out of stock is not stock');

  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
    sellerKind: 'retailer',
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
      sellerKind: 'retailer',
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
    sellerKind: 'retailer',
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
    sellerKind: 'retailer',
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

// ── The seller is the correction ─────────────────────────────────────────────
//
// The first version of this funnel reported "15 listings came in stock" and it
// read as fifteen missed chances. Two of them were. The other thirteen were
// Walmart marketplace resellers, permanently in stock at two to four times
// MSRP — and every mission refuses those on purpose, because retailer_only is
// the default and a reseller listing is the thing you are RACING, not the thing
// you want.
//
// Counting them as opportunities pointed the next day's work at arming, when
// the honest answer was that almost nothing had dropped.

async function twoListings() {
  const db = await TestDb.create();
  const product = await store.upsertProduct(db, A, { name: 'Mega Tin', msrp: 24.99 });
  const shop = await store.addListing(db, A, {
    productKey: product.key, retailer: 'Target', externalId: 'shop',
    url: 'https://www.target.com/p/-/A-1',
  });
  const reseller = await store.addListing(db, A, {
    productKey: product.key, retailer: 'Walmart', externalId: 'resell',
    url: 'https://www.walmart.com/ip/2',
  });
  await store.upsertMission(db, A, { listingId: shop.id });
  await store.upsertMission(db, A, { listingId: reseller.id });
  return { db, shop, reseller };
}

test('A RESELLER IN STOCK IS NOT AN OPPORTUNITY WE MISSED', async () => {
  const { db, shop, reseller } = await twoListings();
  await store.recordObservation(db, A, {
    listingId: reseller.id, state: 'in', confidence: 'exact', price: 79.99,
    sellerKind: 'marketplace', sellerName: 'Rares Market L.L.C.',
  });
  await store.recordObservation(db, A, {
    listingId: shop.id, state: 'in', confidence: 'exact', price: 24.99,
    sellerKind: 'retailer', sellerName: 'Target',
  });

  const f = await store.funnel(db, A, 168);
  assert.equal(f.sawStock, 1, 'one real drop, not two');
  assert.equal(f.resellerOnly, 1, 'and the other is counted as context, not loss');
});

test('a listing the shop AND a reseller both had counts as the shop', async () => {
  // Walmart sells its own stock beside the resellers on the same page. If the
  // retailer ever had it, there was a real chance, whatever else was listed.
  const { db, shop } = await twoListings();
  await store.recordObservation(db, A, {
    listingId: shop.id, state: 'in', confidence: 'exact', price: 79.99,
    sellerKind: 'marketplace', sellerName: 'Rares',
  });
  await store.recordObservation(db, A, {
    listingId: shop.id, state: 'in', confidence: 'exact', price: 24.99,
    sellerKind: 'retailer', sellerName: 'Target',
  });
  const f = await store.funnel(db, A, 168);
  assert.equal(f.sawStock, 1);
  assert.equal(f.resellerOnly, 0, 'not double-counted, and not called reseller-only');
});

// ── The money ────────────────────────────────────────────────────────────────

test('SPENT IS NOT ONE THING — an order is paid, a pre-order is owed', async () => {
  const { db, shop } = await twoListings();
  const m = (await store.listMissions(db, A)).find((x) => x.listingId === shop.id)!;
  await store.recordRun(db, A, m.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 24.99, total: 27.42, quantity: 1,
  } as never);
  await store.recordRun(db, A, m.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 59.99, total: 65.84, quantity: 1,
    isPreOrder: true, releaseDate: '2026-11-14',
  } as never);

  const cash = await store.money(db, A);
  assert.equal(cash.settled, 27.42, 'the order is money gone');
  assert.equal(cash.committed, 65.84, 'the pre-order is money owed');
  assert.equal(cash.upcoming.length, 1);
  assert.equal(cash.upcoming[0]!.releaseDate, '2026-11-14', 'and it says when');
});

test('A BUDGET IS A NUMBER TO READ, NOT A SECOND BRAKE', async () => {
  // The daily cap stops things. This does not, and must not: a forgotten
  // figure in a settings box is not allowed to cost a drop.
  const { db, shop } = await twoListings();
  await store.setSettings(db, A, { budgetTotal: 500, spendCapDay: 200 });
  const m = (await store.listMissions(db, A)).find((x) => x.listingId === shop.id)!;
  await store.recordRun(db, A, m.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 100, total: 110, quantity: 1,
  } as never);

  const cash = await store.money(db, A);
  assert.equal(cash.budget, 500);
  assert.equal(cash.left, 390, 'budget minus settled minus committed minus open');

  // And it really is only a reading: arming still answers to the CAP.
  const armed = await store.upsertMission(db, A, {
    listingId: shop.id, armed: true, ceiling: 50,
  });
  assert.equal(armed.armed, true, 'the budget did not refuse it');
});

test('an unset budget leaves nothing to subtract from', async () => {
  const { db } = await twoListings();
  const cash = await store.money(db, A);
  assert.equal(cash.budget, 0);
  assert.equal(cash.left, null, 'not zero — there is no answer, and zero is an answer');
});

test('A GRANT NOBODY RESOLVED IS COUNTED, because not-sure is a real state', async () => {
  // A Phantom that died mid-checkout leaves a live grant and nobody knowing
  // whether money moved. Rounding that to zero is how a budget lies.
  const { db, shop } = await twoListings();
  const m = await store.upsertMission(db, A, { listingId: shop.id, armed: true, ceiling: 50 });
  await store.setSettings(db, A, { spendCapDay: 200, budgetTotal: 500 });
  await store.requestAuthorisation(db, A, m.id);

  const cash = await store.money(db, A);
  assert.ok(cash.open > 0, 'the open grant shows up');
  assert.equal(cash.left, Math.round((500 - cash.open) * 100) / 100);
});

test('WINS SAY WHICH ARE PRE-ORDERS', async () => {
  const { db, shop } = await twoListings();
  const m = (await store.listMissions(db, A)).find((x) => x.listingId === shop.id)!;
  await store.recordRun(db, A, m.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 59.99, total: 65.84, quantity: 1,
    isPreOrder: true, releaseDate: '2026-11-14',
  } as never);
  const [w] = await store.wins(db, A);
  assert.equal(w!.isPreOrder, true);
  assert.equal(w!.releaseDate, '2026-11-14');
});

test('a release date on an ORDINARY order is not kept — it is not a ship date', async () => {
  // products.release_date is a fact about the product. On an order that is
  // already paid it says nothing about when money moves, and carrying it would
  // put a date in the "owed, when it ships" list that owes nothing.
  const { db, shop } = await twoListings();
  const m = (await store.listMissions(db, A)).find((x) => x.listingId === shop.id)!;
  await store.recordRun(db, A, m.id, {
    outcome: 'bought', reason: 'BOUGHT', state: 'in', price: 24.99, total: 27.42, quantity: 1,
    isPreOrder: false, releaseDate: '2026-11-14',
  } as never);
  const [w] = await store.wins(db, A);
  assert.equal(w!.isPreOrder, false);
  assert.equal(w!.releaseDate, null);
  assert.equal((await store.money(db, A)).upcoming.length, 0);
});


// ── Staged stock: the stage that has never fired ─────────────────────────────

test('STAGED COUNTS A LISTING COUNTED BUT NOT SELLABLE', async () => {
  // The pre-drop tell. Units against a listing the shop still refuses to sell
  // is the only signal in this system that arrives while there is time to do
  // something about it, so it gets its own stage rather than being folded into
  // "out of stock" — which is what the funnel said about it until now.
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'out', availableQuantity: 0,
  });
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'out', availableQuantity: 31000,
  });
  const f = await store.funnel(db, A, 168);
  assert.equal(f.staged, 1);
  assert.equal(f.stagedPeak, 31000, 'the size of the load-in, not just that there was one');
  assert.equal(f.sawStock, 0, 'staged is not in stock, and must never be counted as it');
});

test('a count on something already sellable is stock, not staged', async () => {
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', availableQuantity: 10, sellerKind: 'retailer',
  });
  const f = await store.funnel(db, A, 168);
  assert.equal(f.staged, 0, 'ordinary shelf stock is not a drop warning');
  assert.equal(f.sawStock, 1);
});

test('THE LOAD-IN ALARM FIRES ON THE EDGE, NOT ON EVERY READING', async () => {
  // The whole reason previousQuantity is carried out of recordObservation. An
  // alarm that fires every ninety seconds for four hours is an alarm that gets
  // muted before the drop it was warning about.
  assert.equal(store.stockLoaded(null, 30000), true, 'nothing, then a warehouse');
  assert.equal(store.stockLoaded(0, 250), true);
  assert.equal(store.stockLoaded(30000, 31000), false, 'still loaded is not newly loaded');
  assert.equal(store.stockLoaded(30000, 12000), false, 'draining is not loading');
  assert.equal(store.stockLoaded(null, 20), false, 'shelf stock is not a load-in');
});

test('the previous count comes back out, so the edge can be seen', async () => {
  const { db, listing } = await seeded();
  const first = await store.recordObservation(db, A, {
    listingId: listing.id, state: 'out', availableQuantity: 0,
  });
  assert.equal(first.previousQuantity, null, 'nothing was known before the first reading');
  const second = await store.recordObservation(db, A, {
    listingId: listing.id, state: 'out', availableQuantity: 31000,
  });
  assert.equal(second.previousQuantity, 0);
  assert.equal(store.stockLoaded(second.previousQuantity, 31000), true);
});

// ── Repeating the load-in alert ──────────────────────────────────────────────

test('THE FIRST SIGHTING ALWAYS ANNOUNCES, WHATEVER THE INTERVAL', async () => {
  // A null timestamp means nothing has been said about this listing. Making a
  // first load-in wait for an interval would silence the one message the whole
  // alarm exists to send.
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, { listingId: listing.id, state: 'out', availableQuantity: 0 });
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 60), true);
});

test('once only is the default, and it means once', async () => {
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, { listingId: listing.id, state: 'out', availableQuantity: 0 });
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 0), true, 'the edge');
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 0), false, 'and never again');
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 0), false);
});

test('a repeat interval that has not elapsed stays quiet', async () => {
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, { listingId: listing.id, state: 'out', availableQuantity: 0 });
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 30), true);
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 30), false, 'not 30 minutes later yet');
});

test('STOCK GOING AWAY FORGETS THE ALERT, SO THE NEXT LOAD-IN IS JUDGED FRESH', async () => {
  // Without this, a drop two weeks from now would be measured against a
  // timestamp from this one and announce late, or not at all.
  const { db, listing } = await seeded();
  await store.recordObservation(db, A, { listingId: listing.id, state: 'out', availableQuantity: 0 });
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 0), true);
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 0), false);
  await store.clearStagedAnnounce(db, A, listing.id);
  assert.equal(await store.claimStagedAnnounce(db, A, listing.id, 0), true, 'a new load-in speaks again');
});

test('the repeat interval refuses to become a stream', async () => {
  // A drop window checks every few seconds on purpose. An ALERT that fires
  // every minute gets muted before the drop it was warning about.
  assert.match(String(store.validateSettings({ stagedRepeatMinutes: 1 })), /no more often/);
  assert.equal(store.validateSettings({ stagedRepeatMinutes: 0 }), null, 'off is always allowed');
  assert.equal(store.validateSettings({ stagedRepeatMinutes: 30 }), null);
});

// ── Repeating the in-stock alert ─────────────────────────────────────────────

async function inStock(db: any, listingId: number) {
  await store.recordObservation(db, A, {
    listingId, state: 'out', availableQuantity: 0, sellerKind: 'retailer',
  });
  await store.recordObservation(db, A, {
    listingId, state: 'in', availableQuantity: 10, price: 59.99, sellerKind: 'retailer',
  });
  await store.beginStockAlerts(db, A, listingId);
}

/** Pretend the first alert went out this many minutes ago. */
async function firstAlertWas(db: any, listingId: number, minutesAgo: number) {
  await db.query(
    `UPDATE watch_state SET stock_notified_at = now() - ($2 || ' minutes')::interval
      WHERE listing_id = $1`,
    [listingId, minutesAgo],
  );
}

test('THE SCHEDULE SENDS EXACTLY WHAT IT SAYS, THEN STOPS', async () => {
  // "One at stock, one at 30 minutes." Two posts, and the second is the last
  // one — which is the whole reason this is a list and not an interval.
  const { db, listing } = await seeded();
  await inStock(db, listing.id);
  const after = [30];

  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), false, 'not yet');
  await firstAlertWas(db, A === A ? listing.id : listing.id, 31);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), true, 'the follow-up');
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), false, 'and that is all');
  await firstAlertWas(db, listing.id, 600);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), false, 'still all, hours later');
});

test('a two-step schedule fires in order and no faster', async () => {
  const { db, listing } = await seeded();
  await inStock(db, listing.id);
  const after = [30, 60];

  await firstAlertWas(db, listing.id, 31);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), true, 'the 30');
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), false, 'not the 60 yet');
  await firstAlertWas(db, listing.id, 61);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), true, 'the 60');
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, after), false, 'schedule spent');
});

test('an empty schedule says it once and never again', async () => {
  const { db, listing } = await seeded();
  await inStock(db, listing.id);
  await firstAlertWas(db, listing.id, 600);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, []), false);
});

test('GOING OUT OF STOCK MAKES COMING BACK NEWS AGAIN', async () => {
  const { db, listing } = await seeded();
  await inStock(db, listing.id);
  await firstAlertWas(db, listing.id, 31);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, [30]), true);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, [30]), false, 'spent');

  await store.clearStockAnnounce(db, A, listing.id);
  await inStock(db, listing.id);
  await firstAlertWas(db, listing.id, 31);
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, [30]), true, 'a new visit, a new schedule');
});

test('a listing that is not in stock is never claimed', async () => {
  const { db, listing } = await seeded();
  await inStock(db, listing.id);
  await firstAlertWas(db, listing.id, 60);
  await store.recordObservation(db, A, { listingId: listing.id, state: 'out', availableQuantity: 0 });
  assert.equal(await store.claimStockFollowUp(db, A, listing.id, [30]), false);
});

test('THE FOLLOW-UP TIMES MUST READ AS A TIMELINE', async () => {
  assert.equal(store.validateSettings({ inStockRepeatAfter: [30] }), null);
  assert.equal(store.validateSettings({ inStockRepeatAfter: [30, 60] }), null);
  assert.equal(store.validateSettings({ inStockRepeatAfter: [] }), null, 'off is allowed');
  assert.match(String(store.validateSettings({ inStockRepeatAfter: [60, 30] })), /go up/);
  assert.match(String(store.validateSettings({ inStockRepeatAfter: [30, 30] })), /go up/);
  assert.match(String(store.validateSettings({ inStockRepeatAfter: [1] })), /sooner than 5/);
});

// ── Muting one product ───────────────────────────────────────────────────────

test('A MISSION CAN BE MUTED WITHOUT BEING PAUSED', async () => {
  // Two different questions. Pausing stops Phantom looking; muting stops it
  // telling people, while the checking, the buying and the page carry on.
  const { db, listing } = await seeded();
  const m = await store.upsertMission(db, A, { listingId: listing.id, alerts: false });
  assert.equal(m.alerts, false);
  assert.equal(m.enabled, true, 'still watched');

  const back = await store.upsertMission(db, A, { listingId: listing.id, alerts: true });
  assert.equal(back.alerts, true);
});

test('a mission written without saying anything about alerts still announces', async () => {
  // Silence on upgrade is the failure to avoid: a mission that predates this
  // switch was posting, and must keep posting until somebody says otherwise.
  const { db, listing } = await seeded();
  const m = await store.upsertMission(db, A, { listingId: listing.id });
  assert.equal(m.alerts, true);
});

test('THE EMPTY-SYSTEM DEFAULTS ARE SILENCE, NOT A STREAM', async () => {
  // Nobody gets a new class of message because they upgraded. Both repeats are
  // off out of the box; the window only matters once one is switched on.
  const db = await TestDb.create();
  const cfg = await store.getSettings(db, A);
  assert.equal(cfg.stagedRepeatMinutes, 0);
  assert.deepEqual(cfg.inStockRepeatAfter, [], 'no follow-ups until somebody schedules them');
});

// ── The profile ──────────────────────────────────────────────────────────────

test('A PROFILE COUNTS THIS ACCOUNT AND NOBODY ELSE', async () => {
  // A profile that quietly showed the owner's totals to a member would be a
  // leak wearing a friendly face.
  const { db, listing } = await seeded();
  const other = await store.upsertUser(db, { handle: 'someone-else' }).catch(() => null);
  const mine = await store.profile(db, A);
  assert.equal(mine.handle.length > 0, true);
  assert.equal(mine.missions, 1, 'the one mission this account has');
  assert.equal(mine.bought, 0);
  assert.equal(mine.spent, 0);
  assert.equal(typeof mine.vaultLinked, 'boolean');
  if (other) {
    const theirs = await store.profile(db, other.id);
    assert.equal(theirs.missions, 0, 'a fresh account watches nothing');
  }
});

test('the profile carries no secret about the account', async () => {
  // Not the token, not its hash, and not the vault id — that an account is
  // linked is the useful fact; which account it is linked to is somebody's
  // identifier in another system.
  const { db } = await seeded();
  const p = await store.profile(db, A);
  const text = JSON.stringify(p).toLowerCase();
  assert.ok(!text.includes('token'));
  assert.ok(!text.includes('hash'));
  assert.ok(!('vaultUserId' in p));
});
