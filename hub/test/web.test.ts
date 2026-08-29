/**
 * The web app: who gets in, and what the page is told.
 *
 * The tests that matter here are the ones about being shut out. This page will
 * eventually show what has been bought and be able to buy more, and the usual
 * way a personal dashboard ends up world-readable is an environment variable
 * that was never set — so "no password configured" must mean *closed*, not
 * open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Everything that existed before ownership did belongs to the first user. */
const USER = 1;

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import {
  mintSession,
  sessionValid,
  safeEqual,
  identify,
  hashToken,
  COOKIE_NAME,
} from '../src/auth.ts';
import type { Env } from '../src/types.ts';

const PASSWORD = 'a-long-enough-password';
const TOKEN = 'watcher-token';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
  APP_PASSWORD: PASSWORD,
};

interface Fixture {
  db: TestDb;
  etb: number;
  tin: number;
  etbMission: number;
  tinMission: number;
}

async function setup(): Promise<Fixture> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO products (key, name) VALUES
       ('prd_etb', 'Mega Evolution Elite Trainer Box'),
       ('prd_tin', 'Ascended Heroes Tin')`,
  );
  const listings = await db.query<{ id: number; product_key: string }>(
    `INSERT INTO listings (product_key, retailer, external_id, url) VALUES
       ('prd_etb', 'Walmart', '19988614228', 'https://www.walmart.com/ip/x/19988614228'),
       ('prd_tin', 'Target', '1012644666', 'https://www.target.com/p/-/A-1012644666')
     RETURNING id, product_key`,
  );
  const etb = Number(listings.find((l) => l.product_key === 'prd_etb')!.id);
  const tin = Number(listings.find((l) => l.product_key === 'prd_tin')!.id);
  const missions = await db.query<{ id: number; listing_id: number }>(
    `INSERT INTO missions (listing_id) VALUES ($1), ($2) RETURNING id, listing_id`,
    [etb, tin],
  );
  return {
    db,
    etb,
    tin,
    etbMission: Number(missions.find((m) => Number(m.listing_id) === etb)!.id),
    tinMission: Number(missions.find((m) => Number(m.listing_id) === tin)!.id),
  };
}

const call = async (
  db: TestDb,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown; form?: string; accept?: string } = {},
) => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  if (opts.accept) headers.accept = opts.accept;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.form !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers,
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : opts.form !== undefined
          ? { body: opts.form }
          : {}),
    }),
  );
  const text = await res.text();
  let body: any = text;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }
  }
  return { status: res.status, body, headers: res.headers, text };
};

// ── Getting in ───────────────────────────────────────────────────────────────

test('a signed-out browser is sent to the login page, not shown the data', async () => {
  const { db } = await setup();
  const res = await call(db, 'GET', '/', { accept: 'text/html' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
});

test('a signed-out API call gets 401, not a redirect it cannot follow', async () => {
  const { db } = await setup();
  const res = await call(db, 'GET', '/api/dashboard');
  assert.equal(res.status, 401);
});

test('the right password mints a session and the page then loads', async () => {
  const { db } = await setup();
  const login = await call(db, 'POST', '/login', {
    form: `password=${encodeURIComponent(PASSWORD)}`,
  });
  assert.equal(login.status, 303);

  const setCookie = login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/, 'script must never be able to read the session');
  assert.match(setCookie, /SameSite=Lax/, 'and another site must not be able to send it');
  assert.match(setCookie, /Secure/, 'over https it must not travel in the clear');

  const token = decodeURIComponent(/hub_session=([^;]+)/.exec(setCookie)![1]!);
  const page = await call(db, 'GET', '/', { cookie: token, accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.text, /Watching/);
});

test('the wrong password gets in nowhere', async () => {
  const { db } = await setup();
  const res = await call(db, 'POST', '/login', { form: 'password=hunter2' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null, 'a failed login must not set a cookie');
});

test('NO PASSWORD SET MEANS CLOSED, never open', async () => {
  // The failure this exists to prevent: deploying without APP_PASSWORD and
  // publishing a dashboard of your own spending to the open internet.
  const { db } = await setup();
  const openEnv: Env = { ...env, APP_PASSWORD: undefined };
  const res = await createHandler(db, openEnv)(
    new Request('https://hub.test/api/dashboard', { headers: { accept: 'application/json' } }),
  );
  assert.equal(res.status, 401);
});

test('no ingest token set means the Watcher cannot get in either', async () => {
  const { db } = await setup();
  const closed: Env = { ...env, INGEST_TOKEN: undefined };
  const res = await createHandler(db, closed)(
    new Request('https://hub.test/observations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' },
      body: '{}',
    }),
  );
  assert.equal(res.status, 401);
});

test('a forged session cookie is refused', async () => {
  const { db } = await setup();
  const forged = `${Date.now() + 999999}.notarealsignature`;
  const res = await call(db, 'GET', '/api/dashboard', { cookie: forged });
  assert.equal(res.status, 401, 'the signature is the whole point of signing it');
});

test('an expired session is refused even though it is correctly signed', async () => {
  const expired = await mintSession(PASSWORD, Date.now() - 40 * 24 * 3600 * 1000);
  assert.equal(await sessionValid(PASSWORD, expired), false);
  assert.equal(await sessionValid(PASSWORD, await mintSession(PASSWORD)), true);
});

test('a session signed with a different password is refused', async () => {
  // Changing APP_PASSWORD therefore signs everyone out, which is the behaviour
  // you want from changing a password.
  const token = await mintSession('the-old-password');
  assert.equal(await sessionValid(PASSWORD, token), false);
});

test('signing out clears the cookie', async () => {
  const { db } = await setup();
  const res = await call(db, 'GET', '/logout');
  assert.match(res.headers.get('set-cookie') ?? '', /hub_session=;.*Max-Age=0/);
});

test('the comparison does not leak by returning early', async () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('health stays public — it is how you check a deploy worked', async () => {
  const { db } = await setup();
  const res = await call(db, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// ── What the page is told ────────────────────────────────────────────────────

test('a watch that has never been checked still appears, marked unchecked', async () => {
  // A dashboard that silently omits what it cannot see is how you discover in a
  // week that one retailer stopped working.
  const { db } = await setup();
  const res = await call(db, 'GET', '/api/dashboard', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.body.missions.length, 2);
  assert.ok(res.body.missions.every((w: any) => w.state === 'unchecked'));
});

test('the Watcher posts a reading and the page shows it', async () => {
  const { db, etb } = await setup();
  const post = await call(db, 'POST', '/observations', {
    token: TOKEN,
    body: {
      observations: [
        {
          listingId: etb,
          state: 'in',
          confidence: 'exact',
          price: 73.76,
          sellerKind: 'marketplace',
          sellerName: 'Rares Market L.L.C.',
          orderLimit: 12,
        },
      ],
    },
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.recorded, 1);

  const { body } = await call(db, 'GET', '/api/dashboard', { token: TOKEN });
  const watch = body.missions.find((w: any) => w.productKey === 'prd_etb');
  assert.equal(watch.state, 'in');
  assert.equal(watch.price, 73.76, 'a number, not the string Postgres returns');
  assert.equal(watch.sellerKind, 'marketplace', 'the scalper flag has to survive the round trip');
  assert.equal(watch.sellerName, 'Rares Market L.L.C.');
  assert.equal(watch.orderLimit, 12);
});

test('in-stock sorts above out-of-stock, because that is what you look for', async () => {
  const { db, etb, tin } = await setup();
  await call(db, 'POST', '/observations', {
    token: TOKEN,
    body: {
      observations: [
        { listingId: tin, state: 'out', price: 24.99 },
        { listingId: etb, state: 'in', price: 73.76 },
      ],
    },
  });
  const { body } = await call(db, 'GET', '/api/dashboard', { token: TOKEN });
  assert.equal(body.missions[0].state, 'in');
});

test('one bad reading does not throw away the good ones in the same batch', async () => {
  const { db, etb, tin } = await setup();
  const { body } = await call(db, 'POST', '/observations', {
    token: TOKEN,
    body: {
      observations: [
        { listingId: tin, state: 'out', price: 24.99 },
        { state: 'out' }, // no listingId
        { listingId: 999999, state: 'in' }, // no such listing
        { listingId: etb, state: 'in', price: 73.76 },
      ],
    },
  });
  assert.equal(body.recorded, 4);
  assert.equal(body.failed, 2);

  const dash = await call(db, 'GET', '/api/dashboard', { token: TOKEN });
  assert.equal(
    dash.body.missions.filter((w: any) => w.state !== 'unchecked').length,
    2,
    'both readable products still landed',
  );
});

// ── Write discipline ─────────────────────────────────────────────────────────

test('polling an unchanged product writes no history at all', async () => {
  // Every minute for a week is ten thousand checks. A product that never moves
  // should leave a history of nothing, or the history is unreadable.
  const { db, tin } = await setup();
  const reading = {
    observations: [{ listingId: tin, state: 'out', price: 24.99 }],
  };

  await call(db, 'POST', '/observations', { token: TOKEN, body: reading });
  for (let i = 0; i < 20; i += 1) {
    await call(db, 'POST', '/observations', { token: TOKEN, body: reading });
  }

  const rows = await db.query('SELECT count(*)::int AS n FROM observations');
  assert.equal(rows[0]!.n, 1, 'only the first sighting, then silence');
});

test('but the page always knows how stale it is', async () => {
  const { db, tin } = await setup();
  const reading = {
    observations: [{ listingId: tin, state: 'out', price: 24.99 }],
  };
  await call(db, 'POST', '/observations', { token: TOKEN, body: reading });
  const [first] = await db.query<{ last_checked_at: string }>(
    'SELECT last_checked_at FROM watch_state',
  );

  await new Promise((r) => setTimeout(r, 30));
  await call(db, 'POST', '/observations', { token: TOKEN, body: reading });
  const [second] = await db.query<{ last_checked_at: string }>(
    'SELECT last_checked_at FROM watch_state',
  );

  assert.ok(
    new Date(second!.last_checked_at) > new Date(first!.last_checked_at),
    'checked-at moves on every poll even when nothing changed',
  );
});

test('coming into stock is a change; being checked again is not', async () => {
  const { db, tin } = await setup();
  const post = (state: string, price: number) =>
    call(db, 'POST', '/observations', {
      token: TOKEN,
      body: { observations: [{ listingId: tin, state, price }] },
    });

  const first = await post('out', 24.99);
  assert.equal(first.body.changed, 0, 'the very first sighting is not a change to shout about');

  assert.equal((await post('out', 24.99)).body.changed, 0);
  assert.equal((await post('in', 24.99)).body.changed, 1, 'out → in is the whole point');
  assert.equal((await post('in', 24.99)).body.changed, 0, 'still in stock is not news');
  assert.equal((await post('in', 19.99)).body.changed, 1, 'a price move is news');
});

test('"in stock since" does not reset every time we look', async () => {
  const { db, tin } = await setup();
  const post = () =>
    call(db, 'POST', '/observations', {
      token: TOKEN,
      body: { observations: [{ listingId: tin, state: 'in', price: 24.99 }] },
    });

  await post();
  const [a] = await db.query<{ last_changed_at: string }>('SELECT last_changed_at FROM watch_state');
  await new Promise((r) => setTimeout(r, 30));
  await post();
  const [b] = await db.query<{ last_changed_at: string }>('SELECT last_changed_at FROM watch_state');

  assert.equal(
    new Date(a!.last_changed_at).getTime(),
    new Date(b!.last_changed_at).getTime(),
    'it changed once, so it changed once',
  );
});

test('a zero price is stored as absent, never as free', async () => {
  const { db, tin } = await setup();
  await call(db, 'POST', '/observations', {
    token: TOKEN,
    body: { observations: [{ listingId: tin, state: 'in', price: 0 }] },
  });
  const [w] = await store.listMissions(db, USER);
  assert.equal(w!.price, null);
});

// ── Who a request is ─────────────────────────────────────────────────────────

test('NOBODY IS USER ZERO, WHICH OWNS NOTHING', async () => {
  // The direction to fail in: a bug that forgets to check `kind` filters
  // everything out rather than letting everything through.
  const caller = await identify(new Request('https://hub.test/'), {
    INGEST_TOKEN: 'tok',
    APP_PASSWORD: 'pw',
  });
  assert.equal(caller.kind, 'none');
  assert.equal(caller.userId, 0);
});

test('a per-user Watcher token is matched by its hash, not its text', async () => {
  const seen: string[] = [];
  const caller = await identify(
    new Request('https://hub.test/', { headers: { Authorization: 'Bearer secret-token' } }),
    { INGEST_TOKEN: 'something-else' },
    async (hash) => {
      seen.push(hash);
      return hash === (await hashToken('secret-token')) ? 7 : 0;
    },
  );

  assert.equal(caller.kind, 'watcher');
  assert.equal(caller.userId, 7);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], 'secret-token', 'the lookup never sees the token itself');
  assert.match(seen[0]!, /^[0-9a-f]{64}$/, 'it sees a SHA-256');
});

test('the shared environment token still answers, as the first user', async () => {
  // The Watcher already running on a desk must not stop working the moment
  // ownership ships.
  const caller = await identify(
    new Request('https://hub.test/', { headers: { Authorization: 'Bearer env-token' } }),
    { INGEST_TOKEN: 'env-token' },
  );
  assert.equal(caller.kind, 'watcher');
  assert.equal(caller.userId, 1);
});

test('a token that matches nobody is nobody', async () => {
  const caller = await identify(
    new Request('https://hub.test/', { headers: { Authorization: 'Bearer wrong' } }),
    { INGEST_TOKEN: 'env-token' },
    async () => 0,
  );
  assert.equal(caller.kind, 'none');
  assert.equal(caller.userId, 0);
});

test('the same token always hashes the same way, and different ones do not collide', async () => {
  assert.equal(await hashToken('abc'), await hashToken('abc'));
  assert.notEqual(await hashToken('abc'), await hashToken('abd'));
  assert.match(await hashToken('abc'), /^[0-9a-f]{64}$/);
});
