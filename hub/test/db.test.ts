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
import { readFile } from 'node:fs/promises';

import { connectionStringFrom, isConnectionFailure, POOL_OPTIONS } from '../src/db.ts';

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

// ── The pool ─────────────────────────────────────────────────────────────────

test('THE POOL IS BIG ENOUGH FOR THE WIDEST PROMISE.ALL', async () => {
  // Counted from the source, not asserted against a number someone remembered.
  //
  // The deadlock this prevents cannot be reproduced in-process: PGlite is one
  // embedded engine and the fault lives in pgbouncer's transaction mode. With
  // max: 1, /api/dashboard's parallel queries never returned — not slowly, at
  // all — while each of them ran alone in under 300ms.
  //
  // This test earns its place because the very next change after the fix added
  // a sixth query to that Promise.all while max was 5.
  const src = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

  let widest = 0;
  let where = '';
  for (const match of src.matchAll(/Promise\.all\(\[/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let entries = 1;
    let i = start;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i] ?? '';
      if (c && '([{'.includes(c)) depth += 1;
      else if (c && ')]}'.includes(c)) depth -= 1;
      else if (c === ',' && depth === 1) entries += 1;
    }
    // A trailing comma before the closing bracket counts one entry too many.
    if (/,\s*$/.test(src.slice(start, i - 1))) entries -= 1;
    if (entries > widest) {
      widest = entries;
      where = src.slice(start, start + 60).split('\n')[1]?.trim() ?? '';
    }
  }

  assert.ok(widest > 0, 'expected to find at least one Promise.all in app.ts');
  assert.ok(
    POOL_OPTIONS.max >= widest,
    `app.ts runs ${widest} queries in one Promise.all (near "${where}") but the pool ` +
      `allows ${POOL_OPTIONS.max}. Below the width they deadlock through the pooler.`,
  );
});

test('prepared statements stay off — the transaction pooler cannot do them', async () => {
  assert.equal(POOL_OPTIONS.prepare, false);
});

test('a query cannot hold a connection indefinitely', async () => {
  assert.ok(POOL_OPTIONS.connection.statement_timeout > 0);
  assert.ok(
    POOL_OPTIONS.connection.statement_timeout < 12_000,
    'it has to fire before the handler deadline, or the deadline is what you see',
  );
});

test('idle connections are given back rather than held forever', async () => {
  assert.ok(POOL_OPTIONS.idle_timeout > 0, 'serverless instances vanish; sockets should not linger');
});
