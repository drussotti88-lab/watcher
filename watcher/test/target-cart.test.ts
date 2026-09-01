/**
 * The Target cart driver's honest parts: the money parser and the two locks.
 *
 * The selectors themselves were measured at the sitting (31 Aug 2026) by
 * dumping every data-test attribute on a real cart — these tests pin what was
 * measured, so a casual edit cannot quietly turn a reading back into a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TARGET_SELECTORS, targetCart, moneyFrom, CheckoutStepError } from '../src/checkout/target.ts';

test('moneyFrom reads the shapes the real cart writes', () => {
  // Measured rows, verbatim.
  assert.equal(moneyFrom('Subtotal (1 item) $15.99'), 15.99);
  assert.equal(moneyFrom('Estimated taxes $2.14'), 2.14);
  assert.equal(moneyFrom('Shipping $5.99'), 5.99);
  // Free shipping is written as a word, with no number to find.
  assert.equal(moneyFrom('FREE'), 0);
  assert.equal(moneyFrom('Shipping FREE'), 0);
  // A dollar amount wins over the word when both appear.
  assert.equal(moneyFrom('Shipping $5.99 (free over $35)'), 5.99);
  assert.equal(moneyFrom('$1,234.56'), 1234.56);
  assert.equal(moneyFrom(''), null);
  assert.equal(moneyFrom('Arrives Friday'), null);
});

test('THE SELECTOR TABLE KEEPS WHAT THE SITTING MEASURED', () => {
  // These four were read off a real cart page after the original guesses
  // matched nothing. Changing them means re-measuring, not re-guessing.
  assert.deepEqual(TARGET_SELECTORS.cartItemQuantity.candidates,
    ['[data-test="cartItem-qty-stepper"]']);
  assert.deepEqual(TARGET_SELECTORS.subtotal.candidates,
    ['[data-test="cart-summary-subTotal"]']);
  assert.deepEqual(TARGET_SELECTORS.tax.candidates,
    ['[data-test="cart-summary-taxes"]']);
  assert.deepEqual(TARGET_SELECTORS.shipping.candidates,
    ['[data-test="cart-summary-fulfillment"]']);
  // The summary ships collapsed; the toggle is how the three lines above
  // become visible at all.
  assert.deepEqual(TARGET_SELECTORS.summaryToggle.candidates,
    ['button:has([data-test="cart-order-summary"])']);
});

test('THE SITTING IS COMPLETE — every selector is a verified reading', () => {
  // Both halves ran on 31 Aug 2026: the cart in a guest profile, the checkout
  // screens in the real signed-in buy profile, each match boxed in a
  // screenshot and approved by a person. A step that regresses to
  // verified:false here is either a deliberate re-measure or a mistake, and
  // this test makes sure it is never a quiet one.
  for (const [step, spec] of Object.entries(TARGET_SELECTORS)) {
    assert.equal(spec.verified, true, `${step} lost its verification`);
  }
  // The gate in placeOrder stays in the code even though it can no longer
  // fire: the day someone re-measures a selector and flips it back, the
  // refusal must be waiting. What now stands between this driver and money
  // moving is the live flag and an armed, capped mission — by design.
  assert.ok(targetCart.placeOrder, 'the gated entry point still exists');
  assert.ok(CheckoutStepError, 'and so does the error it refuses with');
});

// ── The click is not the order ───────────────────────────────────────────────
//
// Learned the expensive-in-embarrassment way on the first live buy: placeOrder
// returned after clicking, the caller recorded "bought", and the pens were
// still sitting in the cart. These pin the fix: confirmation or a loud throw.

const fakeCheckoutPage = (opts: {
  bodyText?: string;
  url?: string;
  /** Budgets handed to waitForLoadState, so a test can prove we wait on the
   *  page rather than on the clock. */
  settles?: number[];
  /** A page that never goes quiet — settle must swallow it, not fail the buy. */
  neverIdle?: boolean;
  /** Every flat sleep the driver asks for, so a test can prove there are none
   *  left on the critical path and that the confirmation poll is fine-grained. */
  sleeps?: number[];
}) =>
  ({
    url: () => opts.url ?? 'https://www.target.com/checkout',
    waitForTimeout: async (ms: number) => {
      opts.sleeps?.push(ms);
    },
    waitForLoadState: async (_state: string, o?: { timeout?: number }) => {
      opts.settles?.push(o?.timeout ?? 0);
      if (opts.neverIdle) throw new Error('timeout exceeded');
    },
    goto: async () => {},
    evaluate: async () => opts.bodyText ?? 'Review your order and payment',
    locator: () => ({
      first: () => ({
        waitFor: async () => {},
        click: async () => {},
        isVisible: async () => true,
        getAttribute: async () => null,
      }),
    }),
    screenshot: async () => {},
  }) as never;

test('AN ORDER EXISTS ONLY WHEN THE PAGE SAYS SO', async () => {
  // Confirmation text appears -> placeOrder resolves.
  await targetCart.placeOrder(fakeCheckoutPage({ bodyText: 'Thanks for your order!' }));
  // A confirmation URL is also proof.
  await targetCart.placeOrder(
    fakeCheckoutPage({ url: 'https://www.target.com/co-thankyou?x=1' }),
  );
});

test('a click with no confirmation throws instead of claiming bought', async () => {
  await assert.rejects(
    () => targetCart.placeOrder(fakeCheckoutPage({ bodyText: 'Review your order' })),
    (e: unknown) =>
      e instanceof CheckoutStepError &&
      /no confirmation appeared/.test(e.message) &&
      /orders page/.test(e.message),
  );
});

// ── Waiting on the page, not on the clock ────────────────────────────────────
//
// The checkout path used to carry ~10s of flat `waitForTimeout` — 2.5s after
// add, 3s after landing on the cart, 4s before looking for Place Order —
// mostly stacked on top of `find()`, which already waits for its element to be
// visible. A drop is decided in exactly those seconds, so they are now bounded
// waits for the page to go quiet: instant on a fast page, capped on a slow one.

test('PLACE ORDER WAITS FOR THE PAGE, NOT A FLAT FOUR SECONDS', async () => {
  const settles: number[] = [];
  await targetCart.placeOrder(
    fakeCheckoutPage({ bodyText: 'Thanks for your order!', settles }),
  );
  assert.equal(settles.length, 1, 'one bounded settle between checkout and Place Order');
  assert.ok(settles[0]! <= 1500, `the cap is a floor for find(), not a sleep — got ${settles[0]}`);
});

test('a page that never goes quiet does not fail the checkout', async () => {
  // networkidle never arriving is a chatty page, not a broken order. The real
  // gates are `find` and the confirmation check, both of which still run.
  await targetCart.placeOrder(
    fakeCheckoutPage({ bodyText: 'Thanks for your order!', neverIdle: true }),
  );
});

test('the add-to-cart settle is brief, because readCart re-verifies the item', async () => {
  const settles: number[] = [];
  await targetCart.addToCart(fakeCheckoutPage({ settles }));
  assert.equal(settles.length, 1);
  assert.ok(settles[0]! <= 2000, 'brief on purpose — an empty cart is caught downstream');
});

test('REMOVING AN ITEM WAITS ON THE PAGE TOO — no flat sleep is left', async () => {
  // The last one. Nothing races a cleanup, but this is paid on every refused
  // cart and every dry run, and those happen inside drop windows.
  const settles: number[] = [];
  const sleeps: number[] = [];
  await targetCart.removeFromCart(fakeCheckoutPage({ settles, sleeps }));
  assert.equal(sleeps.length, 0, `still sleeping: ${sleeps.join(', ')}`);
  assert.equal(settles.length, 1, 'a bounded settle instead');
  assert.ok(settles[0]! <= 1500);
});

test('THE CONFIRMATION POLL IS FINE-GRAINED — being late to know still costs', async () => {
  // The order is already submitted here, so this is not a race. But at a 2.5s
  // poll the machine could be 2.1 seconds late to know it worked, and the
  // grant resolving to 'spent', the acquisition row and the line a person
  // reads at 3am all wait on that.
  const sleeps: number[] = [];
  await targetCart.placeOrder(
    fakeCheckoutPage({ bodyText: 'Thanks for your order!', sleeps }),
  );
  assert.ok(sleeps.length >= 1, 'it does poll');
  assert.ok(
    sleeps.every((ms) => ms <= 500),
    `the poll should be sub-second, got ${sleeps.join(', ')}`,
  );
});

test('the confirmation budget is still a full 30 seconds', async () => {
  // Finer polling must not become a shorter wait. A slow confirmation page is
  // the case where giving up early would mean throwing about an order that
  // was actually placed.
  const sleeps: number[] = [];
  await assert.rejects(() =>
    targetCart.placeOrder(fakeCheckoutPage({ bodyText: 'Review your order', sleeps })),
  );
  const total = sleeps.reduce((a, b) => a + b, 0);
  assert.ok(total >= 30_000, `only waited ${total}ms before giving up`);
});
