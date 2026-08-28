/**
 * Settling.
 *
 * These are regression tests for a real miss. The Target product page was read
 * at 1,446 characters — enough to look like a page, not enough to contain the
 * price or the words "Out of stock", both of which were plainly there in the
 * screenshot taken moments later. The old rule was "stop once there's enough
 * text", which answers the wrong question.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { settleRead, type TextSource } from '../src/settle.ts';

/** A page that grows through the given sizes, one per poll, then stops. */
function fakePage(sizes: number[]): TextSource & { polls: number } {
  let clock = 0;
  let i = 0;
  const src = {
    polls: 0,
    async text() {
      const n = sizes[Math.min(i, sizes.length - 1)] ?? 0;
      i += 1;
      src.polls += 1;
      return 'x'.repeat(n);
    },
    async wait(ms: number) {
      clock += ms;
    },
    now() {
      return clock;
    },
  };
  return src;
}

test('does not stop the moment it passes minText — the Target bug', async () => {
  // 1,446 chars, then the price and stock line finally land at 6,200.
  const page = fakePage([0, 900, 1446, 1446, 3000, 6200, 6200, 6200, 6200]);
  const out = await settleRead(page, { minText: 800, settleForMs: 1200, pollMs: 400 });
  assert.equal(out.settled, true);
  assert.equal(out.text.length, 6200, 'must wait for the page to finish, not merely to appear');
});

test('a page that arrives whole settles quickly and does not burn the timeout', async () => {
  const page = fakePage([5000]);
  const out = await settleRead(page, { minText: 800, settleForMs: 1200, pollMs: 400, timeoutMs: 30_000 });
  assert.equal(out.settled, true);
  assert.ok(out.waitedMs < 3000, `settled fast, waited ${out.waitedMs}ms`);
});

test('a page that never stops changing reports settled:false rather than lying', async () => {
  let n = 1000;
  const src: TextSource = {
    async text() {
      n += 250; // always growing: an infinite feed, or a spinner rewriting itself
      return 'x'.repeat(n);
    },
    async wait() {},
    now: (() => {
      let c = 0;
      return () => (c += 400);
    })(),
  };
  const out = await settleRead(src, { minText: 800, settleForMs: 1200, pollMs: 400, timeoutMs: 4000 });
  assert.equal(out.settled, false, 'the caller must be able to tell a finished read from a timed-out one');
  assert.ok(out.text.length > 1000, 'still returns the best text it managed');
});

test('an empty shell that stays empty never counts as settled', async () => {
  const page = fakePage([120]); // a challenge page, or a dead route
  const out = await settleRead(page, { minText: 800, settleForMs: 1200, pollMs: 400, timeoutMs: 3000 });
  assert.equal(out.settled, false, 'stable but below minText is not a finished product page');
});

test('`until` short-circuits as soon as the thing we were waiting for appears', async () => {
  const page = fakePage([100, 200, 300, 400, 500, 600]);
  let seen = 0;
  const out = await settleRead(page, {
    minText: 100_000, // deliberately unreachable
    timeoutMs: 30_000,
    pollMs: 400,
    until: (t) => {
      seen += 1;
      return t.length >= 300;
    },
  });
  assert.equal(out.settled, true);
  assert.equal(seen, 3, 'stopped on the signal, not on a character count');
});

test('a page read never throws when the read itself fails', async () => {
  const src: TextSource = {
    async text() {
      throw new Error('navigation destroyed the execution context');
    },
    async wait() {},
    now: (() => {
      let c = 0;
      return () => (c += 400);
    })(),
  };
  const out = await settleRead(src, { timeoutMs: 1200, pollMs: 400 });
  assert.equal(out.text, '', 'a mid-navigation read gives nothing, not an exception');
  assert.equal(out.settled, false);
});
