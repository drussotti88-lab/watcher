/**
 * Where one person ends and another begins.
 *
 * ── The line, since the shared catalogue (1 Sep 2026) ───────────────────────
 *
 * Facts about the world are SHARED. Decisions about money are PRIVATE.
 *
 * Products, listings, watch_state, observations and discoveries describe a
 * retailer's shelf, and a shelf does not belong to anybody — so everyone reads
 * one copy, and only a CATALOGUE WRITER may change it. Missions, settings,
 * runs, authorisations and acquisitions can spend money, so every one of them
 * still carries a user_id that the SQL must actually use.
 *
 * The compiler forces every store function to be handed a userId. Nothing
 * forces the SQL to *use* it, and a query that accepts an owner and ignores it
 * is the failure that spends the wrong person's money. residency.test.ts reads
 * the SQL statically; this file proves it against a real database.
 *
 * The catalogue tests changed shape here, and two of them inverted outright.
 * That is the point of writing them down: a shared row that used to be private
 * is exactly the kind of change that quietly turns a safety property into a
 * comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import * as store from '../src/store.ts';

const A = 1;
const B = 2;

/**
 * A catalogue owner (A) and a member (B), both watching one shared listing.
 *
 * A holds `can_write_catalogue`; B does not, which is the default for every
 * account the vault's SSO provisions. The listing is ONE row now — the two
 * missions against it are what make it two people's business.
 */
async function twoUsers() {
  const db = await TestDb.create();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");

  const product = await store.upsertProduct(db, A, { name: 'Pitch Black ETB', msrp: 49.99 });
  const listing = await store.addListing(db, A, {
    productKey: product.key, retailer: 'Target', externalId: '1012644666',
    url: 'https://www.target.com/p/-/A-1012644666',
  });

  const myMission = await store.upsertMission(db, A, { listingId: listing.id, label: 'mine' });
  const theirMission = await store.upsertMission(db, B, {
    listingId: listing.id, label: 'theirs',
  });

  return { db, product, listing, myMission, theirMission };
}

test('TWO PEOPLE WATCH ONE SHARED LISTING — one read, two missions', async () => {
  // INVERTED 1 Sep 2026. This used to assert two listings and two products,
  // because each person catalogued their own. That is exactly the shape that
  // made traffic scale with membership: one page, read once per member, at the
  // retailers whose tolerance is the constraint on this whole system.
  //
  // Now there is one row for the shelf and one mission each. The intent of the
  // test is unchanged — two people can both watch the thing — but the
  // mechanism is the opposite of what it was.
  const { db, listing, myMission, theirMission } = await twoUsers();

  assert.equal((await store.listListings(db, A)).length, 1, 'one listing exists');
  assert.equal((await store.listListings(db, B)).length, 1, 'and both people see it');
  assert.notEqual(myMission.id, theirMission.id, 'two missions against it');

  assert.equal((await store.listMissions(db, A)).length, 1);
  assert.equal((await store.listMissions(db, B)).length, 1);
  assert.equal((await store.listMissions(db, A))[0]!.label, 'mine');
  assert.equal((await store.listMissions(db, B))[0]!.label, 'theirs');
});

test('the catalogue is one catalogue — everybody reads the same rows', async () => {
  const { db, product } = await twoUsers();
  const mine = await store.listProducts(db, A);
  const theirs = await store.listProducts(db, B);
  assert.equal(mine.length, 1);
  assert.deepEqual(mine.map((x) => x.key), theirs.map((x) => x.key));
  assert.equal(theirs[0]!.msrp, 49.99, 'one MSRP, curated once, for everyone');
  assert.equal(product.key, mine[0]!.key);
});

test('A MEMBER CANNOT CHANGE THE CATALOGUE — curation is a role, not a race', async () => {
  // B has no can_write_catalogue, which is the default for every account the
  // vault provisions. Without this, any member could delete the product every
  // other member's mission depends on.
  const { db, product, listing } = await twoUsers();

  assert.equal(await store.canWriteCatalogue(db, A), true, 'the owner curates');
  assert.equal(await store.canWriteCatalogue(db, B), false, 'a member does not');

  assert.equal(await store.deleteProduct(db, B, product.key), false, 'refused');
  assert.equal((await store.listProducts(db, A)).length, 1, 'still there');

  assert.equal(await store.deleteListing(db, B, listing.id), false, 'refused');
  assert.equal((await store.listListings(db, A)).length, 1, 'still there');
});

test('A MEMBER CANNOT WRITE A READING — one bad reading would mislead everyone', async () => {
  // The rule this replaces was "you may only write to a listing you own", and
  // it was load-bearing: it stopped one person's agent telling another
  // person's ARMED mission that a $500 box is in stock at $5. Shared listings
  // dissolve it, so the gate became the writer instead of the row — and the
  // stakes went UP, because a bad reading now reaches every member at once.
  const { db, listing } = await twoUsers();

  await assert.rejects(
    () => store.recordObservation(db, B, {
      listingId: listing.id, state: 'in', confidence: 'exact', price: 5,
    }),
    /may not write readings/,
  );

  const theirs = await store.listMissions(db, B);
  assert.equal(theirs[0]!.state, 'unchecked', 'nothing was written');
  assert.equal(theirs[0]!.price, null);
});

test('ONE READING SERVES EVERY MISSION ON THAT LISTING', async () => {
  // The whole point of the shared catalogue: the owner's Phantom reads a page
  // once and everybody watching it is told.
  const { db, listing } = await twoUsers();

  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
  });

  for (const who of [A, B]) {
    const m = (await store.listMissions(db, who))[0]!;
    assert.equal(m.state, 'in', `user ${who} sees the reading`);
    assert.equal(m.price, 49.99);
  }
});

test('findListing finds the one shared listing, whoever asks', async () => {
  const { db, listing } = await twoUsers();
  assert.equal((await store.findListing(db, A, 'Target', '1012644666'))?.id, listing.id);
  assert.equal((await store.findListing(db, B, 'Target', '1012644666'))?.id, listing.id);
});

test('MISSIONS: I CANNOT ARM THEIRS', async () => {
  // The one that matters most, and the one the shared catalogue had to leave
  // untouched. A mission is the only thing authorised to spend.
  //
  // The shape changed: arming against the SHARED listing is now legitimate —
  // it arms MY mission, because a listing is a shelf and not a possession.
  // What must remain impossible is that touching it reaches THEIR mission.
  const { db, listing } = await twoUsers();

  await store.upsertMission(db, A, { listingId: listing.id, armed: true, ceiling: 500 });

  const mine = (await store.listMissions(db, A))[0]!;
  assert.equal(mine.armed, true, 'my own mission armed, on the shared listing');

  const theirs = (await store.listMissions(db, B))[0]!;
  assert.equal(theirs.armed, false, 'still unarmed');
  assert.equal(theirs.ceiling, null, 'and still with no ceiling');
});

test('missions: I cannot see, delete or trigger theirs', async () => {
  const { db, theirMission } = await twoUsers();

  assert.equal((await store.listMissions(db, A)).length, 1);
  assert.equal(await store.getMission(db, A, theirMission.id), null);
  assert.equal(await store.requestCheckNow(db, A, theirMission.id), false);

  await store.deleteMission(db, A, theirMission.id);
  assert.equal((await store.listMissions(db, B)).length, 1, 'still theirs');
});

test('A MEMBER CANNOT ARM — watch-only until they have an agent of their own', async () => {
  // Arming is a standing instruction to spend, carried out by a browser signed
  // into a retail account with a card behind it. That machine is the owner's.
  const { db, listing } = await twoUsers();

  assert.equal(await store.canArm(db, A), true);
  assert.equal(await store.canArm(db, B), false);

  await assert.rejects(
    () => store.upsertMission(db, B, { listingId: listing.id, armed: true, ceiling: 50 }),
    /can watch but not buy/,
  );

  // …and watching is still theirs to do.
  const watching = await store.upsertMission(db, B, { listingId: listing.id, label: 'watch me' });
  assert.equal(watching.armed, false);
});

test('the change log belongs to the listing, so everyone watching sees it', async () => {
  // It used to be per owner, because a listing was. One shelf, one history.
  const { db, listing } = await twoUsers();
  await store.recordObservation(db, A, {
    listingId: listing.id, state: 'in', confidence: 'exact', price: 49.99,
  });

  assert.equal((await store.recentObservations(db, A)).length, 1);
  assert.equal((await store.recentObservations(db, B)).length, 1,
    'the member watching it sees the same change');
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

test('THE WATCHLIST IS THE CATALOGUE — read once, for everybody', async () => {
  // INVERTED. This used to prove each Phantom pulled only its own listings,
  // which is precisely what made traffic scale with membership. The catalogue
  // is now one list, read once, and the readings serve every mission on it.
  const { db, listing } = await twoUsers();
  const list = await store.watchlist(db, A);
  assert.equal(list.length, 1, 'one shelf, one entry — not one per member');
  assert.equal(list[0]!.listingId, listing.id);
  assert.deepEqual(
    (await store.watchlist(db, B)).map((w) => w.listingId),
    list.map((w) => w.listingId),
    'and it is the same list whoever asks',
  );
});

/**
 * A second listing that ONLY the member watches.
 *
 * This is the case the fan-out exists for: nobody with a browser is watching
 * it, so unless the owner's agent picks it up, it is never read at all.
 */
async function theirsAlone(db: TestDb) {
  const product = await store.upsertProduct(db, A, { name: 'Phantom Forces ETB', msrp: 39.99 });
  const listing = await store.addListing(db, A, {
    productKey: product.key, retailer: 'Walmart', externalId: '999',
    url: 'https://www.walmart.com/ip/999',
  });
  const mission = await store.upsertMission(db, B, { listingId: listing.id, label: 'only theirs' });
  return { listing, mission };
}

test('ONE READ SERVES EVERYONE — the owner pulls the union of every mission', async () => {
  // The whole economics of the shared catalogue. Without this, ten members
  // watching one Target page is ten fetches of one page, and the constraint on
  // this system is the retailer's patience, not our CPU.
  const { db, listing } = await twoUsers();
  const other = await theirsAlone(db);

  const mine = await store.activeMissions(db, A);
  assert.deepEqual(
    mine.map((m) => m.listingId).sort((x, y) => x - y),
    [listing.id, other.listing.id].sort((x, y) => x - y),
    'both shelves, even the one only they watch',
  );
  assert.equal(mine.length, 2, 'and the shared listing appears ONCE, not once per member');
});

test('A MEMBER PULLS ONLY THEIR OWN — no browser, no favours to do', async () => {
  const { db, listing } = await twoUsers();
  await theirsAlone(db);
  const theirs = await store.activeMissions(db, B);
  assert.equal(theirs.length, 2, 'their two missions');
  assert.ok(theirs.every((m) => !m.readOnly), 'all their own — nothing borrowed');
  assert.ok(theirs.some((m) => m.listingId === listing.id));
});

test('A BORROWED MISSION COMES BACK READ-ONLY AND DISARMED', async () => {
  // Runs are private and recordRun would refuse one written against somebody
  // else's mission. Marking the row is what stops the agent trying — and
  // blanking `armed` is what stops it spending on a mandate that is not ours.
  const { db } = await twoUsers();
  const other = await theirsAlone(db);
  // Straight to SQL on purpose: upsertMission refuses to arm a member at all
  // (proved above). This forges the row that rule is meant to make impossible,
  // so the second lock is tested rather than assumed.
  await db.query('UPDATE missions SET armed = true, ceiling = 200 WHERE id = $1', [
    other.mission.id,
  ]);

  const row = (await store.activeMissions(db, A)).find((m) => m.listingId === other.listing.id);
  assert.ok(row, 'the owner still reads it');
  assert.equal(row!.readOnly, true);
  assert.equal(row!.armed, false, 'armed is blanked no matter what their row says');
});

test('MY OWN ROW WINS ON A LISTING WE BOTH WATCH — my mandate, not theirs', async () => {
  // Take the wrong row and the agent either buys on somebody else's ceiling or
  // sits on its hands while the drop it was armed for goes by.
  const { db, listing, myMission, theirMission } = await twoUsers();
  await store.upsertMission(db, A, {
    listingId: listing.id, label: 'mine', armed: true, ceiling: 60,
  });
  await db.query('UPDATE missions SET armed = true, ceiling = 999 WHERE id = $1', [
    theirMission.id,
  ]);

  const row = (await store.activeMissions(db, A)).find((m) => m.listingId === listing.id);
  assert.equal(row!.id, myMission.id);
  assert.ok(!row!.readOnly);
  assert.equal(row!.ceiling, 60, "their ceiling never becomes mine");
});

test("a member's CHECK NOW is honoured on a listing the owner also watches", async () => {
  // "Check now" belongs to the LISTING once the read is shared. The row the
  // owner's agent gets back is their own — so without folding the flag in, a
  // member's button would set a flag nobody ever looks at.
  const { db, listing, theirMission } = await twoUsers();
  assert.equal(await store.requestCheckNow(db, B, theirMission.id), true);

  const row = (await store.activeMissions(db, A)).find((m) => m.listingId === listing.id);
  assert.ok(!row!.readOnly, 'still my row, my mandate');
  assert.equal(row!.checkNow, true, 'but their request is what gets the page fetched');
});

test('A PHANTOM TOKEN IDENTIFIES EXACTLY ONE USER, BY HASH', async () => {
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
