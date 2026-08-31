/**
 * The deep-page rotation. Its whole promise is coverage: every page of the
 * back catalogue gets read within a bounded number of days, at a fixed
 * per-sweep cost, with no stored state to lose in a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deepPages } from '../src/plan.ts';

const day = (n: number): string => {
  const d = new Date(Date.UTC(2026, 8, 1 + n));
  return d.toISOString().slice(0, 10);
};

test('EVERY DEEP PAGE IS VISITED WITHIN A WEEK OF DAILY SWEEPS', () => {
  // 19 pages, 3 fresh, 3 deep a day: 16 deep pages / 3 a day → all of them
  // inside 7 days, whatever day the clock starts on.
  for (let start = 0; start < 16; start += 1) {
    const visited = new Set<number>();
    for (let n = 0; n < 7; n += 1) {
      for (const p of deepPages(day(start + n), 19, 3, 3)) visited.add(p);
    }
    for (let p = 4; p <= 19; p += 1) {
      assert.ok(visited.has(p), `page ${p} never visited starting day ${start}`);
    }
  }
});

test('deep pages never include the fresh pages or run past the end', () => {
  for (let n = 0; n < 30; n += 1) {
    for (const p of deepPages(day(n), 19, 3, 3)) {
      assert.ok(p >= 4 && p <= 19, `page ${p} out of range`);
    }
  }
});

test('the same day always plans the same pages — the date is the state', () => {
  assert.deepEqual(deepPages(day(5), 19, 3, 3), deepPages(day(5), 19, 3, 3));
});

test('a catalogue no deeper than the fresh pages has no deep pages', () => {
  assert.deepEqual(deepPages(day(0), 3, 3, 3), []);
  assert.deepEqual(deepPages(day(0), 2, 3, 3), []);
});

test('a short tail is not over-asked', () => {
  // 5 pages, 3 fresh: only pages 4 and 5 exist, so a take of 3 yields 2.
  const got = deepPages(day(0), 5, 3, 3);
  assert.deepEqual(got, [4, 5]);
});
