/**
 * End-to-end sweep behaviour against real Postgres (PGlite, in-process).
 *
 * The two properties worth proving, because getting either wrong makes the
 * tool useless in opposite ways:
 *   1. Turning a source on never announces its back catalogue (you'd mute it).
 *   2. Once seeded, a genuinely new SKU announces exactly once (you'd miss it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { sweepSource } from '../src/discover.ts';
import * as store from '../src/store.ts';
import type { SourceRow } from '../src/types.ts';

const CHILDREN = 7;
const CHILD_LIMIT = 3;

function indexXml(): string {
  const entries = Array.from(
    { length: CHILDREN },
    (_, i) => `<sitemap><loc>https://shop.test/sm_${i}.xml</loc></sitemap>`,
  ).join('\n');
  return `<?xml version="1.0"?><sitemapindex>${entries}</sitemapindex>`;
}

/** Each child holds two Pokemon products and one decoy that must be filtered. */
function childXml(child: number, extra: string[] = []): string {
  const urls = [
    `https://shop.test/p/pokemon-item-${child}-a/-/A-${child}01`,
    `https://shop.test/p/pokemon-item-${child}-b/-/A-${child}02`,
    `https://shop.test/p/bath-towel-${child}/-/A-${child}99`,
    ...extra,
  ]
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0"?><urlset>${urls}</urlset>`;
}

function makeFetcher(extras: Map<number, string[]>) {
  return async (url: string): Promise<string> => {
    if (url.endsWith('index.xml')) return indexXml();
    const m = /sm_(\d+)\.xml$/.exec(url);
    if (m) {
      const n = Number(m[1]);
      return childXml(n, extras.get(n) ?? []);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

async function setup(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled)
     VALUES ('shop', 'Test shop', 'Shop', 'sitemap_index',
             'https://shop.test/index.xml', 'hub', $1::jsonb, true)`,
    [JSON.stringify({ filters: ['pokemon'], childLimit: CHILD_LIMIT })],
  );
  return db;
}

const reload = async (db: TestDb): Promise<SourceRow> => {
  const row = await store.getSource(db, 'shop');
  assert.ok(row, 'source vanished');
  return row;
};

test('seeding stays silent until a full lap of the index is complete', async () => {
  const db = await setup();
  const fetcher = makeFetcher(new Map());

  let sweeps = 0;
  let announcedDuringSeeding = 0;
  let source = await reload(db);

  while (!source.seeded && sweeps < 25) {
    const result = await sweepSource(db, source, fetcher);
    assert.equal(result.ok, true, result.error);
    announcedDuringSeeding += result.fresh.length;
    sweeps += 1;
    source = await reload(db);
  }

  assert.ok(source.seeded, 'never finished seeding');
  assert.equal(announcedDuringSeeding, 0, 'seeding must announce nothing');
  assert.ok(sweeps > 1, 'a 7-child index should take more than one pass');

  // Every Pokemon product across every child is now on record; no towels.
  const rows = await db.query<{ external_id: string; name: string }>(
    'SELECT external_id, name FROM discoveries',
  );
  assert.equal(rows.length, CHILDREN * 2, 'two products per child, decoys filtered');
  assert.ok(rows.every((r) => /pokemon/i.test(r.name)));
});

test('after seeding, a genuinely new SKU announces exactly once', async () => {
  const db = await setup();
  const extras = new Map<number, string[]>();
  const fetcher = makeFetcher(extras);

  let source = await reload(db);
  let guard = 0;
  while (!source.seeded && guard++ < 25) {
    await sweepSource(db, source, fetcher);
    source = await reload(db);
  }

  // A new product lands in child 4.
  extras.set(4, ['https://shop.test/p/pokemon-mega-evolution-etb/-/A-999777']);

  // Sweep until the rotation reaches child 4.
  const announced: string[] = [];
  for (let i = 0; i < CHILDREN + 2; i++) {
    source = await reload(db);
    const result = await sweepSource(db, source, fetcher);
    announced.push(...result.fresh.map((f) => f.externalId));
  }

  const hits = announced.filter((id) => id === '999777');
  assert.equal(hits.length, 1, `expected exactly one announcement, got ${hits.length}`);

  // And it was given an identity, with the retailer id as an alias pointing at it.
  const [alias] = await db.query<{ product_key: string }>(
    'SELECT product_key FROM aliases WHERE value = $1',
    ['999777'],
  );
  assert.ok(alias, 'no alias minted');
  assert.match(alias.product_key, /^prd_/);
  assert.match(alias.product_key, /mega_evolution_etb/);
});

test('a steady catalogue announces nothing, repeatedly', async () => {
  const db = await setup();
  const fetcher = makeFetcher(new Map());

  let source = await reload(db);
  let guard = 0;
  while (!source.seeded && guard++ < 25) {
    await sweepSource(db, source, fetcher);
    source = await reload(db);
  }

  let noise = 0;
  for (let i = 0; i < CHILDREN * 2; i++) {
    source = await reload(db);
    const result = await sweepSource(db, source, fetcher);
    noise += result.fresh.length;
  }
  assert.equal(noise, 0, 'nothing changed, so nothing should be announced');
});

test('a fetch failure is recorded, not thrown, and leaves the cursor alone', async () => {
  const db = await setup();
  const before = await reload(db);
  const failing = async () => {
    throw new Error('403 — looks like a block');
  };

  const result = await sweepSource(db, before, failing);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /403/);

  const after = await reload(db);
  assert.equal(after.cursor, before.cursor, 'a failed sweep must not advance the cursor');
  assert.match(after.lastStatus, /error/);

  const events = await db.query("SELECT * FROM events WHERE kind = 'sweep_error'");
  assert.equal(events.length, 1, 'the failure should be in the ops log');
});

test('the watcher ingest path shares the same dedupe ledger', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('pc', 'PC via watcher', 'Pokemon Center', 'watcher', '', 'watcher',
             '{}'::jsonb, true, true)`,
  );

  const items = [
    { externalId: '100-1', name: 'Mega Charizard Figure', url: 'https://pc.test/product/100-1' },
  ];

  const known = await store.knownIds(db, 'pc');
  const fresh = items.filter((i) => !known.has(i.externalId));
  const first = await store.recordDiscoveries(db, 'pc', fresh, true);
  assert.equal(first.length, 1, 'first submission is new');

  const known2 = await store.knownIds(db, 'pc');
  const fresh2 = items.filter((i) => !known2.has(i.externalId));
  const second = await store.recordDiscoveries(db, 'pc', fresh2, true);
  assert.equal(second.length, 0, 'resubmitting the same item announces nothing');
});
