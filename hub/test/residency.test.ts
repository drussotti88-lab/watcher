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
  // Everything a Phantom can send is declared in these two interfaces. Nothing
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

  // ── Shared since the catalogue (1 Sep 2026) ─────────────────────────────
  //
  // These tables describe a retailer's shelf, not a person. They keep their
  // user_id column as PROVENANCE — who first catalogued this — and deliberately
  // stop filtering on it, so one reading serves every member watching.
  //
  // The list is explicit and short ON PURPOSE. Deriving the exemption would
  // mean any table that stops filtering exempts itself, which is precisely the
  // failure this whole test exists to prevent. Adding a name here has to be an
  // act somebody performs and a reviewer can see.
  const SHARED = ['products', 'listings', 'aliases', 'discoveries', 'watch_state', 'observations'];

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
    assert.ok(owned.includes(expected), `${expected} should carry a user_id column`);
  }

  // The tables that can SPEND. These are the guard's real subject, and none of
  // them may ever appear in SHARED — a money table that stops filtering on its
  // owner is the bug this file was written for.
  for (const money of ['missions', 'settings', 'mission_runs', 'authorisations', 'acquisitions']) {
    assert.ok(!SHARED.includes(money), `${money} must never be shared — it can spend money`);
  }

  const privateTables = owned.filter((t) => !SHARED.includes(t));
  assert.ok(privateTables.includes('missions'), 'missions stays private');

  // Comments first, and not for tidiness. This scanner pairs backticks, so a
  // stray one in prose — `upsertUser`, say — pairs with the opening backtick of
  // the next real query and hands the check a "statement" made of English. It
  // reported a table it had read out of a sentence. Prose cannot filter on
  // user_id, so the guard failed on writing rather than on code.
  //
  // Only whole-line comments are removed: a doc block, or a line whose first
  // characters are // or *. Nothing on a line that also carries code, so no
  // string literal can be cut in half by this.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

  const statements = [
    ...code.matchAll(/`([^`]*?(?:SELECT|INSERT|UPDATE|DELETE)[^`]*?)`/gis),
    ...code.matchAll(/'((?:SELECT|INSERT|UPDATE|DELETE)[^']*?)'/gis),
    // Double quotes too. The convention here is backticks and single quotes,
    // so this found nothing when it was added — which is the point. A guard
    // that only reads two of the three ways to write a string is a guard with
    // a documented way past it.
    ...code.matchAll(/"((?:SELECT|INSERT|UPDATE|DELETE)[^"]*?)"/gis),
  ].map((m) => m[1]!);

  assert.ok(statements.length > 30, `expected to have found the SQL, got ${statements.length}`);

  // ── The one deliberate cross-user write ─────────────────────────────────
  //
  // Exempted by its exact text, not by exempting the table. `check_now_at` is
  // a REQUEST flag — "somebody pressed Check now" — and one shared reading
  // genuinely answers it for everybody waiting on that page. Scoping it to the
  // writer would leave every other member's button stuck on "check queued"
  // forever, describing a check that did happen.
  //
  // It carries no money: the flag only ever moves a mission UP the queue, and
  // arming, ceilings and spend caps are untouched by it. Naming the statement
  // means a second cross-user write cannot hide behind this one.
  //
  // ── The inbox ────────────────────────────────────────────────────────────
  //
  // `product_requests` is a member's own list to read and the OWNER'S INBOX to
  // work. Deciding a request and counting what is waiting are both the owner
  // acting across everybody's rows on purpose, so neither can filter on the
  // caller. Both are gated on `can_write_catalogue` in code — and the test
  // below this one holds them to that, so the exemption cannot become a way in.
  //
  // Nothing in this table spends: a request is a URL and a sentence.
  const ALLOWED = [
    'UPDATE missions SET check_now_at = NULL WHERE listing_id = $1 AND check_now_at IS NOT NULL',
    'UPDATE product_requests SET status = $2, listing_id = $3, decided_note = $4, decided_at = now() WHERE id = $1 RETURNING id',
    "SELECT count(*)::text AS n FROM product_requests WHERE status = 'pending'",
  ];

  const unfiltered: string[] = [];
  for (const statement of statements) {
    const sql = statement.toLowerCase();
    const touched = privateTables.filter((t) => new RegExp('\\b' + t + '\\b').test(sql));
    const normalised = statement.split(/\s+/).join(' ').trim();
    if (touched.length && !sql.includes('user_id') && !ALLOWED.includes(normalised)) {
      unfiltered.push(`${touched.join(', ')} — ${statement.split(/\s+/).join(' ').slice(0, 90)}`);
    }
  }

  assert.deepEqual(
    unfiltered,
    [],
    'these statements touch a PRIVATE table without filtering on user_id:\n  ' +
      unfiltered.join('\n  '),
  );
});

test('THE ONE DELIBERATE CROSS-USER READ IS MARKED AS ONE', async () => {
  // The fan-out is a hole in the wall this file guards, dug on purpose: the
  // owner's Phantom reads the union of everybody's missions so one fetch of a
  // page serves every member watching it.
  //
  // The statement-level guard above is satisfied by any mention of user_id,
  // and this query mentions it in an ORDER BY — which is exactly the sort of
  // accident that turns a safety property into a comment. So the hole gets
  // named here: any SELECT over missions that is NOT scoped by
  // `m.user_id = $1` in its WHERE must hand back `read_only`, and the mapper
  // must blank `armed` on those rows. One hole, and it cannot widen quietly.
  const src = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8');

  const selects = [...src.matchAll(/`(SELECT[^`]*?\bFROM missions\b[^`]*?)`/gis)].map(
    (m) => m[1]!,
  );
  assert.ok(selects.length > 0, 'expected to find the mission SELECTs');

  const unscoped = selects.filter((q) => !/\bm\.user_id\s*=\s*\$1/.test(q.split(/order\s+by/i)[0]!));
  assert.equal(unscoped.length, 1, 'exactly one query may read other people\'s missions');
  assert.match(unscoped[0]!, /AS read_only/, 'and it must say which rows are not ours');

  assert.match(
    src,
    /read_only === true\) return \{ \.\.\.mission, readOnly: true, armed: false \}/,
    'a borrowed mission comes back disarmed, in code, not by convention',
  );
});

test('THE INBOX EXEMPTIONS ARE ROLE-GATED, NOT JUST EXEMPT', async () => {
  // An entry in ALLOWED is a hole with a name on it. The reason those two
  // product_requests statements are safe is not that they are listed — it is
  // that the functions holding them refuse anyone without can_write_catalogue.
  // If that gate is ever deleted, the exemption alone would let a member
  // approve their own links straight into the shared catalogue.
  const src = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8');

  for (const fn of ['decideProductRequest', 'pendingRequestCount']) {
    const start = src.indexOf(`export async function ${fn}(`);
    assert.ok(start > 0, `${fn} should exist`);
    const body = src.slice(start, start + 900);
    assert.match(body, /canWriteCatalogue\(db, userId\)/, `${fn} must check the role first`);
    assert.ok(
      body.indexOf('canWriteCatalogue') < body.indexOf('product_requests'),
      `${fn} must check the role BEFORE it touches the table`,
    );
  }
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
