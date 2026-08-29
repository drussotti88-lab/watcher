/**
 * The connection-string guard.
 *
 * Every case here is one Roberto actually hit while setting this up, which is
 * the point: Supabase offers three strings, two of them are wrong for a
 * serverless deploy, and both of the wrong ones work perfectly from a laptop.
 * A guard that only catches the mistake in production is not a guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionStringFrom, isConnectionFailure } from '../src/db.ts';

const REF = 'riwdybozflszkpcpdinc';
const SHARED = `postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

test('the shared pooler in transaction mode is accepted', () => {
  assert.equal(connectionStringFrom({ DATABASE_URL: SHARED }), SHARED);
});

test('the shared pooler in session mode is accepted too — it is still IPv4', () => {
  // Not ideal for serverless, but it works, and refusing it would be a lie.
  const session = SHARED.replace(':6543/', ':5432/');
  assert.equal(connectionStringFrom({ DATABASE_URL: session }), session);
});

test('the direct connection is refused, and says which one to use', () => {
  const direct = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
  assert.throws(() => connectionStringFrom({ DATABASE_URL: direct }), (err: Error) => {
    assert.match(err.message, /direct connection/);
    assert.match(err.message, /pooler\.supabase\.com/, 'must name the fix, not just the fault');
    return true;
  });
});

test('THE ONE A PORT CHECK MISSES: the dedicated pooler is also refused', () => {
  // Right port, wrong host. The first version of this guard only looked at the
  // port and waved this straight through to a deploy that could never connect.
  const dedicated = `postgresql://postgres:pw@db.${REF}.supabase.co:6543/postgres`;
  assert.throws(() => connectionStringFrom({ DATABASE_URL: dedicated }), (err: Error) => {
    assert.match(err.message, /dedicated pooler/);
    assert.match(err.message, /IPv6/, 'the reason matters — it is not a style preference');
    return true;
  });
});

test('a missing string says where to find one', () => {
  assert.throws(() => connectionStringFrom({}), /Connect/);
});

test('something that is not a Postgres URL at all is refused', () => {
  assert.throws(() => connectionStringFrom({ DATABASE_URL: 'https://riwdyb.supabase.co' }),
    /Postgres connection string/);
});

test('a non-Supabase Postgres host is left alone', () => {
  // The guard is about one provider's three-way choice. It must not start
  // rejecting perfectly good databases elsewhere.
  const other = 'postgresql://user:pw@my-db.example.com:5432/postgres';
  assert.equal(connectionStringFrom({ DATABASE_URL: other }), other);
});

test('POSTGRES_URL is accepted as an alias', () => {
  assert.equal(connectionStringFrom({ POSTGRES_URL: SHARED }), SHARED);
});

// ── Which failures cost us the connection ────────────────────────────────────

test('A DEAD SOCKET IS A CONNECTION FAILURE', async () => {
  // The one that started this: a request timed out, the handler ended the
  // shared client, and an unrelated "Add product" running beside it died with
  // exactly this. The text is kept verbatim because it is what reaches a user.
  const seen = [
    { code: 'CONNECTION_DESTROYED' },
    new Error('write CONNECTION_DESTROYED aws-0-us-east-2.pooler.supabase.com:6543'),
    { code: 'ECONNRESET' },
    { code: '57P01' },
    new Error('Connection terminated unexpectedly'),
  ];
  for (const err of seen) {
    assert.equal(isConnectionFailure(err), true, JSON.stringify(String((err as any).code ?? err)));
  }
});

test('A BAD QUERY IS NOT — it must not cost everybody a reconnect', async () => {
  const notConnection = [
    null,
    undefined,
    new Error('a product needs a name'),
    new Error('duplicate key value violates unique constraint "products_pkey"'),
    { code: '23505' },
    { code: '42703', message: 'column "nope" does not exist' },
  ];
  for (const err of notConnection) {
    assert.equal(isConnectionFailure(err), false, String(err));
  }
});
