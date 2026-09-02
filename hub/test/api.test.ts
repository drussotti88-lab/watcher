/**
 * The HTTP surface, called directly.
 *
 * The Worker version of this Hub had no tests at this level, because testing it
 * meant standing up a platform. Now the handler is `Request → Response` and
 * takes its database as an argument, so the whole API can be exercised in
 * process against a real Postgres. These are the tests that would have caught
 * a broken deploy before the deploy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Everything that existed before ownership did belongs to the first user. */
const USER = 1;

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import type { Env } from '../src/types.ts';

const TOKEN = 'test-token';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  // Empty webhooks: notify.ts must treat "not configured" as "don't post",
  // never as an error that takes the request down with it.
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
};

async function setup(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('pc', 'PC via Phantom', 'Pokemon Center', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, true)`,
  );
  return db;
}

const call = async (
  db: TestDb,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

test('HEALTH IS PUBLIC AND SAYS NOTHING ABOUT ANYBODY', async () => {
  // This test asserted that /health listed the sources, and that was fine when
  // there was one user. It is somebody else's data now, on an endpoint that
  // takes no credentials. A health check has to answer one question — does the
  // database answer — and nothing more.
  const db = await TestDb.create();
  const res = await createHandler(db, env)(new Request('https://hub.test/health'));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sources, undefined, 'no source labels, no retailers, no counts');
});

test('everything that changes state requires the token', async () => {
  const db = await setup();
  for (const [method, path] of [
    ['POST', '/sweep'],
    ['POST', '/ingest'],
    ['GET', '/watchlist'],
  ] as const) {
    const { status } = await call(db, method, path);
    assert.equal(status, 401, `${method} ${path} must not be open`);
  }
});

test('a wrong token is refused as firmly as no token', async () => {
  const db = await setup();
  const { status } = await call(db, 'GET', '/watchlist', { token: 'not-the-token' });
  assert.equal(status, 401);
});

test('ingest records, identifies, and refuses to announce a source twice', async () => {
  const db = await setup();
  const items = [
    {
      externalId: '100-10326',
      name: 'Pokemon TCG Journey Together Booster Pack',
      url: 'https://www.pokemoncenter.com/product/100-10326/x',
      price: 4.49,
    },
  ];

  const first = await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'pc', items } });
  assert.equal(first.status, 200);
  assert.equal(first.body.new, 1);
  assert.equal(first.body.announced, 1);

  const second = await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'pc', items } });
  assert.equal(second.body.new, 0, 'the dedupe ledger is the whole point');
  assert.equal(second.body.announced, 0);

  const [alias] = await db.query<{ product_key: string }>(
    'SELECT product_key FROM aliases WHERE value = $1',
    ['100-10326'],
  );
  assert.ok(alias, 'the discovery should have been given an identity');
});

test('ingest applies the source filters, so decoys never enter the ledger', async () => {
  const db = await setup();
  const { body } = await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'pc',
      items: [
        { externalId: 'a1', name: 'Pokemon Booster Bundle', url: 'https://x/a1' },
        { externalId: 'b2', name: 'Bath Towel', url: 'https://x/b2' },
      ],
    },
  });
  assert.equal(body.received, 1, 'the towel is filtered before it is recorded');

  const rows = await db.query('SELECT external_id FROM discoveries');
  assert.equal(rows.length, 1);
});

test('ingest rejects a body it cannot use rather than half-accepting it', async () => {
  const db = await setup();
  assert.equal((await call(db, 'POST', '/ingest', { token: TOKEN, body: {} })).status, 400);
  assert.equal(
    (await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'pc' } })).status,
    400,
  );
  assert.equal(
    (await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'nope', items: [] } }))
      .status,
    404,
  );
});

test('an item with no external id is dropped, not stored with an empty key', async () => {
  const db = await setup();
  const { body } = await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'pc',
      items: [
        { externalId: '', name: 'Pokemon Nameless', url: 'https://x/1' },
        { name: 'Pokemon No Id At All', url: 'https://x/2' },
      ],
    },
  });
  assert.equal(body.received, 0, 'an id-less row would collide with the next id-less row');
});

test('the watchlist gives Phantom listings, not just places to look', async () => {
  const db = await setup();
  await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'pc',
      items: [
        {
          externalId: '100-10326',
          name: 'Pokemon TCG Journey Together Booster Pack',
          url: 'https://www.pokemoncenter.com/product/100-10326/x',
        },
      ],
    },
  });

  // Ingest mints the product and its alias, but a *listing* is the thing a
  // mission hangs off, and discovery does not create one — you point a mission
  // at a URL yourself. So the watchlist is empty until that happens.
  const empty = await call(db, 'GET', '/watchlist', { token: TOKEN });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.products, [], 'a discovery is not yet something to watch');
  assert.ok(Array.isArray(empty.body.sources), 'but it still says where to hunt');

  await db.query(
    `INSERT INTO listings (product_key, retailer, external_id, url)
     SELECT product_key, 'Pokemon Center', '100-10326',
            'https://www.pokemoncenter.com/product/100-10326/x'
       FROM aliases WHERE value = '100-10326'`,
  );

  const { status, body } = await call(db, 'GET', '/watchlist', { token: TOKEN });
  assert.equal(status, 200);
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].retailer, 'Pokemon Center');
  assert.equal(body.products[0].externalId, '100-10326');
  assert.ok(body.products[0].listingId > 0, 'Phantom reports against a listing id');
  assert.match(body.products[0].url, /pokemoncenter\.com/, 'a watch with no URL cannot be polled');
});

test('an unknown path is a 404, not a 200 with an empty answer', async () => {
  const db = await setup();
  const { status } = await call(db, 'GET', '/nope', { token: TOKEN });
  assert.equal(status, 404);
});

test('a price survives the round trip as a number, not a Postgres string', async () => {
  // NUMERIC comes back from Postgres as a string to preserve precision. A
  // string price compares wrong against a ceiling, and `"73.76" > 50` is a
  // comparison that quietly does the wrong thing rather than throwing.
  const db = await setup();
  await db.query(
    `INSERT INTO discoveries (source_id, external_id, name, url, price, announced)
     VALUES ('pc', 'p1', 'Pokemon Thing', 'https://x/p1', 73.76, false)`,
  );

  const raw = await db.query<{ price: unknown }>('SELECT price FROM discoveries');
  assert.equal(typeof raw[0]!.price, 'string', 'this is what Postgres really hands back');

  const [row] = await store.pendingDiscoveries(db, USER, 'pc');
  assert.ok(row);
  assert.equal(typeof row.price, 'number', 'and this is what the rest of the Hub must see');
  assert.equal(row.price, 73.76);
});

test('a zero price is read as absent, never as free', async () => {
  const db = await setup();
  await db.query(
    `INSERT INTO discoveries (source_id, external_id, name, url, price, announced)
     VALUES ('pc', 'p0', 'Pokemon Thing', 'https://x/p0', 0, false)`,
  );
  const [row] = await store.pendingDiscoveries(db, USER, 'pc');
  assert.equal(row!.price, null, 'the same rule the readers use, for the same reason');
});

test('INGEST SAYS WHAT WAS NEW, BY NAME', async () => {
  // The caller cannot work this out for itself: "new" is a question about
  // everything ever seen, and Phantom is a process that restarts. Without
  // the names, a discovery run can report a count and nothing you can act on.
  const db = await setup();
  // A source that has never been swept. `pc` in setup() is already seeded, so
  // using it would test the second sweep twice and never the baseline.
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('tgt', 'Target TCG', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, false)`,
  );

  const first = await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'tgt',
      items: [{ externalId: '1', name: 'Pokemon 30th Celebration ETB', url: 'u1', price: 69.99 }],
    },
  });
  assert.equal(first.body.seeded, true, 'the first sweep is a baseline');
  assert.deepEqual(first.body.names, [], 'and announces nothing');

  const second = await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'tgt',
      items: [
        { externalId: '1', name: 'Pokemon 30th Celebration ETB', url: 'u1', price: 69.99 },
        { externalId: '2', name: 'Pokemon Mega Evolution Booster Bundle', url: 'u2', price: 26.99 },
      ],
    },
  });
  assert.equal(second.body.new, 1);
  assert.deepEqual(second.body.names, ['Pokemon Mega Evolution Booster Bundle']);
});

test('a run where nothing appeared names nothing, and says so with an empty list', async () => {
  const db = await setup();
  const items = [{ externalId: '1', name: 'Pokemon ETB', url: 'u1', price: 1 }];
  await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'pc', items } });
  const again = await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'pc', items } });
  assert.equal(again.body.new, 0);
  assert.deepEqual(again.body.names, []);
});

test('INGEST CAN SAY IT IS NOT THE END OF THE SWEEP', async () => {
  // Phantom reports one query at a time. Only the last one may finish the
  // sweep, or a restart part-way through loses the remaining queries and
  // nothing is due again until tomorrow.
  const db = await setup();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('tgt2', 'Target', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, true)`,
  );
  await store.requestSweep(db, USER, 'tgt2');

  const mid = await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'tgt2',
      items: [{ externalId: '1', name: 'Pokemon ETB', url: 'u', price: 1 }],
      final: false,
    },
  });
  assert.equal(mid.status, 200);
  assert.equal((await store.sweepState(db, USER, 'tgt2', 24)).queued, true, 'still sweeping');

  await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'tgt2',
      items: [{ externalId: '2', name: 'Pokemon Booster Box', url: 'u2', price: 2 }],
      final: true,
    },
  });
  assert.equal((await store.sweepState(db, USER, 'tgt2', 24)).queued, false, 'and now it is done');
});

test('A SIGHTING OF SOMETHING ALREADY KNOWN STILL UPDATES IT', async () => {
  // This used to be false, and it was the kind of false that looks like
  // nothing: `/ingest` recorded only what it had never seen, so a product
  // already in the ledger kept the price, stock state and street date it had
  // on the day it was first found — however long ago that was. The upsert's
  // whole update branch was unreachable, and the review card described last
  // week while looking perfectly current.
  const db = await setup();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('tgt', 'Target TCG', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, false)`,
  );

  const item = {
    externalId: '99',
    name: 'Pokemon 30th Celebration ETB',
    url: 'u',
    price: 69.99,
    retailer: 'Target',
    state: 'out',
    isPreOrder: false,
    releaseDate: '2026-09-16',
    signal: 'scheduled',
  };
  await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'tgt', items: [item] } });

  // The same product, later: it has come into stock and is no longer a
  // pre-order. Both facts have to survive the trip.
  await call(db, 'POST', '/ingest', {
    token: TOKEN,
    body: {
      sourceId: 'tgt',
      items: [{ ...item, price: 64.99, state: 'in', signal: 'buyable', releaseDate: '' }],
    },
  });

  const rows = await db.query<{
    price: string; state: string; signal: string; release_date: string; retailer: string;
  }>(`SELECT price, state, signal, release_date, retailer FROM discoveries
       WHERE source_id = 'tgt' AND external_id = '99'`);
  assert.equal(rows.length, 1, 'still one row — updated, not duplicated');
  assert.equal(Number(rows[0]!.price), 64.99, 'the price is the current one');
  assert.equal(rows[0]!.state, 'in');
  assert.equal(rows[0]!.signal, 'buyable');
  assert.equal(rows[0]!.retailer, 'Target', 'and the retailer is not lost on update');
});

test('seeing something again does not announce it a second time', async () => {
  // The other half of the same change. Recording everything must not turn into
  // alerting about everything, or the feed cries wolf on its second run.
  const db = await setup();
  await db.query(
    `INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled, seeded)
     VALUES ('tgt2', 'Target TCG', 'Target', 'watcher', '', 'watcher',
             '{"filters":["pokemon"]}'::jsonb, true, true)`,
  );
  const items = [{ externalId: '5', name: 'Pokemon ETB', url: 'u', price: 1 }];
  const first = await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'tgt2', items } });
  assert.deepEqual(first.body.names, ['Pokemon ETB'], 'announced once');
  const again = await call(db, 'POST', '/ingest', { token: TOKEN, body: { sourceId: 'tgt2', items } });
  assert.deepEqual(again.body.names, [], 'and not again');
  assert.equal(again.body.new, 0);
});

// ── The Discord test message ─────────────────────────────────────────────────

test('THE TEST ENDPOINT SAYS "NOT CONFIGURED" RATHER THAN PRETENDING', async () => {
  // The failure this whole feature exists to kill is an ambiguous silence:
  // nothing arriving in Discord can mean the URL is wrong, the channel is
  // wrong, the deploy has not picked up the variable, or that nothing has
  // happened yet. With no webhook set, the honest answer is neither an error
  // nor a success — it is "there is nowhere to send it".
  //
  // The harness env deliberately carries an empty DISCORD_WEBHOOK_URL, so this
  // is the real path a fresh Hub takes.
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/notify/test', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, false);
  assert.equal(res.body.configured, false);
});
