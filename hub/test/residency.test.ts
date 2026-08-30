/**
 * Where data is allowed to live.
 *
 * The Hub holds the shopping list and never the wallet. Cards, addresses and
 * retailer sign-ins live in each user's own Chrome profile, on their own
 * machine — never transmitted, and with nowhere here to transmit them into.
 *
 * That is currently true by accident: the 403 finding pushed all the buying
 * onto the user's machine, so no credential ever needed a home in this schema.
 * It is too good a property to leave to luck, so this test is the rule with
 * teeth. It reads the real schema and the real wire, and fails if either grows
 * somewhere to put a secret.
 *
 * If one of these fails, the fix is almost never to widen the denylist. It is
 * that a feature wants a value it should not have, and the feature is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name: string): Promise<string> =>
  readFile(new URL('../' + name, import.meta.url), 'utf8');

/**
 * Words that name something we must never hold.
 *
 * Deliberately about *credentials and identity*, not about money — prices,
 * ceilings and totals are the whole point of the system and belong here.
 */
const FORBIDDEN = [
  'card_number', 'cardnumber', 'card_num', 'pan',
  'cvv', 'cvc', 'security_code',
  'expiry', 'exp_month', 'exp_year',
  'password', 'passwd', 'secret', 'credential',
  'address', 'street', 'postcode', 'postal', 'zip',
  'ssn', 'social_security', 'tax_id',
  'phone', 'mobile', 'email',
  'billing', 'payment_method', 'account_number', 'routing',
  'visitor_id', 'home_store',
];

/** Column names, as declared. */
async function schemaColumns(): Promise<string[]> {
  const sql = await read('schema.sql');
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const columns: string[] = [];
  for (const block of withoutComments.split(/CREATE TABLE[^(]*\(/i).slice(1)) {
    for (const line of block.split('\n')) {
      const m = /^\s{2,}([a-z_]+)\s+[A-Z]/.exec(line);
      if (m) columns.push(m[1]!);
    }
  }
  return columns;
}

test('THE SCHEMA HAS NOWHERE TO PUT A CREDENTIAL', async () => {
  const columns = await schemaColumns();
  assert.ok(columns.length > 30, `expected to have parsed the schema, got ${columns.length} columns`);

  for (const column of columns) {
    for (const word of FORBIDDEN) {
      assert.ok(
        !column.includes(word),
        `column "${column}" contains "${word}". The Hub holds the shopping list and ` +
          `never the wallet — if a feature needs this value here, the feature is wrong.`,
      );
    }
  }
});

test('the columns it does have are the shopping list, and they are all still here', async () => {
  // The mirror of the test above: proof the parser is reading real columns
  // rather than quietly finding none and passing.
  const columns = await schemaColumns();
  for (const expected of ['price', 'ceiling', 'msrp', 'state', 'external_id', 'retailer']) {
    assert.ok(columns.includes(expected), `expected the schema to still declare ${expected}`);
  }
});

test('THE WIRE HAS NOWHERE TO PUT ONE EITHER', async () => {
  // Everything a Watcher can send is declared in these two interfaces. Nothing
  // reaches the Hub that is not on that list, so the list is the audit.
  const store = await read('src/store.ts');
  const start = store.indexOf('export interface ObservationIn');
  const end = store.indexOf('export interface RecordedObservation');
  assert.ok(start > 0 && end > start, 'expected to find ObservationIn in store.ts');

  const wire = store.slice(start, end).toLowerCase();
  for (const word of FORBIDDEN) {
    assert.ok(!wire.includes(word), `the observation wire mentions "${word}"`);
  }
});

test('the captured pages stay on the machine that captured them', async () => {
  // Target embeds a visitor id, the home store and its postcode in every
  // request. 523 files of browser profile once went to a public repository
  // because a rename outran the ignore rule; the glob is deliberate.
  const ignore = await read('../watcher/.gitignore');
  assert.match(ignore, /probe-artifacts\//, 'captured pages must never be committed');
  assert.match(ignore, /chrome-profile\*\//, 'and neither must either browser profile');
  assert.match(ignore, /watcher\.config\.json/, 'nor the file holding the Hub token');
});

// ── Ownership ────────────────────────────────────────────────────────────────

test('EVERY QUERY THAT TOUCHES AN OWNED TABLE FILTERS ON THE OWNER', async () => {
  // The compiler catches a call site that forgets to pass a userId. Nothing
  // catches SQL that accepts one and then ignores it — which is the version
  // that spends the wrong person's money.
  //
  // So this reads every statement in store.ts and fails on any that names an
  // owned table without mentioning user_id. Crude on purpose: a guard that is
  // easy to understand is a guard people keep.
  const src = await read('src/store.ts');

  // Derived from the schema, not typed out here. A hand-kept list is a guard
  // that silently stops guarding the day somebody adds a table and forgets to
  // add it to the list — which is exactly when you need it. Every table with a
  // user_id column is an owned table, by definition.
  const schema = await read('schema.sql');
  // Two places to look, because ownership arrived after most of these tables
  // existed: a column declared in the CREATE, or one bolted on by an ALTER.
  const owned = [
    ...[...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)]
      .filter((m) => /\buser_id\b/.test(m[2]!))
      .map((m) => m[1]!),
    ...[...schema.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS user_id\b/g)].map(
      (m) => m[1]!,
    ),
  ];

  assert.ok(owned.length >= 12, `expected to have found the owned tables, got ${owned.join(', ')}`);
  for (const expected of ['products', 'missions', 'observations', 'activity']) {
    assert.ok(owned.includes(expected), `${expected} should be an owned table`);
  }

  const statements = [
    ...src.matchAll(/`([^`]*?(?:SELECT|INSERT|UPDATE|DELETE)[^`]*?)`/gis),
    ...src.matchAll(/'((?:SELECT|INSERT|UPDATE|DELETE)[^']*?)'/gis),
  ].map((m) => m[1]!);

  assert.ok(statements.length > 30, `expected to have found the SQL, got ${statements.length}`);

  const unfiltered: string[] = [];
  for (const statement of statements) {
    const sql = statement.toLowerCase();
    const touched = owned.filter((t) => new RegExp('\\b' + t + '\\b').test(sql));
    if (touched.length && !sql.includes('user_id')) {
      unfiltered.push(`${touched.join(', ')} — ${statement.split(/\s+/).join(' ').slice(0, 90)}`);
    }
  }

  assert.deepEqual(
    unfiltered,
    [],
    'these statements touch an owned table without filtering on user_id:\n  ' +
      unfiltered.join('\n  '),
  );
});

test('the users table holds a label and a hash, and nothing else about a person', async () => {
  // Sign-in comes later and will use Supabase's own auth. This table exists to
  // own rows, not to know anyone.
  const sql = await read('schema.sql');
  const block = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS users'));
  // Comments stripped first: this guard reads columns, not prose. It caught
  // the word "password" inside a comment explaining why there isn't one.
  const columns = block
    .slice(0, block.indexOf(');'))
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  assert.match(columns, /handle/);
  assert.match(columns, /token_hash/);
  assert.doesNotMatch(columns, /password/i, 'we do not store passwords');
  assert.doesNotMatch(columns, /email/i);
});
