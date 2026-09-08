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

/** Everything that existed before ownership did belongs to the first user. */
const USER = 1;

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
  const row = await store.getSource(db, USER, 'shop');
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
    const result = await sweepSource(db, USER, source, fetcher);
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
    await sweepSource(db, USER, source, fetcher);
    source = await reload(db);
  }

  // A new product lands in child 4.
  extras.set(4, ['https://shop.test/p/pokemon-mega-evolution-etb/-/A-999777']);

  // Sweep until the rotation reaches child 4.
  const announced: string[] = [];
  for (let i = 0; i < CHILDREN + 2; i++) {
    source = await reload(db);
    const result = await sweepSource(db, USER, source, fetcher);
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
    await sweepSource(db, USER, source, fetcher);
    source = await reload(db);
  }

  let noise = 0;
  for (let i = 0; i < CHILDREN * 2; i++) {
    source = await reload(db);
    const result = await sweepSource(db, USER, source, fetcher);
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

  const result = await sweepSource(db, USER, before, failing);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /403/);

  const after = await reload(db);
  assert.equal(after.cursor, before.cursor, 'a failed sweep must not advance the cursor');
  assert.match(after.lastStatus, /error/);

  const events = await db.query("SELECT * FROM events WHERE kind = 'sweep_error'");
  assert.equal(events.length, 1, 'the failure should be in the ops log');
});

test('Phantom ingest path shares the same dedupe ledger', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('pc', 'PC via Phantom', 'Pokemon Center', 'watcher', '', 'watcher',
             '{}'::jsonb, true, true)`,
  );

  const items = [
    { externalId: '100-1', name: 'Mega Charizard Figure', url: 'https://pc.test/product/100-1' },
  ];

  const known = await store.knownIds(db, USER, 'pc');
  const fresh = items.filter((i) => !known.has(i.externalId));
  const first = await store.recordDiscoveries(db, USER, 'pc', fresh, true);
  assert.equal(first.length, 1, 'first submission is new');

  const known2 = await store.knownIds(db, USER, 'pc');
  const fresh2 = items.filter((i) => !known2.has(i.externalId));
  const second = await store.recordDiscoveries(db, USER, 'pc', fresh2, true);
  assert.equal(second.length, 0, 'resubmitting the same item announces nothing');
});

// ── Ranking the finds, and retiring the ones nobody prints ──────────────────
//
// 8 Sep 2026. Discovery held 136 Walmart finds and 76 had never been looked
// at, because the top of the list was a 2016 Elite Trainer Box and the bottom
// was next week's release. These pin the two halves of the fix: the era that
// only ever sorts, and the retired series that is allowed to decide.

const walmartSource = async (db: TestDb): Promise<void> => {
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('wm', 'Walmart via Phantom', 'Walmart', 'watcher', '', 'watcher',
             '{}'::jsonb, true, true)`,
  );
};

const found = (externalId: string, name: string, over: Record<string, unknown> = {}) => ({
  externalId,
  name,
  url: `https://walmart.test/ip/${externalId}`,
  retailer: 'Walmart',
  state: 'out',
  ...over,
});

/** The catalogue Target and Pokémon Center are actually selling this month. */
const CURRENT = [
  'Pokémon TCG: 30th Celebration Elite Trainer Box',
  'Pokémon TCG: 30th Celebration Knock Out Collection',
  'Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)',
  'Pokémon TCG: Mega Evolution-Pitch Black Booster Bundle (6 Packs)',
  'Pokémon TCG: Mega Evolution — Ascended Heroes Tin (Mega Feraligatr ex)',
  'Pokémon Trading Card Game: Mega Evolution Chaos Rising Elite Trainer Box',
  'Pokémon Trading Card Game: Mega Zygarde ex Premium Collection',
];

async function withCatalogue(): Promise<TestDb> {
  const db = await setup();
  await walmartSource(db);
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('tg', 'Target', 'Target', 'watcher', '', 'watcher', '{}'::jsonb, true, true)`,
  );
  await store.recordDiscoveries(
    db,
    USER,
    'tg',
    CURRENT.map((name, i) => ({
      externalId: `t${i}`,
      name,
      url: `https://target.test/p/${i}`,
      retailer: 'Target',
      state: 'out',
    })),
    false,
  );
  await db.query(`UPDATE discoveries SET status = 'kept' WHERE retailer = 'Target'`);
  return db;
}

test('THE ARCHIVE SINKS AND THE SHELF RISES', async () => {
  const db = await withCatalogue();
  await store.recordDiscoveries(db, USER, 'wm', [
    found('1', 'Pokemon Trading Cards: SAS12.5 Crown Zenith Elite Trainer Box'),
    found('2', 'Pokemon Trading Card Games Mega Evolution 5 Pitch Black Booster Bundle'),
    found('3', 'Pokemon Trading Card Games Scarlet & Violet 8 Surging Sparks Elite Trainer Box'),
    found('4', 'Pokemon 30th Celebration Knock Out Collection', { otherOffers: 6 }),
  ], false);

  const ranked = await store.rerankDiscoveries(db, USER);
  assert.equal(ranked.catalogue, CURRENT.length, 'the corpus is the first-party shops, not Walmart');

  const byName = new Map(
    (await store.discoveriesToReview(db, USER)).map((d) => [d.externalId, d]),
  );
  assert.equal(byName.get('2')?.era, 'current', 'Pitch Black is on sale at Pokémon Center now');
  assert.equal(byName.get('4')?.era, 'current');
  assert.equal(byName.get('3')?.era, 'old', 'Surging Sparks: the SERIES matches, the SET does not');
  // Crown Zenith is retired outright, so it should no longer be waiting at all.
  assert.equal(byName.has('1'), false, 'a Sword & Shield set is not waiting on a decision');

  // And the order the page will show them in: current and unheld, then current
  // with resellers camped on it. Nothing from the archive above either.
  const order = (await store.discoveriesToReview(db, USER))
    .filter((d) => d.retailer === 'Walmart')
    .map((d) => d.externalId);
  assert.deepEqual(order, ['2', '4', '3']);
});

test('RETIRING IS A NARROWER CLAIM THAN BEING OLD, AND ONLY IT MAY DECIDE', async () => {
  const db = await withCatalogue();
  await store.recordDiscoveries(db, USER, 'wm', [
    // Old by the catalogue, resellers on it — and exactly the kind of thing
    // Roberto asked for by name. The wider rule discarded sixteen of these.
    found('p', 'Pokemon Scarlet & Violet Prismatic Evolutions Elite Trainer Box', { otherOffers: 9 }),
    // Retired series. Nobody has printed one since 2023.
    found('r', 'Pokemon SAS6 Chilling Reign Elite Trainer Box', { otherOffers: 2 }),
  ], false);

  const out = await store.rerankDiscoveries(db, USER);
  assert.equal(out.retired, 1, 'exactly one of the two is safe to decide for him');

  const left = await store.discoveriesToReview(db, USER);
  const prismatic = left.find((d) => d.externalId === 'p');
  assert.ok(prismatic, 'Prismatic Evolutions must survive being called old');
  assert.equal(prismatic.era, 'old', 'it is still ranked down — the corpus cannot see it');
  assert.match(prismatic.eraWhy, /nothing on sale first-party/);
  assert.equal(left.some((d) => d.externalId === 'r'), false);
});

test('a decision already made is never revisited by the ranking pass', async () => {
  // Retiring touches rows still waiting, and nothing else. A find kept by hand
  // is a person's decision, and a rule arriving three weeks later does not get
  // to overturn it.
  const db = await withCatalogue();
  await store.recordDiscoveries(db, USER, 'wm', [
    found('k', 'Pokemon Trading Cards: SAS12.5 Crown Zenith Tin'),
  ], false);
  await db.query(`UPDATE discoveries SET status = 'kept' WHERE external_id = 'k'`);

  const out = await store.rerankDiscoveries(db, USER);
  assert.equal(out.retired, 0);
  const rows = await db.query<{ status: string; era: string }>(
    `SELECT status, era FROM discoveries WHERE external_id = 'k'`,
  );
  assert.equal(rows[0]?.status, 'kept', 'still kept');
  assert.equal(rows[0]?.era, 'old', 'and still ranked, because ranking is not deciding');
});

test('AN EMPTY CATALOGUE RETIRES NOTHING AND JUDGES NOTHING', async () => {
  // The failure mode this project has shipped before: a filter that quietly
  // rejects everything looks exactly like a filter that is working. With no
  // first-party catalogue to compare against, every find must come back
  // unknown — and the retired-series rule, which needs no catalogue, must
  // still work, because it is a fact about Pokémon and not about our data.
  const db = await setup();
  await walmartSource(db);
  await store.recordDiscoveries(db, USER, 'wm', [
    found('a', 'Pokemon Trading Card Games Mega Evolution 5 Pitch Black Booster Bundle'),
    found('b', 'Pokemon SAS6 Chilling Reign Elite Trainer Box'),
  ], false);

  const out = await store.rerankDiscoveries(db, USER);
  assert.equal(out.catalogue, 0);
  assert.equal(out.retired, 1, 'a retired series is retired whatever else we know');

  const left = await store.discoveriesToReview(db, USER);
  assert.equal(left.length, 1);
  assert.equal(left[0]?.era, 'unknown');
  assert.match(left[0]?.eraWhy ?? '', /not enough to judge/);
});

// ── Nothing here is permanent ───────────────────────────────────────────────
//
// Roberto, 8 Sep 2026: "i dont neccesarily think that what i have kept and
// what i have chosen forget on has full authority to decide what is right and
// what is wrong. i may have made mistakes as i was unsure in the beginning."
//
// The code had a worse version of the same problem than the tests did. The
// review list reads status = 'new' and nothing anywhere put a row back, so
// every decline — his and the machine's — was permanent AND invisible.

test('A DECLINE CAN BE UNDONE, AND THE CORPUS DOES NOT CONSULT ONE', async () => {
  const db = await withCatalogue();
  await store.recordDiscoveries(db, USER, 'wm', [
    found('a', 'Pokemon Trading Card Games Mega Evolution 5 Pitch Black Booster Bundle'),
  ], false);

  const before = (await store.discoveriesToReview(db, USER)).find((d) => d.externalId === 'a');
  assert.ok(before, 'waiting to begin with');

  const id = before.id;
  assert.equal(await store.forgetDiscovery(db, USER, id), true);
  assert.equal((await store.discoveriesToReview(db, USER)).some((d) => d.id === id), false);

  // It is not gone. It is on the other side of the list, and it says whose
  // call it was.
  const declined = await store.forgottenDiscoveries(db, USER);
  const row = declined.find((d) => d.id === id);
  assert.ok(row, 'a decline must be visible somewhere');
  assert.equal(row.decidedBy, 'you');

  assert.equal(await store.restoreDiscovery(db, USER, id), true);
  const back = (await store.discoveriesToReview(db, USER)).find((d) => d.id === id);
  assert.ok(back, 'and reversible');
  assert.equal(back.decidedBy, '', 'restored means undecided, not decided-and-undone');
  assert.equal(await store.restoreDiscovery(db, USER, id), false, 'twice is a no-op, not an error');
});

test('THE CURRENT CATALOGUE IS A FACT ABOUT THE SHOPS, NOT A RECORD OF OUR CLICKS', async () => {
  // This asked for status = 'kept', which quietly made a person's clicks part
  // of the definition of what Pokémon is printing — the exact thing Roberto
  // said should not have that authority. Target or Pokémon Center listing a
  // product is the fact; what anyone later decided about the row is not.
  const db = await withCatalogue();
  const full = await store.firstPartyCatalogue(db);
  assert.equal(full.length, CURRENT.length);

  // Decline every single one of them, and the catalogue must not move: the
  // shops still list them, which is the only thing being asked.
  await db.query(
    `UPDATE discoveries SET status = 'forgotten', decided_at = now(), decided_by = 'you'
      WHERE retailer = 'Target'`,
  );
  const after = await store.firstPartyCatalogue(db);
  assert.equal(after.length, full.length, 'a decline is an opinion; the listing is the fact');

  // And a product the shops stopped listing long ago stops voting on its own.
  await db.query(
    `UPDATE discoveries SET first_seen_at = now() - INTERVAL '400 days' WHERE retailer = 'Target'`,
  );
  assert.equal((await store.firstPartyCatalogue(db)).length, 0, 'the window is what expires it');
});

test("A RULE'S DECISIONS COME BACK AS THE BATCH THEY WERE MADE AS", async () => {
  // The retired-series rule is one claim about what Pokémon has stopped
  // printing. If it is wrong it is wrong about a whole batch at once, and
  // undoing it a row at a time is how a wrong rule stays in place.
  const db = await withCatalogue();
  await store.recordDiscoveries(db, USER, 'wm', [
    found('r1', 'Pokemon SAS6 Chilling Reign Elite Trainer Box'),
    found('r2', 'Pokemon XY Fates Collide Elite Trainer Box'),
    found('mine', 'Pokemon Trading Card Games Mega Heroes Tin Latias'),
  ], false);

  const mine = (await store.discoveriesToReview(db, USER)).find((d) => d.externalId === 'mine');
  await store.forgetDiscovery(db, USER, mine.id);

  const out = await store.rerankDiscoveries(db, USER);
  assert.equal(out.retired, 2);

  const declined = await store.forgottenDiscoveries(db, USER);
  assert.equal(declined.filter((d) => d.decidedBy === 'machine').length, 2);
  assert.equal(declined.filter((d) => d.decidedBy === 'you').length, 1);

  const restored = await store.restoreMachineDecisions(db, USER);
  assert.equal(restored, 2);

  // A person changing their mind is a person's job, one row at a time. That is
  // also the only way the decision stays theirs.
  const still = await store.forgottenDiscoveries(db, USER);
  assert.deepEqual(still.map((d) => d.externalId), ['mine']);
  assert.equal(still[0]?.decidedBy, 'you');
});
