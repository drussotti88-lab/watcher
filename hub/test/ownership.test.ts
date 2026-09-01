/**
 * One person cannot see or touch another person's anything.
 *
 * The compiler forces every store function to be handed a userId. Nothing
 * forces the SQL to *use* it, and a query that accepts an owner and ignores it
 * is the failure that spends the wrong person's money. residency.test.ts reads
 * the SQL statically; this file proves it against a real database.
 *
 * One test per owned table, named for the leak it prevents. They are dull on
 * purpose — the value is in there being one for every table, with no gaps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import * as store from '../src/store.ts';

const A = 1;
const B = 2;

/** Two users, each with a product, a listing and a mission on the same tcin. */
async function twoUsers() {
  const db = await TestDb.create();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");

  const mine = await store.upsertProduct(db, A, { name: 'Pitch Black ETB', msrp: 49.99 });
  const theirs = await store.upsertProduct(db, B, { name: 'Pitch Black ETB', msrp: 999 });

  const myListing = await store.addListing(db, A, {
    productKey: mine.key, retailer: 'Target', externalId: '1012644666',
    url: 'https://www.target.com/p/-/A-1012644666',
  });
  const theirListing = await store.addListing(db, B, {
    productKey: theirs.key, retailer: 'Target', externalId: '1012644666',
    url: 'https://www.target.com/p/-/A-1012644666',
  });

  const myMission = await store.upsertMission(db, A, { listingId: myListing.id, label: 'mine' });
  const theirMission = await store.upsertMission(db, B, {
    listingId: theirListing.id, label: 'theirs',
  });

  return { db, mine, theirs, myListing, theirListing, myMission, theirMission };
}

test('TWO PEOPLE CAN WATCH THE SAME PRODUCT AT THE SAME RETAILER', async () => {
  // The precondition for everything else. Every uniqueness rule in the schema
  // was written for one user and would otherwise stop the second person dead —
  // or worse, have their add silently overwrite the first person's product.
  const { db, mine, theirs, myListing, theirListing } = await twoUsers();

  assert.notEqual(myListing.id, theirListing.id, 'two listings, not one shared');
  assert.equal(mine.key, theirs.key, 'the same key, minted from the same name');

  const myProducts = await store.listProducts(db, A);
  const theirProducts = await store.listProducts(db, B);
  assert.equal(myProducts.length, 1);
  assert.equal(theirProducts.length, 1);
  assert.equal(myProducts[0]!.msrp, 49.99, "and their MSRP did not overwrite mine");
  assert.equal(theirProducts[0]!.msrp, 999);
});

test('products: I cannot see theirs', async () => {
  const { db } = await twoUsers();
  const mine = await store.listProducts(db, A);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.msrp, 49.99);
});

test('products: I cannot delete theirs', async () => {
  const { db, theirs } = await twoUsers();
  await store.deleteProduct(db, A, theirs.key);
  assert.equal((await store.listProducts(db, B)).length, 1, 'still theirs');
});

test('listings: I cannot see or delete theirs', async () => {
  const { db, theirListing } = await twoUsers();
  assert.equal((await store.listListings(db, A)).length, 1);

  await store.deleteListing(db, A, theirListing.id);
  assert.equal((await store.listListings(db, B)).length, 1, 'still theirs');
});

test('listings: findListing does not reach across owners', async () => {
  // The lookup quick-add uses. Reaching across here would attach one person's
  // new mission to another person's listing.
  const { db, myListing } = await twoUsers();
  const found = await store.findListing(db, A, 'Target', '1012644666');
  assert.equal(found?.id, myListing.id);
});

test('MISSIONS: I CANNOT ARM THEIRS', async () => {
  // The one that matters most. A mission is the only thing authorised to spend,
  // and upsertMission takes a listingId straight off the wire.
  const { db, theirListing } = await twoUsers();

  await assert.rejects(
    () => store.upsertMission(db, A, { listingId: theirListing.id, armed: true, ceiling: 500 }),
    /does not belong to you/,
  );

  const theirs = await store.listMissions(db, B);
  assert.equal(theirs[0]!.armed, false, 'still unarmed');
  assert.equal(theirs[0]!.ceiling, null, 'and still with no ceiling');
});

test('missions: I cannot see, delete or trigger theirs', async () => {
  const { db, theirMission } = await twoUsers();

  assert.equal((await store.listMissions(db, A)).length, 1);
  assert.equal(await store.getMission(db, A, theirMission.id), null);
  assert.equal(await store.requestCheckNow(db, A, theirMission.id), false);

  await store.deleteMission(db, A, theirMission.id);
  assert.equal((await store.listMissions(db, B)).length, 1, 'still theirs');
});

test('OBSERVATIONS: MY WATCHER CANNOT REWRITE THEIR STOCK AND PRICE', async () => {
  // A reading names a listing by id and arrives over the wire. If it could land
  // on someone else's listing, one person's Phantom could tell another
  // person's armed mission that a $500 item is in stock at $5.
  const { db, theirListing } = await twoUsers();

  await assert.rejects(
    () => store.recordObservation(db, A, {
      listingId: theirListing.id, state: 'in', confidence: 'exact', price: 5,
    }),
    /does not belong to you/,
  );

  const theirs = await store.listMissions(db, B);
  assert.equal(theirs[0]!.state, 'unchecked', 'nothing was written');
  assert.equal(theirs[0]!.price, null);
});

test('observations: the change log is per owner', async () => {
  const { db, myListing } = await twoUsers();
  await store.recordObservation(db, A, {
    listingId: myListing.id, state: 'in', confidence: 'exact', price: 49.99,
  });

  assert.equal((await store.recentObservations(db, A)).length, 1);
  assert.equal((await store.recentObservations(db, B)).length, 0);
});

test('mission_runs: history does not leak, and cannot be written to theirs', async () => {
  const { db, myMission, theirMission } = await twoUsers();
  await store.recordRun(db, A, myMission.id, { outcome: 'failed', reason: 'mine' });

  await assert.rejects(
    () => store.recordRun(db, A, theirMission.id, { outcome: 'bought', reason: 'not mine' }),
    /does not belong to you/,
  );

  assert.equal((await store.recentRuns(db, A)).length, 1);
  assert.equal((await store.recentRuns(db, B)).length, 0);
  assert.equal((await store.missionRuns(db, A, theirMission.id)).length, 0);
});

test('SETTINGS: MY TAX RATE IS NOT THEIR TAX RATE', async () => {
  // Settings feed the ceiling. Sharing them would silently move somebody
  // else's spending limit.
  const { db } = await twoUsers();
  await store.setSettings(db, A, { taxRate: 0.0975, shippingAllowance: 9.99 });

  assert.deepEqual(await store.getSettings(db, B), store.DEFAULT_SETTINGS);
  assert.equal((await store.getSettings(db, A)).taxRate, 0.0975);
});

test('sources and discoveries: the hunt is per owner', async () => {
  const { db } = await twoUsers();
  await db.query(
    `INSERT INTO sources (user_id, id, label, retailer, kind, url, via)
     VALUES (1, 'mine', 'Mine', 'Target', 'watcher', 'https://x', 'watcher')`,
  );
  assert.equal((await store.listSources(db, A)).length, 1);
  assert.equal((await store.listSources(db, B)).length, 0);
  assert.equal(await store.getSource(db, B, 'mine'), null);

  await store.recordDiscoveries(db, A, 'mine', [
    { externalId: 'x1', name: 'thing', url: 'https://x/1', price: 1 },
  ], true);
  assert.equal((await store.knownIds(db, A, 'mine')).size, 1);
  assert.equal((await store.knownIds(db, B, 'mine')).size, 0);
});

test('the watchlist Phantom pulls is only its own', async () => {
  const { db } = await twoUsers();
  assert.equal((await store.watchlist(db, A)).length, 1);
  assert.equal((await store.watchlist(db, B)).length, 1);
  assert.notEqual((await store.watchlist(db, A))[0]!.listingId,
                  (await store.watchlist(db, B))[0]!.listingId);
});

test('A WATCHER TOKEN IDENTIFIES EXACTLY ONE USER, BY HASH', async () => {
  const { db } = await twoUsers();
  const hash = 'a'.repeat(64);
  await db.query('UPDATE users SET token_hash = $1 WHERE id = 2', [hash]);

  assert.equal(await store.userByTokenHash(db, hash), 2);
  assert.equal(await store.userByTokenHash(db, 'b'.repeat(64)), 0, 'a wrong hash is nobody');
  assert.equal(await store.userByTokenHash(db, ''), 0, 'and so is an empty one');
});

test('a disabled user is nobody, whatever token they present', async () => {
  const { db } = await twoUsers();
  const hash = 'c'.repeat(64);
  await db.query('UPDATE users SET token_hash = $1, enabled = false WHERE id = 2', [hash]);
  assert.equal(await store.userByTokenHash(db, hash), 0);
});
