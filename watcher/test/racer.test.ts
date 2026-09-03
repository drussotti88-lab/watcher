/**
 * Stopping when the answer arrives.
 *
 * A read cost about 5.7 seconds, and nearly all of it was deliberate waiting:
 * navigate, then hold for two full seconds of the page's TEXT not changing.
 * That rule was written for a real bug — Target read mid-hydration at 1,446
 * characters with no price — but it answers "has the page finished rendering",
 * and the question is "do I know the state and the price yet".
 *
 * These tests are about the difference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { raceToRead, type RaceDeps } from '../src/racer.ts';
import type { ProductRead } from '../src/readers/types.ts';

const read = (over: Partial<ProductRead> = {}): ProductRead => ({
  name: 'Mega Evolution ETB',
  price: 49.99,
  state: 'out',
  confidence: 'exact',
  availableQuantity: null,
  orderLimit: null,
  pickupAvailable: false, addToCart: null,
  seller: { kind: 'retailer', name: 'Target' },
  preOrder: { isPreOrder: false, releaseDate: null },
  note: '',
  imageUrl: '',
  ...over,
});

const nothing = (): ProductRead => read({ state: 'unknown', confidence: 'unknown', price: null });
const half = (): ProductRead => read({ state: 'out', confidence: 'inferred', price: null });

/** A fake clock: `wait` advances it instead of sleeping, so tests are instant. */
function racer(answers: (ProductRead | Error)[]): RaceDeps & { clock: number; polls: number } {
  const d = {
    clock: 0,
    polls: 0,
    async read() {
      const a = answers[Math.min(d.polls, answers.length - 1)];
      d.polls += 1;
      if (a instanceof Error) throw a;
      return a;
    },
    async wait(ms: number) {
      d.clock += ms;
    },
    now: () => d.clock,
  };
  return d as RaceDeps & { clock: number; polls: number };
}

test('AN ANSWER THAT IS ALREADY THERE COSTS NOTHING', () => {
  // Walmart's data is __NEXT_DATA__ in the initial HTML. A loop that sleeps
  // before its first look would pay 120ms on every single check of that
  // retailer for no reason at all.
  const d = racer([read()]);
  return raceToRead(d, { pollMs: 120, timeoutMs: 9000 }).then((r) => {
    assert.equal(r.won, true);
    assert.equal(r.waitedMs, 0, 'not one tick spent waiting');
    assert.equal(r.polls, 1);
  });
});

test('it stops the instant the reader is confident, not when the page settles', async () => {
  // Four empty looks, then the API body lands. 480ms, against the two full
  // seconds of settle the old path would have spent AFTER this moment.
  const d = racer([nothing(), nothing(), nothing(), nothing(), read()]);
  const r = await raceToRead(d, { pollMs: 120, timeoutMs: 9000 });
  assert.equal(r.won, true);
  assert.equal(r.waitedMs, 480);
  assert.equal(r.read?.price, 49.99);
});

test('A HALF-ARRIVED PAGE IS NOT AN ANSWER', async () => {
  // The original bug, at a new address. 'inferred' means a state with no
  // price, which is exactly the shape a page takes mid-hydration. Stopping
  // there would report "out of stock" about a page that had not loaded.
  const d = racer([half(), half(), read({ price: 44.99 })]);
  const r = await raceToRead(d, { pollMs: 100, timeoutMs: 9000 });
  assert.equal(r.won, true);
  assert.equal(r.read?.price, 44.99);
  assert.equal(r.waitedMs, 200, 'it kept looking rather than settling for it');
});

test('but an inferred read is still worth reporting at the deadline', async () => {
  // "Out of stock, no price" is a real reading. It is just not worth stopping
  // early for. Throwing it away would turn a slow page into a failure.
  const d = racer([half()]);
  const r = await raceToRead(d, { pollMs: 100, timeoutMs: 500 });
  assert.equal(r.won, false);
  assert.equal(r.read?.state, 'out');
  assert.equal(r.read?.confidence, 'inferred');
});

test('a page that never says anything comes back with nothing, not a guess', async () => {
  const d = racer([nothing()]);
  const r = await raceToRead(d, { pollMs: 100, timeoutMs: 400 });
  assert.equal(r.won, false);
  assert.equal(r.read, null, 'the caller decides what an unreadable page means');
});

test('A LATER LOOK THAT KNOWS LESS DOES NOT ERASE ONE THAT KNEW MORE', async () => {
  // A captured body followed by a navigation that clears the DOM. Without
  // this, a real "out of stock" turns back into "unknown" and the mission
  // reports a failure it did not have.
  const d = racer([half(), nothing(), nothing(), nothing(), nothing()]);
  const r = await raceToRead(d, { pollMs: 100, timeoutMs: 500 });
  assert.equal(r.read?.state, 'out');
});

test('a reader that throws on a document that does not exist yet is normal', async () => {
  // With waitUntil: 'commit' the first look can land before there is a page.
  // That is a moment in the race, not a failure.
  const d = racer([new Error('Execution context was destroyed'), nothing(), read()]);
  const r = await raceToRead(d, { pollMs: 100, timeoutMs: 9000 });
  assert.equal(r.won, true);
  assert.equal(r.polls, 3);
});

test('the deadline is honoured rather than overshot by a whole poll', async () => {
  const d = racer([nothing()]);
  const r = await raceToRead(d, { pollMs: 300, timeoutMs: 1000 });
  assert.ok(r.waitedMs <= 1000, `waited ${r.waitedMs}ms against a 1000ms budget`);
});

test('polls are counted, because that is the number to tune on', async () => {
  const d = racer([nothing(), nothing(), read()]);
  const r = await raceToRead(d, { pollMs: 50, timeoutMs: 9000 });
  assert.equal(r.polls, 3);
});
