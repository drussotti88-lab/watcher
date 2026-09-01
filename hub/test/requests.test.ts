/**
 * How a member gets something into a catalogue they cannot write to.
 *
 * The shared catalogue put curation behind a role, which is right — one bad
 * MSRP now misleads everybody. But the people out looking at retailer pages
 * are the members, and a system whose only answer to "you're missing this" is
 * a permissions error will be told nothing at all.
 *
 * So a link is a REQUEST: it goes in a queue with a name on it, and the person
 * who sent it can see what happened to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import { hashToken } from '../src/auth.ts';
import type { Env } from '../src/types.ts';

const OWNER = 1;
const MEMBER = 2;

const OWNER_TOKEN = 'owner-token';
const MEMBER_TOKEN = 'member-token';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: OWNER_TOKEN,
  APP_PASSWORD: 'pw',
};

const TARGET_URL = 'https://www.target.com/p/pokemon-tin/-/A-1012644666';
const OTHER_URL = 'https://www.walmart.com/ip/pokemon-etb/5015988981';

const call = async (
  db: TestDb,
  who: string,
  method: string,
  path: string,
  body?: unknown,
) => {
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: parsed };
};

/** An owner who curates, and a member who cannot. */
async function twoUsers(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.query(
    `INSERT INTO users (id, handle) VALUES (2, 'member') ON CONFLICT (id) DO NOTHING`,
  );
  await db.query('UPDATE users SET token_hash = $1 WHERE id = 2', [
    await hashToken(MEMBER_TOKEN),
  ]);
  return db;
}

test('A MEMBER SENDING A LINK GETS A REQUEST, NOT A PERMISSIONS ERROR', async () => {
  // The same button the owner presses. The outcome differs and is said plainly
  // — what must not happen is a red error for doing the thing we want them to
  // do.
  const db = await twoUsers();
  const { status, body } = await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', {
    url: TARGET_URL,
  });

  assert.equal(status, 202, 'accepted, not created and not refused');
  assert.equal(body.requested, true);
  assert.equal(body.request.url.includes('1012644666'), true);
  assert.match(body.message, /catalogue/);
  assert.equal((await store.listProducts(db, OWNER)).length, 0, 'and nothing was catalogued');
});

test('a link already in the catalogue needs no request at all', async () => {
  // The shelf is shared. If the owner already catalogued it, the member just
  // gets a mission on it — asking permission for something already public
  // would be theatre, and slow theatre at that.
  const db = await twoUsers();
  await call(db, OWNER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });

  const { status, body } = await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', {
    url: TARGET_URL,
  });
  assert.equal(status, 200);
  assert.equal(body.alreadyTracked, true);
  assert.ok(body.mission.id);
  assert.equal((await store.listMissions(db, MEMBER)).length, 1);
  assert.equal((await store.listProductRequests(db, MEMBER)).length, 0, 'no queue entry');
});

test('THE OWNER SEES THE QUEUE; A MEMBER SEES ONLY THEIR OWN', async () => {
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });

  const owner = await call(db, OWNER_TOKEN, 'GET', '/api/requests');
  assert.equal(owner.body.requests.length, 1);
  assert.equal(owner.body.requests[0].handle, 'member', 'who asked is part of the ask');

  const member = await call(db, MEMBER_TOKEN, 'GET', '/api/requests');
  assert.equal(member.body.requests.length, 1, 'their own, so they can see it was received');
});

test('sending the same link twice is one request, not a queue of duplicates', async () => {
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/requests', { url: TARGET_URL, note: 'restock?' });
  await call(db, MEMBER_TOKEN, 'POST', '/api/requests', { url: TARGET_URL, note: 'restock?' });

  const { body } = await call(db, OWNER_TOKEN, 'GET', '/api/requests');
  assert.equal(body.requests.length, 1);
  assert.equal(body.requests[0].note, 'restock?');
});

test('APPROVING GIVES THE MISSION TO WHOEVER ASKED', async () => {
  // The obvious bug: approve builds the listing under the owner's session, so
  // the mission lands on the OWNER'S watchlist and the member who found it
  // still cannot see the thing they asked for.
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });
  const queued = (await call(db, OWNER_TOKEN, 'GET', '/api/requests')).body.requests[0];

  const { status, body } = await call(
    db,
    OWNER_TOKEN,
    'POST',
    `/api/requests/${queued.id}/approve`,
    { name: 'Pitch Black Elite Trainer Box', msrp: 49.99 },
  );

  assert.equal(status, 200);
  assert.equal(body.request.status, 'approved');
  assert.equal(body.request.listingId, body.listing.id, 'stamped with what it became');

  const theirs = await store.listMissions(db, MEMBER);
  assert.equal(theirs.length, 1, 'the person who asked is now watching it');
  assert.equal(theirs[0]!.listingId, body.listing.id);
  assert.equal(theirs[0]!.armed, false, 'watching, never arming');
  assert.equal(await store.listMissions(db, OWNER).then((m) => m.length), 0);
});

test('an approved product is the shared catalogue, with the typed name winning', async () => {
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });
  const queued = (await call(db, OWNER_TOKEN, 'GET', '/api/requests')).body.requests[0];
  await call(db, OWNER_TOKEN, 'POST', `/api/requests/${queued.id}/approve`, {
    name: 'Pitch Black Elite Trainer Box',
  });

  const products = await store.listProducts(db, MEMBER);
  assert.equal(products.length, 1, 'everybody reads the same row');
  assert.equal(products[0]!.name, 'Pitch Black Elite Trainer Box');
  assert.notEqual(products[0]!.nameIsGuess, true, 'a typed name is not a guess');
});

test('A MEMBER CANNOT APPROVE THEIR OWN REQUEST', async () => {
  // The whole point of the queue. Without this it is a slower way to write to
  // the catalogue, not a gate on it.
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });
  const mine = (await call(db, MEMBER_TOKEN, 'GET', '/api/requests')).body.requests[0];

  const { status } = await call(db, MEMBER_TOKEN, 'POST', `/api/requests/${mine.id}/approve`, {});
  assert.equal(status, 403, 'refused, and not with a 500');
  assert.equal((await store.listProducts(db, OWNER)).length, 0, 'nothing got written');
});

test('a member cannot decline anything either, including their own', async () => {
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });
  const mine = (await call(db, MEMBER_TOKEN, 'GET', '/api/requests')).body.requests[0];

  const { status } = await call(db, MEMBER_TOKEN, 'POST', `/api/requests/${mine.id}/decline`, {});
  assert.equal(status, 403);
});

test('SAYING NO ONCE MEANS SOMETHING — a declined link does not re-queue', async () => {
  // Otherwise the queue becomes the same argument every week, and the owner
  // stops reading it.
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: OTHER_URL });
  const queued = (await call(db, OWNER_TOKEN, 'GET', '/api/requests')).body.requests[0];
  await call(db, OWNER_TOKEN, 'POST', `/api/requests/${queued.id}/decline`, {
    note: 'marketplace seller only',
  });

  const again = await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: OTHER_URL });
  assert.equal(again.body.request.status, 'declined', 'told the truth about what happened');
  assert.match(again.body.message, /turned down/);

  const { body } = await call(db, OWNER_TOKEN, 'GET', '/api/requests', undefined);
  assert.equal(body.requests.length, 1, 'still one row, still declined');
  assert.equal(body.requests[0].decidedNote, 'marketplace seller only');
});

test('a declined request keeps its reason where the person who asked can read it', async () => {
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: OTHER_URL });
  const queued = (await call(db, OWNER_TOKEN, 'GET', '/api/requests')).body.requests[0];
  await call(db, OWNER_TOKEN, 'POST', `/api/requests/${queued.id}/decline`, {
    note: 'this is a bundle, not a sealed product',
  });

  const mine = (await call(db, MEMBER_TOKEN, 'GET', '/api/requests')).body.requests[0];
  assert.equal(mine.status, 'declined');
  assert.equal(mine.decidedNote, 'this is a bundle, not a sealed product');
  assert.ok(mine.decidedAt, 'and when');
});

test('a URL nobody can parse is refused at the door, not queued', async () => {
  const db = await twoUsers();
  const { status, body } = await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', {
    url: 'https://example.com/some-blog-post',
  });
  assert.equal(status, 400);
  assert.match(body.error, /could not read a retailer/);
  assert.equal((await store.listProductRequests(db, MEMBER)).length, 0);
});

test('the pending count is the owner\'s badge and nobody else\'s', async () => {
  const db = await twoUsers();
  await call(db, MEMBER_TOKEN, 'POST', '/api/quick-add', { url: TARGET_URL });
  assert.equal(await store.pendingRequestCount(db, OWNER), 1);
  assert.equal(await store.pendingRequestCount(db, MEMBER), 0, 'members have no inbox to work');
});
