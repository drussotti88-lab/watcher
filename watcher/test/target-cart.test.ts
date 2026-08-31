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

const fakeCheckoutPage = (opts: { bodyText?: string; url?: string }) =>
  ({
    url: () => opts.url ?? 'https://www.target.com/checkout',
    waitForTimeout: async () => {},
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
