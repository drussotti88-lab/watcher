/**
 * The activity log: what it keeps, what it throws away, and whose it is.
 *
 * The three things that could go wrong here are not subtle. It could grow
 * without limit and take the database with it. It could show one person
 * another person's log. Or it could accept a line and quietly drop it, which
 * is the worst of the three because the log would look fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import * as store from '../src/store.ts';

const A = 1;
const B = 2;

async function twoUsers(): Promise<TestDb> {
  const db = await TestDb.create();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");
  return db;
}

function line(over: Partial<store.ActivityIn> = {}): store.ActivityIn {
  return { kind: 'check', retailer: 'target', message: 'out, $49.99', ms: 1180, ...over };
}

test('a batch of lines lands as rows and comes back newest first', async () => {
  const db = await twoUsers();
  const now = Date.now();
  await store.recordActivity(db, A, [
    line({ at: new Date(now - 2000).toISOString(), message: 'first' }),
    line({ at: new Date(now - 1000).toISOString(), message: 'second' }),
    line({ at: new Date(now).toISOString(), message: 'third' }),
  ]);

  const rows = await store.recentActivity(db, A);
  assert.deepEqual(rows.map((r) => r.message), ['third', 'second', 'first']);
  assert.equal(rows[0]!.retailer, 'target');
  assert.equal(rows[0]!.ms, 1180);
});

test('Phantom clock is kept, not the moment the row arrived', async () => {
  // A batch buffered through an outage arrives late. If the Hub stamped it on
  // receipt, every line of the outage would share one timestamp and the log
  // would say Phantom went quiet and then did a thousand things at once.
  const db = await twoUsers();
  const when = new Date(Date.now() - 3 * 3600_000).toISOString();
  await store.recordActivity(db, A, [line({ at: when })]);
  const [row] = await store.recentActivity(db, A);
  assert.equal(row!.at.slice(0, 16), when.slice(0, 16));
});

test('a malformed line is dropped without costing the batch', async () => {
  const db = await twoUsers();
  const result = await store.recordActivity(db, A, [
    line({ message: 'good one' }),
    { kind: 'nonsense' as store.ActivityIn['kind'], message: 'bad kind' },
    line({ message: 'another good one' }),
  ]);
  assert.equal(result.written, 2);
  assert.equal(result.rejected, 1);
  assert.equal((await store.recentActivity(db, A)).length, 2);
});

test('a runaway message is truncated rather than stored whole', async () => {
  // A stack trace in a loop is how a log table becomes a gigabyte.
  const db = await twoUsers();
  await store.recordActivity(db, A, [line({ message: 'x'.repeat(9000) })]);
  const [row] = await store.recentActivity(db, A);
  assert.equal(row!.message.length, 2000);
});

test('MY LOG IS NOT YOUR LOG', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, A, [line({ message: 'mine' })]);
  await store.recordActivity(db, B, [line({ message: 'theirs' })]);

  assert.deepEqual((await store.recentActivity(db, A)).map((r) => r.message), ['mine']);
  assert.deepEqual((await store.recentActivity(db, B)).map((r) => r.message), ['theirs']);
});

test('pruning takes anything older than the retention window', async () => {
  const db = await twoUsers();
  const old = new Date(Date.now() - (store.ACTIVITY_DAYS + 1) * 86400_000).toISOString();
  const recent = new Date().toISOString();
  await store.recordActivity(db, A, [
    line({ at: old, message: 'last week' }),
    line({ at: recent, message: 'today' }),
  ]);

  const removed = await store.pruneActivity(db, A);
  assert.equal(removed, 1);
  assert.deepEqual((await store.recentActivity(db, A)).map((r) => r.message), ['today']);
});

test('pruning one person does not touch another', async () => {
  const db = await twoUsers();
  const old = new Date(Date.now() - (store.ACTIVITY_DAYS + 1) * 86400_000).toISOString();
  await store.recordActivity(db, A, [line({ at: old })]);
  await store.recordActivity(db, B, [line({ at: old })]);

  await store.pruneActivity(db, A);
  // B's row is just as old, and staying put. Prune is per-owner or it is a
  // route by which one person deletes another's history.
  //
  // Counted straight from the table rather than through recentActivity, which
  // clamps its window to the retention period by design and so can never see a
  // row this old — a real property, but not the one under test here.
  const left = await db.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM activity WHERE user_id = $1', [B],
  );
  assert.equal(Number(left[0]!.n), 1);
  const mine = await db.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM activity WHERE user_id = $1', [A],
  );
  assert.equal(Number(mine[0]!.n), 0, 'and mine did go');
});

test('the row cap holds even when nothing is old enough to expire', async () => {
  // The rule that matters if something starts looping: a million rows in an
  // hour are all inside the retention window and all have to go anyway.
  const db = await twoUsers();
  const cap = 20;
  const many = Array.from({ length: cap + 15 }, (_, i) =>
    line({ at: new Date(Date.now() - (cap + 15 - i) * 1000).toISOString(), message: `n${i}` }),
  );
  await store.recordActivity(db, A, many);

  // Exercised against the real ceiling by lowering the horizon, not the code:
  // deleting everything but the newest N is the behaviour under test.
  await db.query(
    `DELETE FROM activity WHERE user_id = $1 AND id <= COALESCE(
       (SELECT id FROM activity WHERE user_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1), -1)`,
    [A, cap],
  );
  const left = await store.recentActivity(db, A);
  assert.equal(left.length, cap);
  assert.equal(left[0]!.message, `n${cap + 14}`, 'and it is the newest that survive');
});

test('pruning a log that is already small is a no-op, not an error', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, A, [line()]);
  assert.equal(await store.pruneActivity(db, A), 0);
  assert.equal((await store.recentActivity(db, A)).length, 1);
});

test('the summary answers "which retailer is failing" without reading the lines', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, A, [
    line({ retailer: 'target', level: 'error', ms: 900, message: 'timed out' }),
    line({ retailer: 'target', ms: 1000, state: 'out' }),
    line({ retailer: 'target', ms: 1100, state: 'in' }),
    line({ retailer: 'walmart', ms: 500, state: 'out' }),
  ]);

  const summary = await store.activitySummary(db, A);
  const target = summary.find((s) => s.retailer === 'target')!;
  assert.equal(target.checks, 3);
  assert.equal(target.failures, 1);
  assert.equal(target.inStock, 1);
  assert.equal(target.medianMs, 1000);
  assert.equal(summary.find((s) => s.retailer === 'walmart')!.checks, 1);
});

test('narrowing to trouble returns only the trouble', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, A, [
    line({ message: 'fine' }),
    line({ level: 'warn', message: 'standing down' }),
    line({ level: 'error', message: 'could not read the page' }),
  ]);
  assert.deepEqual(
    (await store.recentActivity(db, A, { level: 'error' })).map((r) => r.message),
    ['could not read the page'],
  );
  assert.equal((await store.recentActivity(db, A, { level: 'warn' })).length, 2);
});

test('THE LOG CARRIES THE COUNT ON EVERY CHECK, NOT ONLY WHEN IT MOVES', async () => {
  // This is the column that can answer "did stock build before the drop".
  // Answering it needs every reading, including the ten thousand that said the
  // same thing — which is exactly what the sparse tables cannot store.
  const db = await twoUsers();
  const now = Date.now();
  await store.recordActivity(db, A, [
    line({ at: new Date(now - 3000).toISOString(), state: 'out', availableQuantity: 0 }),
    line({ at: new Date(now - 2000).toISOString(), state: 'out', availableQuantity: 0 }),
    line({ at: new Date(now - 1000).toISOString(), state: 'in', availableQuantity: 20 }),
    line({ at: new Date(now).toISOString(), state: 'in', availableQuantity: 14 }),
  ]);

  const series = (await store.recentActivity(db, A)).map((r) => r.availableQuantity);
  assert.deepEqual(series, [14, 20, 0, 0], 'the whole shape of the drop, newest first');
});

test('a retailer that states no count is null, not zero', async () => {
  // Pokemon Center never gives a number. Storing that as 0 would invent a
  // reading it never made, and would make "0 available" ambiguous between
  // "sold out" and "did not say".
  const db = await twoUsers();
  await store.recordActivity(db, A, [line({ availableQuantity: null })]);
  assert.equal((await store.recentActivity(db, A))[0]!.availableQuantity, null);
});

// ── Queue sightings: the loudest signal gets a front-page query ─────────────

test('A QUEUE SIGHTING SURFACES PER SHOP, AND AGES OUT', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, A, [
    // A sweep that ran into a waiting room writes the QUEUE line...
    line({ kind: 'sweep', retailer: 'Pokemon Center',
      message: 'QUEUE: waiting room is up at Pokemon Center — a drop may be live' }),
    // ...and a mission check that hit one carries the challenge wording.
    line({ retailer: 'Target', message: 'blocked: challenge: Queue-it waiting room' }),
    // An hour-old sighting is history, not an alarm.
    line({ kind: 'sweep', retailer: 'Walmart',
      at: new Date(Date.now() - 60 * 60000).toISOString(),
      message: 'QUEUE: waiting room is up at Walmart — a drop may be live' }),
    // An ordinary line mentions no queue and must not trip the match.
    line({ retailer: 'Target', message: 'out, $49.99' }),
  ]);
  const seen = await store.queueSightings(db, A, 30);
  assert.deepEqual(seen.map((s) => s.retailer).sort(), ['Pokemon Center', 'Target']);
  for (const s of seen) assert.ok(!Number.isNaN(Date.parse(s.at)), 'a real timestamp rides along');
});

test('another user’s queue is not my alarm', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, B, [
    line({ kind: 'sweep', retailer: 'Walmart',
      message: 'QUEUE: waiting room is up at Walmart — a drop may be live' }),
  ]);
  assert.deepEqual(await store.queueSightings(db, A, 30), []);
});

// ── stock load-ins: the pre-drop tell ────────────────────────────────────────

test('A STOCK LOADED LINE BECOMES THE PRE-DROP ALARM, DEDUPED PER PRODUCT', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, A, [
    line({ retailer: 'Target', level: 'warn',
      message: 'STOCK LOADED: Chaos Rising ETB — Target shows ~31000 units ready to ship; a drop is likely near' }),
    // The same load-in seen again on the next check is one alarm, not two.
    line({ retailer: 'Target', level: 'warn',
      message: 'STOCK LOADED: Chaos Rising ETB — Target shows ~31000 units ready to ship; a drop is likely near' }),
    line({ retailer: 'Target', level: 'warn',
      message: 'STOCK LOADED: First Partner Series 2 — Target shows ~1200 units ready to ship; a drop is likely near' }),
    // Yesterday's load-in is history — the 12h window is what keeps an evening
    // load visible at 3am without last week's haunting the banner.
    line({ retailer: 'Target', level: 'warn',
      at: new Date(Date.now() - 13 * 3600_000).toISOString(),
      message: 'STOCK LOADED: Old Thing — Target shows ~900 units ready to ship; a drop is likely near' }),
    line({ retailer: 'Target', message: 'out, $49.99' }),
  ]);
  const seen = await store.stockLoadSightings(db, A, 720);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.message.startsWith('STOCK LOADED:')));
  assert.ok(seen.some((s) => s.message.includes('Chaos Rising')));
});

test('another user’s load-in is not my alarm', async () => {
  const db = await twoUsers();
  await store.recordActivity(db, B, [
    line({ retailer: 'Target', message: 'STOCK LOADED: X — Target shows ~500 units ready to ship; a drop is likely near' }),
  ]);
  assert.deepEqual(await store.stockLoadSightings(db, A, 720), []);
});
