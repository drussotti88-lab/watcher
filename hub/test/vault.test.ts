/**
 * The bridge to DNA Card Vault, proven at both ends.
 *
 * The launch-token and signature tests mint their material with node:crypto
 * EXACTLY the way the vault's src/lib/phantom.js does — same hash, same
 * base64url, same message shapes — so these tests are the byte-compatibility
 * contract between the two codebases. If either side drifts, this file goes
 * red before a member's sign-in does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import {
  verifyLaunchToken,
  signedHeaders,
  checkEntitlement,
  deliverAcquisition,
  vaultConfigured,
} from '../src/vault.ts';
import type { Env } from '../src/types.ts';

const SECRET = 'a-shared-secret-for-tests';
const VAULT_UID = '11111111-2222-3333-4444-555555555555';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: 'test-token',
  APP_PASSWORD: 'hub-password',
  PHANTOM_SHARED_SECRET: SECRET,
  VAULT_URL: 'https://vault.test',
};

/** Mint a launch token the way the VAULT does — a port of its mintLaunchToken. */
function vaultMint(userId: string, email: string, expiresMs: number): string {
  const payload = Buffer.from(JSON.stringify({
    u: userId, e: email, x: expiresMs, n: randomBytes(9).toString('base64url'),
  })).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

// ── the token contract ───────────────────────────────────────────────────────

test('A VAULT-MINTED TOKEN VERIFIES — the byte contract holds', async () => {
  const token = vaultMint(VAULT_UID, 'roberto@example.com', Date.now() + 60_000);
  const claims = await verifyLaunchToken(env, token);
  assert.ok(claims, 'the token verifies');
  assert.equal(claims!.userId, VAULT_UID);
  assert.equal(claims!.email, 'roberto@example.com');
});

test('an expired token is nobody', async () => {
  const token = vaultMint(VAULT_UID, '', Date.now() - 1000);
  assert.equal(await verifyLaunchToken(env, token), null);
});

test('a tampered payload is nobody — the MAC is checked before anything is read', async () => {
  const token = vaultMint(VAULT_UID, '', Date.now() + 60_000);
  const [payload, mac] = token.split('.');
  const other = Buffer.from(JSON.stringify({
    u: 'attacker', e: '', x: Date.now() + 60_000, n: 'x',
  })).toString('base64url');
  assert.equal(await verifyLaunchToken(env, `${other}.${mac}`), null);
  assert.equal(await verifyLaunchToken(env, `${payload}.AAAA`), null);
  assert.equal(await verifyLaunchToken(env, 'garbage'), null);
  assert.equal(await verifyLaunchToken(env, null), null);
});

test('no shared secret means no door at all', async () => {
  const token = vaultMint(VAULT_UID, '', Date.now() + 60_000);
  assert.equal(await verifyLaunchToken({ ...env, PHANTOM_SHARED_SECRET: '' }, token), null);
});

test('signed server calls match the vault’s verifier shape', async () => {
  const headers = await signedHeaders(env, 'GET', '/api/phantom/entitlement?user=abc', '', 1700000000000);
  // The vault recomputes hmac(secret, `<ts>.<METHOD>.<path>.<body>`) — recompute it here
  // the vault's way and demand the same answer.
  const want = createHmac('sha256', SECRET)
    .update('1700000000000.GET./api/phantom/entitlement?user=abc.')
    .digest('base64url');
  assert.equal(headers['x-phantom-ts'], '1700000000000');
  assert.equal(headers['x-phantom-sig'], want);
});

// ── entitlement: three answers, not two ──────────────────────────────────────

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

test('the vault saying yes and saying no both come through verbatim', async () => {
  const yes = await checkEntitlement(env, VAULT_UID, fakeFetch(200, { entitled: true, sources: ['paypal-phantom'] }));
  assert.deepEqual(yes, { answer: 'yes', sources: ['paypal-phantom'] });
  const no = await checkEntitlement(env, VAULT_UID, fakeFetch(200, { entitled: false, sources: [] }));
  assert.equal(no.answer, 'no');
});

test('THE VAULT BEING DOWN IS UNKNOWN, NEVER NO — nobody is locked out by an outage', async () => {
  const boom: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  assert.equal((await checkEntitlement(env, VAULT_UID, boom)).answer, 'unknown');
  assert.equal((await checkEntitlement(env, VAULT_UID, fakeFetch(503, {}))).answer, 'unknown');
  assert.equal((await checkEntitlement(env, VAULT_UID, fakeFetch(200, { weird: 1 }))).answer, 'unknown');
  const unconfigured = await checkEntitlement({ ...env, VAULT_URL: '' }, VAULT_UID);
  assert.equal(unconfigured.answer, 'unknown');
});

test('deliverAcquisition reports the vault’s own sentence on failure', async () => {
  const ok = await deliverAcquisition(env, {
    externalKey: 'auth-1', vaultUserId: VAULT_UID, name: 'Pens', quantity: 1,
    priceCents: 1700, acquiredOn: '2026-08-31', retailer: 'Target', tcgId: '12345',
  }, fakeFetch(200, { ok: true, itemIds: [7] }));
  assert.deepEqual(ok, { ok: true, itemIds: [7] });
  const bad = await deliverAcquisition(env, {
    externalKey: 'auth-1', vaultUserId: VAULT_UID, name: 'Pens', quantity: 1,
    priceCents: null, acquiredOn: '2026-08-31', retailer: 'Target', tcgId: null,
  }, fakeFetch(503, { error: 'could not record the import' }));
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /could not record/);
});

test('vaultConfigured needs both halves', () => {
  assert.equal(vaultConfigured(env), true);
  assert.equal(vaultConfigured({ ...env, VAULT_URL: '' }), false);
  assert.equal(vaultConfigured({ ...env, PHANTOM_SHARED_SECRET: '' }), false);
});

// ── /sso: the vault’s door into the Hub ──────────────────────────────────────

const call = async (
  db: TestDb,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: any; setCookie: string }> => {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method, headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, setCookie: res.headers.get('Set-Cookie') ?? '' };
};

test('A VALID LAUNCH TOKEN BECOMES A SESSION — and the account is created on first entry', async () => {
  const db = await TestDb.create();
  const token = vaultMint(VAULT_UID, 'buyer@example.com', Date.now() + 60_000);
  const r = await call(db, 'POST', '/api/sso', { body: { token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.setCookie, /hub_session=/);

  const users = await db.query<{ id: number; handle: string; vault_user_id: string }>(
    'SELECT id, handle, vault_user_id FROM users WHERE vault_user_id = $1', [VAULT_UID]);
  assert.equal(users.length, 1);
  assert.equal(users[0]!.handle, 'buyer@example.com');

  // The second entry is the same account, not a twin.
  const again = await call(db, 'POST', '/api/sso', {
    body: { token: vaultMint(VAULT_UID, 'buyer@example.com', Date.now() + 60_000) },
  });
  assert.equal(again.status, 200);
  const after = await db.query('SELECT id FROM users WHERE vault_user_id = $1', [VAULT_UID]);
  assert.equal(after.length, 1);
  await db.close();
});

test('an expired or forged token gets a sentence, not a session', async () => {
  const db = await TestDb.create();
  const expired = await call(db, 'POST', '/api/sso', {
    body: { token: vaultMint(VAULT_UID, '', Date.now() - 1) },
  });
  assert.equal(expired.status, 401);
  assert.match(expired.body.error, /expired/);
  assert.equal(expired.setCookie, '');
  const forged = await call(db, 'POST', '/api/sso', { body: { token: 'a.b' } });
  assert.equal(forged.status, 401);
  await db.close();
});

test('GET /sso serves the door page without a session', async () => {
  const db = await TestDb.create();
  const r = await call(db, 'GET', '/sso');
  assert.equal(r.status, 200);
  assert.match(String(r.body), /location.hash/);
  assert.match(String(r.body), /api\/sso/);
  await db.close();
});

// ── the daily re-proof ───────────────────────────────────────────────────────

async function vaultSession(db: TestDb): Promise<string> {
  const token = vaultMint(VAULT_UID, 'buyer@example.com', Date.now() + 60_000);
  const r = await call(db, 'POST', '/api/sso', { body: { token } });
  return r.setCookie.split(';')[0]!;
}

test('A LAPSED TIER ENDS THE SESSION; AN OUTAGE DOES NOT', async (t) => {
  const db = await TestDb.create();
  const cookie = await vaultSession(db);

  // Fresh check (set by /api/sso just now): no vault call is made at all.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('should not be called'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const fresh = await call(db, 'GET', '/api/dashboard', { cookie });
  assert.equal(fresh.status, 200);
  assert.equal(calls, 0, 'a fresh entitlement is not re-checked');

  // Stale + vault unreachable: unknown fails OPEN.
  await db.query("UPDATE users SET entitlement_checked_at = now() - interval '2 days' WHERE vault_user_id = $1", [VAULT_UID]);
  const outage = await call(db, 'GET', '/api/dashboard', { cookie });
  assert.equal(outage.status, 200, 'the vault being down locks nobody out');
  assert.ok(calls > 0);

  // Stale + the vault explicitly says no: the session ends and the account closes.
  globalThis.fetch = (async () => ({
    ok: true, status: 200, json: async () => ({ entitled: false, sources: [] }),
  })) as unknown as typeof fetch;
  const lapsed = await call(db, 'GET', '/api/dashboard', { cookie });
  assert.equal(lapsed.status, 401);
  assert.match(lapsed.body.error, /lapsed/);
  assert.match(lapsed.setCookie, /hub_session=;/);

  const row = await db.query<{ enabled: boolean }>('SELECT enabled FROM users WHERE vault_user_id = $1', [VAULT_UID]);
  assert.equal(row[0]!.enabled, false);

  // And the way back in is the vault's door, which re-enables on a fresh token.
  const back = await call(db, 'POST', '/api/sso', {
    body: { token: vaultMint(VAULT_UID, 'buyer@example.com', Date.now() + 60_000) },
  });
  assert.equal(back.status, 200);
  const re = await db.query<{ enabled: boolean }>('SELECT enabled FROM users WHERE vault_user_id = $1', [VAULT_UID]);
  assert.equal(re[0]!.enabled, true);
  await db.close();
});

test('the owner’s password account has no vault link and is never re-checked', async () => {
  const db = await TestDb.create();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('no vault call belongs here'); }) as typeof fetch;
  try {
    const form = new URLSearchParams({ handle: '', password: 'hub-password' });
    const login = await createHandler(db, env)(new Request('https://hub.test/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }));
    const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const r = await call(db, 'GET', '/api/dashboard', { cookie });
    assert.equal(r.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  await db.close();
});
