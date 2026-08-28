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
     VALUES ('pc', 'PC via watcher', 'Pokemon Center', 'watcher', '', 'watcher',
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

test('health is public and lists the sources', async () => {
  const db = await setup();
  const { status, body } = await call(db, 'GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sources[0].id, 'pc');
  assert.equal(body.sources[0].seeded, true, 'a real boolean, not 1');
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

test('the watchlist gives the Watcher products, not just places to look', async () => {
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

  const { status, body } = await call(db, 'GET', '/watchlist', { token: TOKEN });
  assert.equal(status, 200);
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].retailer, 'Pokemon Center');
  assert.equal(body.products[0].externalId, '100-10326');
  assert.match(body.products[0].url, /pokemoncenter\.com/, 'a watch with no URL cannot be polled');
  assert.ok(Array.isArray(body.sources), 'and still says where to hunt for new ones');
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

  const [row] = await store.pendingDiscoveries(db, 'pc');
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
  const [row] = await store.pendingDiscoveries(db, 'pc');
  assert.equal(row!.price, null, 'the same rule the readers use, for the same reason');
});
