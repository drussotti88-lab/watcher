/**
 * A confirmed purchase becomes a queued acquisition, is reviewed, and lands in
 * the vault — the review-then-send half of Phantom↔vault bridge, proven
 * against a real Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import type { Env } from '../src/types.ts';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  APP_PASSWORD: 'hub-password',
  PHANTOM_SHARED_SECRET: 'a-shared-secret-for-tests',
  VAULT_URL: 'https://vault.test',
  VAULT_OWNER_USER_ID: '11111111-2222-3333-4444-555555555555',
};

interface Fixture { db: TestDb; missionId: number; authId: number }

/** A product, a listing, an armed mission, a grant — everything a buy needs. */
async function bought(): Promise<Fixture> {
  const db = await TestDb.create();
  await db.query(`INSERT INTO products (key, name, image_url) VALUES ('prd_pens', 'A cheap pack of pens', 'https://img.test/pens.png')`);
  const listings = await db.query<{ id: number }>(
    `INSERT INTO listings (product_key, retailer, external_id, url)
     VALUES ('prd_pens', 'Target', '111', 'https://www.target.com/p/-/A-111') RETURNING id`);
  const missions = await db.query<{ id: number }>(
    `INSERT INTO missions (listing_id, armed, ceiling, quantity) VALUES ($1, true, 20, 2) RETURNING id`,
    [Number(listings[0]!.id)]);
  const missionId = Number(missions[0]!.id);
  await store.setSettings(db, 1, { spendCapDay: 200 });
  const grant = await store.requestAuthorisation(db, 1, missionId);
  assert.equal(grant.granted, true);
  // The bought run, so the acquisition can carry the price actually paid.
  await db.query(
    `INSERT INTO mission_runs (mission_id, outcome, reason, price) VALUES ($1, 'bought', 'order confirmed', 17.49)`,
    [missionId]);
  return { db, missionId, authId: grant.authorisation!.id };
}

test('RESOLVING SPENT QUEUES THE PURCHASE FOR THE VAULT — with the real price and quantity', async () => {
  const { db, missionId, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', 'order confirmed');

  const rows = await store.listAcquisitions(db, 1);
  assert.equal(rows.length, 1);
  const a = rows[0]!;
  assert.equal(a.status, 'queued');
  assert.equal(a.name, 'A cheap pack of pens');
  assert.equal(a.retailer, 'Target');
  assert.equal(a.quantity, 2);
  assert.equal(a.unitPriceCents, 1749, 'the bought run’s price, in cents');
  assert.equal(a.missionId, missionId);
  assert.equal(a.externalKey, `auth-${authId}`);
  assert.equal(a.imageUrl, 'https://img.test/pens.png');
  await db.close();
});

test('released is not a purchase — nothing queues', async () => {
  const { db, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'released', 'checked the orders page');
  assert.equal((await store.listAcquisitions(db, 1)).length, 0);
  await db.close();
});

test('the queue is idempotent on the grant — a retried resolve cannot double it', async () => {
  const { db, missionId, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  await store.queueAcquisition(db, 1, authId, missionId);   // the retry, direct
  assert.equal((await store.listAcquisitions(db, 1)).length, 1);
  await db.close();
});

test('SENDING REMEMBERS THE MATCH — the next buy of the same product pre-fills', async () => {
  const { db, missionId, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  const [queued] = await store.listAcquisitions(db, 1);
  assert.equal(queued!.vaultTcgId, '', 'nothing is guessed the first time');

  const sent = await store.markAcquisitionSent(db, 1, queued!.id, '624634', [11, 12]);
  assert.equal(sent!.status, 'sent');
  assert.ok(sent!.sentAt);

  // The product now knows what it is in the vault…
  const prod = await db.query<{ vault_tcg_id: string }>(
    "SELECT vault_tcg_id FROM products WHERE key = 'prd_pens'");
  assert.equal(prod[0]!.vault_tcg_id, '624634');

  // …so the next purchase of the same product arrives pre-matched. A spent
  // grant locks its mission forever (that IS the double-buy guard), so the
  // next buy is a fresh listing+mission of the same product — the restock.
  void missionId;
  const l2 = await db.query<{ id: number }>(
    `INSERT INTO listings (product_key, retailer, external_id, url)
     VALUES ('prd_pens', 'Target', '222', 'https://www.target.com/p/-/A-222') RETURNING id`);
  const m2 = await db.query<{ id: number }>(
    `INSERT INTO missions (listing_id, armed, ceiling, quantity) VALUES ($1, true, 20, 1) RETURNING id`,
    [Number(l2[0]!.id)]);
  const grant2 = await store.requestAuthorisation(db, 1, Number(m2[0]!.id));
  assert.equal(grant2.granted, true);
  await store.resolveAuthorisation(db, 1, grant2.authorisation!.id, 'spent', '');
  const again = (await store.listAcquisitions(db, 1)).find((a) => a.status === 'queued');
  assert.equal(again!.vaultTcgId, '624634');
  await db.close();
});

test('a sent acquisition cannot be sent or dismissed again', async () => {
  const { db, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  const [q] = await store.listAcquisitions(db, 1);
  await store.markAcquisitionSent(db, 1, q!.id, '1', []);
  assert.equal(await store.markAcquisitionSent(db, 1, q!.id, '2', []), null);
  assert.equal(await store.dismissAcquisition(db, 1, q!.id), false);
  await db.close();
});

// ── through the API, with the vault stubbed ──────────────────────────────────

const call = async (
  db: TestDb,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method, headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function ownerCookie(db: TestDb): Promise<string> {
  const login = await createHandler(db, env)(new Request('https://hub.test/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle: '', password: 'hub-password' }),
  }));
  return (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;
}

test('THE SEND DELIVERS TO THE VAULT AND MARKS THE ROW — owner path via VAULT_OWNER_USER_ID', async (t) => {
  const { db, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  const cookie = await ownerCookie(db);
  const [q] = await store.listAcquisitions(db, 1);

  const realFetch = globalThis.fetch;
  const seen: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, itemIds: [41, 42] }) };
  }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const r = await call(db, 'POST', `/api/acquisitions/${q!.id}/send`, {
    cookie, body: { tcgId: '624634', name: 'Pokémon Pens 8-Pack' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.acquisition.status, 'sent');

  assert.equal(seen.length, 1);
  assert.match(seen[0]!.url, /vault\.test\/api\/phantom\/acquisitions$/);
  assert.equal(seen[0]!.body.userId, env.VAULT_OWNER_USER_ID);
  assert.equal(seen[0]!.body.externalKey, `auth-${authId}`);
  assert.equal(seen[0]!.body.quantity, 2);
  assert.equal(seen[0]!.body.priceCents, 1749);
  assert.equal(seen[0]!.body.tcgId, '624634');

  // A second send of the same row is refused before any vault call is made.
  const again = await call(db, 'POST', `/api/acquisitions/${q!.id}/send`, { cookie, body: {} });
  assert.equal(again.status, 409);
  assert.equal(seen.length, 1);
  await db.close();
});

test('a vault failure leaves the row queued — nothing is marked sent on a guess', async (t) => {
  const { db, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  const cookie = await ownerCookie(db);
  const [q] = await store.listAcquisitions(db, 1);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const r = await call(db, 'POST', `/api/acquisitions/${q!.id}/send`, { cookie, body: {} });
  assert.equal(r.status, 502);
  const rows = await store.listAcquisitions(db, 1);
  assert.equal(rows[0]!.status, 'queued', 'still queued, ready to retry');
  await db.close();
});

test('dismiss keeps the record and closes the row', async () => {
  const { db, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  const cookie = await ownerCookie(db);
  const [q] = await store.listAcquisitions(db, 1);
  const r = await call(db, 'POST', `/api/acquisitions/${q!.id}/dismiss`, { cookie });
  assert.equal(r.status, 200);
  assert.equal((await store.listAcquisitions(db, 1))[0]!.status, 'dismissed');
  await db.close();
});

test('the dashboard carries the queue, so the tab can badge it', async () => {
  const { db, authId } = await bought();
  await store.resolveAuthorisation(db, 1, authId, 'spent', '');
  const cookie = await ownerCookie(db);
  const r = await call(db, 'GET', '/api/dashboard', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.acquisitions.length, 1);
  assert.equal(r.body.acquisitions[0].status, 'queued');
  await db.close();
});
