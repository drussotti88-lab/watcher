/**
 * The seed file is code, and it has been wrong before.
 *
 * Its first version guessed that a deployed Worker might reach Target and
 * Walmart where local testing could not, and left both enabled on `via = 'hub'`
 * on that hope. The deployed Hub then got 403 from all three. A seed carrying a
 * stale guess is worse than no seed: it looks like a decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Everything that existed before ownership did belongs to the first user. */
const USER = 1;
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TestDb } from './pg.ts';
import * as store from '../src/store.ts';

const seedSql = readFileSync(resolve(import.meta.dirname, '..', 'seed.sql'), 'utf8');

async function seeded(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.exec(seedSql);
  return db;
}

test('the seed applies to a fresh Postgres database', async () => {
  const db = await seeded();
  const sources = await store.listAllSources(db, USER);
  assert.equal(sources.length, 3);
});

test('the seed is safe to run twice', async () => {
  const db = await seeded();
  await db.exec(seedSql);
  const sources = await store.listAllSources(db, USER);
  assert.equal(sources.length, 3, 'ON CONFLICT DO NOTHING throughout');
});

test('every source is via the Watcher — no datacentre fetches all three 403', async () => {
  const db = await seeded();
  for (const source of await store.listAllSources(db, USER)) {
    assert.equal(source.via, 'watcher', `${source.id} should not be fetched from a datacentre`);
  }
});

test('the watchlist is not empty on day one', async () => {
  const db = await seeded();
  const watches = await store.watchlist(db, USER);
  assert.equal(watches.length, 3, 'one known-good listing per retailer');

  for (const w of watches) {
    assert.ok(w.url, `${w.productKey} has no URL, so nothing can poll it`);
    assert.match(w.url, /^https:\/\//);
    assert.ok(w.externalId, `${w.productKey} has no retailer id`);
    assert.ok(w.listingId > 0, `${w.productKey} has no listing to report against`);
  }

  const retailers = watches.map((w) => w.retailer).sort();
  assert.deepEqual(retailers, ['Pokemon Center', 'Target', 'Walmart']);
});

test('TARGET ONLY on the first run — one retailer is one failure mode', async () => {
  // Three at once means three ways to be wrong about which thing broke. The
  // other two readers are written and tested; their missions are one toggle
  // away in the app.
  const db = await seeded();
  const missions = await store.listMissions(db, USER);
  assert.equal(missions.length, 3, 'all three exist');

  const on = missions.filter((m) => m.enabled);
  assert.equal(on.length, 1);
  assert.equal(on[0]!.retailer, 'Target');

  const active = await store.activeMissions(db, USER);
  assert.equal(active.length, 1, 'and only Target is polled');
});

test('the seed arms nothing — spending is never a side effect of setup', async () => {
  const db = await seeded();
  for (const m of await store.listMissions(db, USER)) {
    assert.equal(m.armed, false, `${m.retailer} was armed by a seed file`);
    assert.equal(m.ceiling, null);
  }
});

test('seeding announces nothing — three alerts on first run would be noise', async () => {
  const db = await seeded();
  for (const source of await store.listAllSources(db, USER)) {
    assert.deepEqual(
      await store.pendingDiscoveries(db, USER, source.id),
      [],
      `${source.id} would announce its seed rows`,
    );
  }
});
