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
  readSession,
  hashPassword,
  verifyPassword,
  signIn,
  type PasswordLookup,
  safeEqual,
  identify,
  hashToken,
  COOKIE_NAME,
  mintInvite,
  readInvite,
} from '../src/auth.ts';
import type { Env } from '../src/types.ts';

const PASSWORD = 'a-long-enough-password';
const TOKEN = 'Phantom-token';

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

test('no ingest token set means Phantom cannot get in either', async () => {
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
  const expired = await mintSession(PASSWORD, 1, Date.now() - 40 * 24 * 3600 * 1000);
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

test('Phantom posts a reading and the page shows it', async () => {
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

test('a per-user Phantom token is matched by its hash, not its text', async () => {
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
  // Phantom already running on a desk must not stop working the moment
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

// ── Accounts ─────────────────────────────────────────────────────────────────
//
/** The old cookie signature, rebuilt here rather than exported from auth.ts. */
async function hmacFor(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Buffer.from(new Uint8Array(sig)).toString('base64url');
}

//
// The browser door used to hand out userId 1 to anyone who knew the one
// password, while every query underneath filtered by user_id and every Phantom
// carried its own token. These are the tests for closing that.

test('a session says who it belongs to, and the signature is what makes that true', async () => {
  const mine = await mintSession(PASSWORD, 7);
  assert.equal(await readSession(PASSWORD, mine), 7);

  // The user id is inside the signed payload, so editing it invalidates it
  // rather than switching account.
  const tampered = mine.replace(/^7:/, '1:');
  assert.equal(await readSession(PASSWORD, tampered), 0, 'a rewritten id must not be honoured');
});

test('a cookie minted before accounts existed still signs its owner in', async () => {
  // The old payload was a bare expiry. Deploying accounts must not sign
  // Roberto out of a dashboard whose Phantom is mid-pass.
  const expires = Date.now() + 3600_000;
  const legacy = `${expires}.${await hmacFor(PASSWORD, String(expires))}`;
  assert.equal(await readSession(PASSWORD, legacy), 1);
});

test('a password verifies against its own hash and nothing else', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.ok(await verifyPassword('correct horse battery staple', stored));
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('two identical passwords do not produce the same hash', async () => {
  // Per-user salt. Without it, one leaked table tells you which accounts share
  // a password, and one cracked hash opens all of them.
  const a = await hashPassword('the same password');
  const b = await hashPassword('the same password');
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('the same password', a));
  assert.ok(await verifyPassword('the same password', b));
});

test('an empty stored hash means cannot sign in, never signs in with anything', async () => {
  // A user row that owns a Phantom token but has no browser login stores
  // exactly this, so getting it wrong would open every such account.
  assert.equal(await verifyPassword('', ''), false);
  assert.equal(await verifyPassword('anything at all', ''), false);
  assert.equal(await verifyPassword('anything at all', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$sha256$210000$$'), false);
});

test('a hash asking for absurd work is refused rather than performed', async () => {
  // Otherwise anyone who could write the column could turn every login attempt
  // into a hung request.
  const real = await hashPassword('a real password here');
  const greedy = real.replace('$210000$', '$999999999$');
  assert.equal(await verifyPassword('a real password here', greedy), false);
});

test('a blank name with the deployment password is still the owner', async () => {
  const never: PasswordLookup = async () => null;
  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, '', PASSWORD, never), 1);
  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, '', 'wrong', never), 0);
  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, '', '', never), 0);
  assert.equal(await signIn({}, '', PASSWORD, never), 0, 'no password set means no door');
});

test('a named account signs in as itself, not as user 1', async () => {
  const stored = await hashPassword('the testers password');
  const lookup: PasswordLookup = async (handle) =>
    handle === 'tester' ? { id: 4, passwordHash: stored } : null;

  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, 'tester', 'the testers password', lookup), 4);
  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, 'tester', 'wrong', lookup), 0);
  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, 'nobody', 'the testers password', lookup), 0);
});

test('the owner password does not open a named account', async () => {
  // The two doors must not be one door. Otherwise every account Roberto
  // creates is one he can also walk into by typing his own password, which is
  // the bug this whole change exists to remove.
  const stored = await hashPassword('the testers password');
  const lookup: PasswordLookup = async () => ({ id: 4, passwordHash: stored });
  assert.equal(await signIn({ APP_PASSWORD: PASSWORD }, 'tester', PASSWORD, lookup), 0);
});

test('an unknown name costs about as much time as a known one', async () => {
  // A fast "no such user" and a slow "wrong password" is an account
  // enumeration oracle. Generous bounds — this asserts the decoy hash is being
  // computed at all, not a precise timing property a shared CI box cannot give.
  const stored = await hashPassword('the testers password');
  const lookup: PasswordLookup = async (h) => (h === 'real' ? { id: 4, passwordHash: stored } : null);

  const t0 = Date.now();
  await signIn({}, 'real', 'wrong', lookup);
  const known = Date.now() - t0;

  const t1 = Date.now();
  await signIn({}, 'ghost', 'wrong', lookup);
  const unknown = Date.now() - t1;

  assert.ok(unknown > known / 4, `unknown ${unknown}ms vs known ${known}ms — no decoy work done`);
});

test('a second person signed in sees their own dashboard, not the first person’s', async () => {
  // This is the test for the bug the whole change exists to fix. The browser
  // door used to return userId 1 whoever walked through it, so a tester handed
  // the link did not get an empty dashboard — they got Roberto's, with the
  // delete buttons live.
  const { db } = await setup();
  await db.query(
    `INSERT INTO users (id, handle, password_hash) VALUES (2, 'tester', $1)`,
    [await hashPassword('a password for the tester')],
  );

  const mine = await call(db, 'GET', '/api/dashboard', { cookie: await mintSession(PASSWORD, 1) });
  const theirs = await call(db, 'GET', '/api/dashboard', { cookie: await mintSession(PASSWORD, 2) });

  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);
  assert.ok(mine.body.missions.length > 0, 'the owner still sees his own two missions');
  assert.deepEqual(theirs.body.missions, [], 'and the tester sees none of them');
});

test('a second person cannot delete the first person’s mission', async () => {
  // Reading someone else's data is the embarrassing failure. Writing to it is
  // the expensive one: these routes move ceilings and switch Phantoms off.
  const { db, etbMission } = await setup();
  await db.query(`INSERT INTO users (id, handle, password_hash) VALUES (2, 'tester', '')`);

  const res = await call(db, 'DELETE', `/api/missions/${etbMission}`, {
    cookie: await mintSession(PASSWORD, 2),
  });
  assert.ok(res.status === 404 || res.status === 403, `expected a refusal, got ${res.status}`);

  const still = await store.getMission(db, USER, etbMission);
  assert.ok(still, 'the mission is still there');
});

test('the login form signs in a named account and hands back a cookie for that account', async () => {
  const { db } = await setup();
  await db.query(
    `INSERT INTO users (id, handle, password_hash) VALUES (2, 'tester', $1)`,
    [await hashPassword('a password for the tester')],
  );

  const res = await call(db, 'POST', '/login', {
    form: 'handle=tester&password=a+password+for+the+tester',
  });
  assert.equal(res.status, 303);

  const cookie = /hub_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  assert.equal(await readSession(PASSWORD, decodeURIComponent(cookie)), 2);
});

test('a disabled account cannot sign in even with the right password', async () => {
  const { db } = await setup();
  await db.query(
    `INSERT INTO users (id, handle, password_hash, enabled) VALUES (2, 'tester', $1, false)`,
    [await hashPassword('a password for the tester')],
  );
  const res = await call(db, 'POST', '/login', {
    form: 'handle=tester&password=a+password+for+the+tester',
  });
  assert.equal(res.status, 401);
});

// ── Invites ──────────────────────────────────────────────────────────────────
//
// A link that signs one person in once so they can choose their own password.
// Nothing stored: the MAC covers the account's current password hash, so the
// link dies the moment a password is set.

const SECRET = 'session-secret-for-tests';

test('AN INVITE ROUND-TRIPS, AND DIES WHEN THE PASSWORD CHANGES', async () => {
  const hash1 = await hashPassword('throwaway-first-password');
  const token = await mintInvite(SECRET, 7, hash1);
  assert.equal(await readInvite(SECRET, token, async () => hash1), 7, 'the link works');

  // They set a password. The hash changes. The same link is now nobody's.
  const hash2 = await hashPassword('the-one-they-chose');
  assert.equal(await readInvite(SECRET, token, async () => hash2), 0, 'used once, dead after');
});

test('an invite refuses the wrong secret, the future, a stranger and nonsense', async () => {
  const hash = await hashPassword('x');
  const token = await mintInvite(SECRET, 7, hash);
  assert.equal(await readInvite('another-secret', token, async () => hash), 0);
  const eightDays = Date.now() + 8 * 24 * 3600 * 1000;
  assert.equal(await readInvite(SECRET, token, async () => hash, eightDays), 0, 'seven days, then gone');
  assert.equal(await readInvite(SECRET, token, async () => null), 0, 'no such enabled account');
  assert.equal(await readInvite(SECRET, 'not.a.token', async () => hash), 0);
  assert.equal(await readInvite(SECRET, '', async () => hash), 0);
});

test('THE INVITE LINK SIGNS YOU IN, AND SETTING A PASSWORD ENDS IT', async () => {
  const { db } = await setup();
  const userId = await store.upsertUser(db, 'newtester', await hashPassword('temporary'));
  const hash = (await store.passwordHashById(db, userId))!;
  const token = await mintInvite(PASSWORD, userId, hash);

  // Tap the link: the page posts the token and gets a session.
  const res = await call(db, 'POST', '/api/invite', { body: { token } });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  const session = decodeURIComponent(/hub_session=([^;]+)/.exec(setCookie)![1]!);
  const me = await call(db, 'GET', '/api/dashboard', { cookie: session });
  assert.equal(me.status, 200);
  assert.equal(me.body.you, 'newtester');

  // Choose a password. Too short is refused; a real one is stored.
  const short = await call(db, 'POST', '/api/me/password', { cookie: session, body: { password: 'short' } });
  assert.equal(short.status, 400);
  const ok = await call(db, 'POST', '/api/me/password', { cookie: session, body: { password: 'a-real-password-now' } });
  assert.equal(ok.status, 200);

  // The link is now dead, and the chosen password works at the door.
  const again = await call(db, 'POST', '/api/invite', { body: { token } });
  assert.equal(again.status, 401, 'used once');
  const login = await call(db, 'POST', '/login', {
    form: `handle=newtester&password=${encodeURIComponent('a-real-password-now')}`,
  });
  assert.equal(login.status, 303);
});

test('THE FRONT DOOR HANDS OVER PHANTOM AND A TOKEN, TO AN ACCOUNT THAT MAY BUY', async () => {
  // The invite link is the whole handover only if the zip and the token
  // come from the app. Both do, to a signed-in browser, only when the
  // account may arm — and the token it mints is a real one: the very next
  // request presenting it is that person's Phantom.
  const { db } = await setup();
  const userId = await store.upsertUser(db, 'machinetester', await hashPassword('temporary'));
  const hash = (await store.passwordHashById(db, userId))!;
  const invite = await mintInvite(PASSWORD, userId, hash);
  const door = await call(db, 'POST', '/api/invite', { body: { token: invite } });
  const session = decodeURIComponent(/hub_session=([^;]+)/.exec(door.headers.get('set-cookie') ?? '')![1]!);

  // A member: no Phantom of their own, so no zip and no token.
  assert.equal((await call(db, 'GET', '/api/phantom.zip', { cookie: session })).status, 403);
  assert.equal((await call(db, 'POST', '/api/me/watcher-token', { cookie: session })).status, 403);

  // Granted at the terminal.
  await store.setUserCanArm(db, 'machinetester', true);

  const zip = await createHandler(db, env)(
    new Request('https://hub.test/api/phantom.zip', { headers: { cookie: `${COOKIE_NAME}=${session}` } }),
  );
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition') ?? '', /attachment; filename="Phantom-[0-9a-f]{7}\.zip"/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'a real zip');
  assert.ok(bytes.length > 100_000);
  const dash = await call(db, 'GET', '/api/dashboard', { cookie: session });
  assert.equal(dash.body.phantomZip.bytes, bytes.length, 'the page knows what it is offering');

  const minted = await call(db, 'POST', '/api/me/watcher-token', { cookie: session });
  assert.equal(minted.status, 200);
  assert.match(minted.body.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(minted.body.hubUrl, 'https://hub.test');
  assert.equal(minted.headers.get('cache-control'), 'private, no-store');

  // That token IS their Phantom now: it reads their feed, and only theirs.
  const feed = await call(db, 'GET', '/api/missions/active', { token: minted.body.token });
  assert.equal(feed.status, 200);
  assert.equal(feed.body.missions.length, 0, 'their own missions, of which there are none yet');

  // Minting again retires the first. Same rule as the CLI.
  const second = await call(db, 'POST', '/api/me/watcher-token', { cookie: session });
  assert.equal((await call(db, 'GET', '/api/missions/active', { token: minted.body.token })).status, 401);
  assert.equal((await call(db, 'GET', '/api/missions/active', { token: second.body.token })).status, 200);

  // A Phantom token cannot mint a token or fetch the program.
  assert.equal((await call(db, 'POST', '/api/me/watcher-token', { token: second.body.token })).status, 403);
  assert.equal((await call(db, 'GET', '/api/phantom.zip', { token: second.body.token })).status, 403);
  // Nobody at all gets 401, not a redirect.
  assert.equal((await call(db, 'GET', '/api/phantom.zip')).status, 401);
});

test('A TESTER’S PHANTOM CAN FILE A REPORT, AND THE OWNER CAN READ IT', async () => {
  // The one thing a Phantom too broken to watch anything must still manage.
  // It is the MACHINE speaking about itself, so an agent token is the right
  // credential here — the opposite of the zip and the token endpoints.
  const { db } = await setup();
  const report = {
    at: '2026-09-03T22:00:00.000Z',
    version: '1fd5043',
    note: 'chrome never opens',
    summary: 'Phantom 1fd5043 on win32 x64, Node v22.9.0 It is NOT running (no lock file).',
    platform: 'win32 x64',
    node: 'v22.9.0',
    running: false,
    shape: 'the app address is set, and the value it signs in with is 43 characters long',
    config: '{ "hub": { "url": "https://hub.example", "token": "[redacted]" } }',
    console: 'a few hundred lines of console',
    files: ['console-run.log  12kb  2026-09-03T22:00:00.000Z'],
    captures: ['walmart_2026-09-03_22-25-13  dir  2026-09-03T22:25:13.000Z'],
  };

  const filed = await call(db, 'POST', '/api/reports', { token: TOKEN, body: { report } });
  assert.equal(filed.status, 200);
  assert.ok(filed.body.id > 0);

  // Nonsense is refused rather than filed as an empty row.
  assert.equal((await call(db, 'POST', '/api/reports', { token: TOKEN, body: {} })).status, 400);
  // And a stranger cannot file one at all.
  assert.equal((await call(db, 'POST', '/api/reports', { body: { report } })).status, 401);

  const rows = await store.listReports(db, 20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, filed.body.id);
  assert.equal(rows[0]!.version, '1fd5043');
  assert.equal(rows[0]!.note, 'chrome never opens');
  assert.match(rows[0]!.summary, /NOT running/);
  assert.equal(rows[0]!.handle, 'owner', 'whose machine it was');
  // The body is kept whole, because the owner reads it and its shape belongs
  // to the Watcher.
  assert.equal((rows[0]!.body as { console?: string }).console, 'a few hundred lines of console');
  assert.deepEqual((rows[0]!.body as { captures?: string[] }).captures, report.captures);

  const one = await store.getReport(db, filed.body.id);
  assert.equal(one?.id, filed.body.id);
  assert.equal(await store.getReport(db, 99999), null);
});

test('the Hub says which Phantom it is handing out', async () => {
  // A running Phantom asks this every six hours and compares to its own
  // VERSION. Answered to any authenticated caller: knowing the version of a
  // program you were given is not a privilege.
  const { db } = await setup();
  const res = await call(db, 'GET', '/api/phantom/version', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.match(res.body.version, /^[0-9a-f]{7}$/);
  assert.equal(res.body.url, '/api/phantom.zip');
  assert.equal((await call(db, 'GET', '/api/phantom/version')).status, 401);
});

test('a Phantom token cannot set the password of the account it belongs to', async () => {
  const { db } = await setup();
  const res = await call(db, 'POST', '/api/me/password', { token: TOKEN, body: { password: 'a-real-password-now' } });
  assert.equal(res.status, 403);
});
