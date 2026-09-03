/**
 * Walmart's queue, and the cart behind it.
 *
 * Written against the one capture we have — 8:13pm, 2 Sep 2026, live — and
 * against the fact that everything after it is unobserved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WALMART_SELECTORS,
  WalmartStepError,
  findControl,
  queueStateFrom,
} from '../src/checkout/walmart.ts';

const QUEUE_URL =
  'https://www.walmart.com/qp?qpdata=%7B%22queued%22%3Atrue%2C%22queue%22%3A%22q011b513268044%22%7D';

/** Verbatim, signed out. */
const SIGNED_OUT_TEXT =
  "Sign in to join the line\n\nOnce you're in line, we'll hold your spot and let you know " +
  "when it's your turn.\n\nSign in to join the line\nDon't have an account?\n\nCreate account";

test('THE SIGNED-OUT QUEUE PAGE IS NOT A PLACE IN LINE', () => {
  // The whole flow depends on this distinction. Signed out there is no place
  // to take — the page offers a sign-in and nothing else, and a machine that
  // called this "queued" would sit politely until the drop was over.
  assert.equal(queueStateFrom(QUEUE_URL, SIGNED_OUT_TEXT, false), 'needs-signin');
});

test('signed in, the same URL is a queue we can wait in', () => {
  assert.equal(queueStateFrom(QUEUE_URL, "You're in line. Estimated wait 12 minutes.", false), 'queued');
});

test('A BOT CHECK BEATS EVERYTHING, INCLUDING A QUEUE', () => {
  // Never engineered around. When this fires the machine stops and a person
  // takes over.
  assert.equal(queueStateFrom(QUEUE_URL, "You're in line", true), 'challenged');
});

test('an ordinary product page is not a queue', () => {
  assert.equal(queueStateFrom('https://www.walmart.com/ip/20243261734', 'Add to cart', false), 'product');
  assert.equal(queueStateFrom('https://www.walmart.com/ip/20243261734', 'Sold out', false), 'product');
});

test('a page we have never seen says so instead of guessing', () => {
  assert.equal(queueStateFrom('https://www.walmart.com/ip/1', 'Something new entirely', false), 'unknown');
});

test('queued:false is not a queue', () => {
  assert.equal(
    queueStateFrom('https://www.walmart.com/qp?qpdata=%7B%22queued%22%3Afalse%7D', 'x', false),
    'unknown',
  );
});

// ── The selectors nobody has verified ────────────────────────────────────────

test('EVERY WALMART SELECTOR STARTS UNVERIFIED', () => {
  // Target's place-order button was located, boxed, photographed and approved
  // before anything clicked it. Walmart gets the same treatment; the one place
  // never to guess is the one where money moves.
  for (const [name, spec] of Object.entries(WALMART_SELECTORS)) {
    assert.equal(spec.verified, false, `${name} must be promoted by hand, from a real capture`);
  }
});

test('AN UNVERIFIED SELECTOR CANNOT BE CLICKED', async () => {
  const page = { locator: () => ({ count: async () => 1 }) } as never;
  await assert.rejects(
    () => findControl(page, 'placeOrder', 'click'),
    (err: unknown) => err instanceof WalmartStepError && /not verified/.test((err as Error).message),
  );
});

test('but it can be looked for, which is how it gets verified', async () => {
  const page = { locator: () => ({ count: async () => 1 }) } as never;
  const found = await findControl(page, 'placeOrder', 'read');
  assert.equal(found.found, true);
  assert.equal(found.selector, WALMART_SELECTORS.placeOrder.candidates[0]);
});

test('a control that is not on the page reports absence rather than throwing', async () => {
  const page = { locator: () => ({ count: async () => 0 }) } as never;
  const found = await findControl(page, 'joinLine', 'read');
  assert.equal(found.found, false);
  assert.equal(found.selector, '');
});
