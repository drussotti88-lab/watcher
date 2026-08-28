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
  const sources = await store.listAllSources(db);
  assert.equal(sources.length, 3);
});

test('the seed is safe to run twice', async () => {
  const db = await seeded();
  await db.exec(seedSql);
  const sources = await store.listAllSources(db);
  assert.equal(sources.length, 3, 'ON CONFLICT DO NOTHING throughout');
});

test('every source is via the Watcher — no datacentre fetches all three 403', async () => {
  const db = await seeded();
  for (const source of await store.listAllSources(db)) {
    assert.equal(source.via, 'watcher', `${source.id} should not be fetched from a datacentre`);
  }
});

test('the watchlist is not empty on day one', async () => {
  const db = await seeded();
  const watches = await store.watchlist(db);
  assert.equal(watches.length, 3, 'one known-good product per retailer');

  for (const w of watches) {
    assert.ok(w.url, `${w.productKey} has no URL, so nothing can poll it`);
    assert.match(w.url, /^https:\/\//);
    assert.ok(w.externalId, `${w.productKey} has no retailer id`);
  }

  const retailers = watches.map((w) => w.retailer).sort();
  assert.deepEqual(retailers, ['Pokemon Center', 'Target', 'Walmart']);
});

test('seeding announces nothing — three alerts on first run would be noise', async () => {
  const db = await seeded();
  for (const source of await store.listAllSources(db)) {
    assert.deepEqual(
      await store.pendingDiscoveries(db, source.id),
      [],
      `${source.id} would announce its seed rows`,
    );
  }
});
