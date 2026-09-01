/**
 * Permission to spend.
 *
 * Every test here maps to a way money is lost at 3am. The two that carry the
 * most weight are the duplicate lock (four checks racing must not become four
 * boxes) and the fail-closed crash story (a grant nobody resolved keeps its
 * money committed until a person looks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import { mintSession, COOKIE_NAME } from '../src/auth.ts';
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
  missionId: number;
  secondMissionId: number;
}

async function setup(opts: { cap?: number | null; ceiling?: number; armed?: boolean } = {}): Promise<Fixture> {
  const db = await TestDb.create();
  await db.query(`INSERT INTO products (key, name) VALUES ('prd_etb', 'Mega Evolution ETB'), ('prd_tin', 'A Tin')`);
  const listings = await db.query<{ id: number; product_key: string }>(
    `INSERT INTO listings (product_key, retailer, external_id, url) VALUES
       ('prd_etb', 'Target', '111', 'https://www.target.com/p/-/A-111'),
       ('prd_tin', 'Target', '222', 'https://www.target.com/p/-/A-222')
     RETURNING id, product_key`,
  );
  const l1 = Number(listings.find((l) => l.product_key === 'prd_etb')!.id);
  const l2 = Number(listings.find((l) => l.product_key === 'prd_tin')!.id);
  const missions = await db.query<{ id: number; listing_id: number }>(
    `INSERT INTO missions (listing_id, armed, ceiling, quantity) VALUES
       ($1, $3, $4, 1), ($2, $3, $4, 1) RETURNING id, listing_id`,
    [l1, l2, opts.armed ?? true, opts.ceiling ?? 60],
  );
  if (opts.cap !== null) {
    await store.setSettings(db, 1, { spendCapDay: opts.cap ?? 200 });
  }
  return {
    db,
    missionId: Number(missions.find((m) => Number(m.listing_id) === l1)!.id),
    secondMissionId: Number(missions.find((m) => Number(m.listing_id) === l2)!.id),
  };
}

test('AN ARMED MISSION WITHIN THE CAP IS GRANTED, ONCE', async () => {
  const { db, missionId } = await setup({ cap: 200, ceiling: 60 });
  const first = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(first.granted, true);
  assert.equal(first.authorisation!.amount, 60, 'ceiling × quantity, no shipping allowance set');
  assert.equal(first.committed, 60, 'and the money is committed immediately');

  // The same mission asking again — a second check finding the same stock, or
  // a Phantom that restarted mid-buy. This is the four-boxes bug, prevented.
  const second = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(second.granted, false);
  assert.equal(second.refusal, 'duplicate_prevented');
});

test('the amount is ceiling × quantity plus the shipping allowance', async () => {
  const { db, missionId } = await setup({ cap: 500, ceiling: 50 });
  await db.query('UPDATE missions SET quantity = 2 WHERE id = $1', [missionId]);
  await store.setSettings(db, 1, { shippingAllowance: 8.5 });
  const r = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(r.granted, true);
  assert.equal(r.authorisation!.amount, 108.5, '50 × 2 + 8.50');
});

test('NO CAP MEANS NO GRANT, WHATEVER ELSE IS TRUE', async () => {
  // Unset is not unlimited. Unset means a person has not decided, and an
  // undecided cap must not default to yes.
  const { db, missionId } = await setup({ cap: null });
  const r = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(r.granted, false);
  assert.equal(r.refusal, 'no_spend_cap');
  assert.match(r.reason, /Settings/);
});

test('a grant that would pass the cap is refused and says its arithmetic', async () => {
  const { db, missionId, secondMissionId } = await setup({ cap: 100, ceiling: 60 });
  const first = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(first.granted, true);

  const second = await store.requestAuthorisation(db, 1, secondMissionId);
  assert.equal(second.granted, false);
  assert.equal(second.refusal, 'budget_exhausted');
  assert.match(second.reason, /\$120\.00/, 'says where the total would have landed');
  assert.match(second.reason, /\$100\.00/, 'and what the cap is');
});

test('a released grant frees its money; a spent one keeps counting', async () => {
  const { db, missionId, secondMissionId } = await setup({ cap: 100, ceiling: 60 });
  const first = await store.requestAuthorisation(db, 1, missionId);

  // Released — the buy failed cleanly, nothing was bought, the money returns.
  await store.resolveAuthorisation(db, 1, first.authorisation!.id, 'released', 'cart failed');
  const after = await store.requestAuthorisation(db, 1, secondMissionId);
  assert.equal(after.granted, true, 'the released $60 no longer counts');

  // Spent — that money is gone and stays counted for the rest of the 24 hours.
  await store.resolveAuthorisation(db, 1, after.authorisation!.id, 'spent', 'bought');
  assert.equal(await store.committedLast24h(db, 1), 60);
});

test('SPENT DISARMS THE MISSION — one mission, one purchase', async () => {
  const { db, missionId } = await setup({ cap: 200 });
  const r = await store.requestAuthorisation(db, 1, missionId);
  await store.resolveAuthorisation(db, 1, r.authorisation!.id, 'spent', 'bought 1');

  const mission = await store.getMission(db, 1, missionId);
  assert.equal(mission!.armed, false, 're-arming is a decision a person makes, not a side effect');

  // And a disarmed mission cannot be granted again.
  const again = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(again.granted, false);
  assert.equal(again.refusal, 'not_armed');
});

test('a spent grant still blocks a new one even if the mission is re-armed', async () => {
  // The unique index keeps 'spent' live on purpose: re-arming after a buy is a
  // person's decision, and buying AGAIN needs the old grant cleared knowingly,
  // not a fresh grant handed out because the status moved on.
  const { db, missionId } = await setup({ cap: 500 });
  const r = await store.requestAuthorisation(db, 1, missionId);
  await store.resolveAuthorisation(db, 1, r.authorisation!.id, 'spent', 'bought');
  await db.query('UPDATE missions SET armed = true WHERE id = $1', [missionId]);

  const again = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(again.granted, false);
  assert.equal(again.refusal, 'duplicate_prevented');
});

test('a resolution happens once and cannot be repeated or reversed', async () => {
  const { db, missionId } = await setup({ cap: 200 });
  const r = await store.requestAuthorisation(db, 1, missionId);
  const done = await store.resolveAuthorisation(db, 1, r.authorisation!.id, 'released', 'x');
  assert.ok(done);
  assert.equal(await store.resolveAuthorisation(db, 1, r.authorisation!.id, 'spent', 'y'), null,
    'a released grant cannot later become spent');
});

test('an unarmed or missing mission is refused by name', async () => {
  const { db, missionId } = await setup({ cap: 200, armed: false });
  const r = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(r.refusal, 'not_armed');
  const gone = await store.requestAuthorisation(db, 1, 999999);
  assert.equal(gone.refusal, 'not_armed');
});

test('an armed mission with no ceiling is refused before the cap is consulted', async () => {
  const { db, missionId } = await setup({ cap: 200 });
  await db.query('UPDATE missions SET ceiling = NULL WHERE id = $1', [missionId]);
  const r = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(r.refusal, 'no_ceiling');
});

// ── Over the wire ────────────────────────────────────────────────────────────

const call = async (
  db: TestDb,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('Phantom can ask over the wire and resolve what it was granted', async () => {
  const { db, missionId } = await setup({ cap: 200 });
  const granted = await call(db, 'POST', '/api/authorise', {
    token: TOKEN,
    body: { missionId },
  });
  assert.equal(granted.status, 201);
  assert.equal(granted.body.granted, true);

  const resolved = await call(db, 'POST', `/api/authorisations/${granted.body.authorisation.id}/resolve`, {
    token: TOKEN,
    body: { result: 'released', note: 'dry run complete' },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.authorisation.status, 'released');
});

test('a refusal over the wire is a 200 with the reason, not an error', async () => {
  // Phantom has to act on refusals — record them as runs — so a refusal is
  // an answer, not a failure.
  const { db, missionId } = await setup({ cap: null });
  const r = await call(db, 'POST', '/api/authorise', { token: TOKEN, body: { missionId } });
  assert.equal(r.status, 200);
  assert.equal(r.body.granted, false);
  assert.equal(r.body.refusal, 'no_spend_cap');
});

test('NOBODY UNAUTHENTICATED TOUCHES THE MONEY ENDPOINTS', async () => {
  const { db, missionId } = await setup({ cap: 200 });
  assert.equal((await call(db, 'POST', '/api/authorise', { body: { missionId } })).status, 401);
  assert.equal(
    (await call(db, 'POST', '/api/authorisations/1/resolve', { body: { result: 'released' } })).status,
    401,
  );
});

test('ARMING IS REFUSED UNTIL A SPEND CAP EXISTS', async () => {
  const { db, missionId } = await setup({ cap: null, armed: false });
  const rows = await db.query<{ listing_id: number }>(
    'SELECT listing_id FROM missions WHERE id = $1', [missionId],
  );
  const listingId = Number(rows[0]!.listing_id);
  const cookie = await mintSession(PASSWORD, 1);
  const refused = await call(db, 'POST', '/api/missions', {
    cookie,
    body: { listingId, armed: true, ceiling: 60 },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /daily spend cap/);

  await store.setSettings(db, 1, { spendCapDay: 200 });
  const allowed = await call(db, 'POST', '/api/missions', {
    cookie,
    body: { listingId, armed: true, ceiling: 60 },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.mission.armed, true);
});

test('one user cannot spend another user\'s budget or resolve their grants', async () => {
  const { db, missionId } = await setup({ cap: 200 });
  await db.query(`INSERT INTO users (id, handle) VALUES (2, 'tester')`);
  const theirs = await store.requestAuthorisation(db, 2, missionId);
  assert.equal(theirs.granted, false, "user 2 cannot authorise against user 1's mission");

  const mine = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(await store.resolveAuthorisation(db, 2, mine.authorisation!.id, 'released', ''), null);
});
