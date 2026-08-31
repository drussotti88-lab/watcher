/**
 * Driving a Target cart, in the signed-in buy profile.
 *
 * ── The one rule of this file ───────────────────────────────────────────────
 *
 * Every selector here is a guess until the sitting proves it. The rung-3 plan
 * says it plainly: writing cart selectors blind is guessing, and guessing is
 * the one thing the design refuses to do — so every step that cannot find its
 * element fails LOUDLY, by name, with a screenshot in logs/checkout/, and the
 * flow records a clean failure instead of clicking the wrong thing.
 *
 * Target uses `data-test` attributes across its storefront, which is why the
 * candidates below are data-test based with text fallbacks. The product-page
 * and cart selectors were verified at the sitting (31 Aug 2026): probed on
 * the real pages, screenshotted with the match highlighted, and approved.
 * The checkout screens — `checkoutButton`'s signed-in behavior and
 * `placeOrder` — are still unverified, because the buy profile's session had
 * lapsed that day and only a person signs in. Until a mini-sitting proves
 * them, this flow can only ever end in `dry_run` or a named failure —
 * `live` has no meaning before every selector on the money path is proven.
 *
 * ── What this file will not do ──────────────────────────────────────────────
 *
 * Nothing here signs in, types a password, or touches payment fields. The buy
 * profile was signed in by a person (`npm run signin`) and holds its own saved
 * address and card inside Target's account — this flow only ever clicks
 * "add to cart" and, when live and verified, the final place-order button.
 * If Target asks for a sign-in or a card number instead of a cart, that is a
 * failure with a screenshot, never a form to fill.
 */
import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CartTotals } from '../money.ts';

/**
 * Where each thing lives on the page — one table, so the sitting edits one
 * place. `verified: false` marks a guess; flip it only after watching the
 * selector work on the real page.
 */
export const TARGET_SELECTORS = {
  addToCart: {
    candidates: [
      '[data-test="shippingButton"]',
      '[data-test="addToCartButton"]',
      'button:has-text("Add to cart")',
    ],
    verified: true,
  },
  // The four below were measured at the sitting (31 Aug 2026) by dumping every
  // data-test attribute on a real cart page — the original guesses matched
  // nothing. Single candidates on purpose: these are readings, not guesses,
  // and a fallback that reads the *wrong* number is worse than a loud failure.
  cartItemQuantity: {
    candidates: ['[data-test="cartItem-qty-stepper"]'],
    verified: true,
  },
  subtotal: {
    // Reads "Subtotal (1 item) $15.99" — moneyFrom takes the first $ amount,
    // and the parenthesis holds no $ to trip on.
    candidates: ['[data-test="cart-summary-subTotal"]'],
    verified: true,
  },
  tax: {
    candidates: ['[data-test="cart-summary-taxes"]'],
    verified: true,
  },
  shipping: {
    candidates: ['[data-test="cart-summary-fulfillment"]'],
    verified: true,
  },
  checkoutButton: {
    candidates: ['[data-test="checkout-button"]'],
    verified: false,
  },
  placeOrder: {
    candidates: ['[data-test="placeOrderButton"]'],
    verified: false,
  },
  removeItem: {
    candidates: ['[data-test="cartItem-deleteBtn"]', 'button:has-text("Remove")'],
    verified: true,
  },
  /**
   * The cart's order summary ships collapsed: subtotal, taxes and shipping
   * are in the DOM but not visible until the "$xx.xx estimated total" row is
   * opened (measured at the sitting — a fresh cart hid all three). The row is
   * a button wrapping the summary block, carrying aria-expanded, so it is
   * found by the data-test it contains rather than one it lacks.
   */
  summaryToggle: {
    candidates: ['button:has([data-test="cart-order-summary"])'],
    verified: true,
  },
} as const;

export type TargetStep = keyof typeof TARGET_SELECTORS;

export class CheckoutStepError extends Error {
  readonly step: TargetStep;
  readonly screenshot: string;
  constructor(step: TargetStep, detail: string, screenshot: string) {
    super(`checkout step "${step}" failed: ${detail}`);
    this.name = 'CheckoutStepError';
    this.step = step;
    this.screenshot = screenshot;
  }
}

const SHOT_DIR = 'logs/checkout';

/** A picture of what the page looked like when a step could not proceed. */
async function screenshot(page: Page, step: string): Promise<string> {
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = resolve(SHOT_DIR, `${Date.now()}-${step}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return '';
  }
}

/** The first candidate that exists on the page, or a loud, pictured failure. */
async function find(page: Page, step: TargetStep, timeoutMs = 8000) {
  const { candidates } = TARGET_SELECTORS[step];
  const perCandidate = Math.max(1500, Math.floor(timeoutMs / candidates.length));
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: perCandidate });
      return locator;
    } catch {
      /* next candidate */
    }
  }
  const shot = await screenshot(page, step);
  throw new CheckoutStepError(
    step,
    `none of [${TARGET_SELECTORS[step].candidates.join(', ')}] appeared — ` +
      `the selector table needs the sitting` +
      (shot ? `; what the page showed is in ${shot}` : ''),
    shot,
  );
}

/**
 * "$54.99" → 54.99. "FREE" → 0 — Target writes free shipping as a word.
 *
 * A dollar amount wins over the word: "Shipping $5.99" is 5.99 even if the
 * page also mentions free-shipping thresholds somewhere in the same row. Only
 * a row with no amount at all falls back to reading "free" as zero — the cart
 * summary's shipping line says "FREE" with no number on qualifying orders,
 * and a null there would refuse a buy that free shipping just made cheaper.
 */
export function moneyFrom(text: string): number | null {
  const clean = String(text ?? '').trim();
  const m = /[$]\s*([\d,]+[.]?\d{0,2})/.exec(clean);
  if (!m) return /\bfree\b/i.test(clean) ? 0 : null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export interface CartDriver {
  /** Put the item in the basket. The page must already be the product page. */
  addToCart(page: Page): Promise<void>;
  /** Read what the cart actually says. Null fields are refusals downstream. */
  readCart(page: Page): Promise<CartTotals>;
  /** Take it back out — dry runs must not leave a basket behind. */
  removeFromCart(page: Page): Promise<void>;
  /** The last click. Only ever called when live AND the selector is verified. */
  placeOrder(page: Page): Promise<void>;
}

export const targetCart: CartDriver = {
  async addToCart(page) {
    const button = await find(page, 'addToCart');
    await button.click();
    // Target confirms with a side sheet; give it a moment rather than racing
    // to the cart while the add is still in flight.
    await page.waitForTimeout(2500);
  },

  async readCart(page) {
    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Open the order summary when it says it is shut. Soft on purpose: if
    // Target ever renders it open, or renames the toggle while leaving the
    // lines visible, reading still works — and if the lines stay hidden, the
    // reads below return nulls and verifyCart refuses, which is the correct
    // downstream fate for a cart we could not read.
    const toggle = page.locator(TARGET_SELECTORS.summaryToggle.candidates[0]!).first();
    if ((await toggle.getAttribute('aria-expanded').catch(() => null)) === 'false') {
      await toggle.click().catch(() => {});
      await page.waitForTimeout(1200);
    }

    const qty = await find(page, 'cartItemQuantity');
    const quantityText = (await qty.inputValue().catch(() => '')) || (await qty.innerText());
    const quantity = Number(String(quantityText).replace(/[^0-9]/g, '')) || null;

    const read = async (step: TargetStep): Promise<number | null> => {
      try {
        const el = await find(page, step, 4000);
        return moneyFrom(await el.innerText());
      } catch {
        // Null, not zero. A missing tax line is a cart we did not understand,
        // and verifyCart refuses nulls — which is the correct downstream fate.
        return null;
      }
    };

    const subtotal = await read('subtotal');
    return {
      unitPrice:
        subtotal !== null && quantity ? Math.round((subtotal / quantity) * 100) / 100 : null,
      quantity,
      tax: await read('tax'),
      shipping: await read('shipping'),
    };
  },

  async removeFromCart(page) {
    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
    const remove = await find(page, 'removeItem');
    await remove.click();
    await page.waitForTimeout(2000);
  },

  async placeOrder(page) {
    // Two locks, both deliberate. The caller checks `live`; this checks that a
    // person has watched these selectors work. Money does not move on a guess.
    if (!TARGET_SELECTORS.checkoutButton.verified || !TARGET_SELECTORS.placeOrder.verified) {
      throw new CheckoutStepError(
        'placeOrder',
        'the checkout selectors have never been verified against a real cart — ' +
          'that is the sitting, and it has not happened',
        '',
      );
    }
    const checkout = await find(page, 'checkoutButton');
    await checkout.click();
    await page.waitForTimeout(4000);
    const place = await find(page, 'placeOrder');
    await place.click();
  },
};
