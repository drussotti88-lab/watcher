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
 * candidates below are data-test based with text fallbacks. Every selector
 * was verified at the sitting (31 Aug 2026): probed on the real pages —
 * product, signed-in cart, and the checkout review screen with the saved
 * card in play — screenshotted with the match highlighted, and approved by
 * a person. What still stands between this file and money moving is the
 * `live` config flag and an armed mission under a spend cap, which is
 * exactly the distance that should remain.
 *
 * ── What this file will not do ──────────────────────────────────────────────
 *
 * Nothing here signs in, types a password, or touches payment fields. The buy
 * profile was signed in by a person (`npm run signin`) and holds its own saved
 * address and card inside Target's account — this flow only ever clicks
 * "add to cart" and, when live and verified, the final place-order button.
 * If Target asks for a sign-in or a card number instead of a cart, that is a
 * failure with a screenshot, never a form to fill. The same goes for the
 * card's security code (CVV): it is detected, named, and left for a person.
 *
 * And nothing here acts on a cart line it cannot tell is this mission's
 * product: the owner's own basket may hold other things (see findCartLine).
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
  // Verified at the sitting's second half (31 Aug 2026): probed in the real
  // signed-in buy profile — the cart button read "Check out", the review page
  // showed the saved card and address, and the place-order button was located,
  // boxed, photographed and approved by Roberto. It was never clicked; the
  // first click happens on a night he picks, live, armed, capped.
  checkoutButton: {
    candidates: ['[data-test="checkout-button"]'],
    verified: true,
  },
  placeOrder: {
    candidates: ['[data-test="placeOrderButton"]'],
    verified: true,
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

/** Which product a cart operation is about, so it never acts on another line. */
export interface CartItem {
  /** The retailer's own id. At Target, the TCIN. */
  externalId: string;
  url: string;
  name: string;
  /** How many of it this mission puts in the cart. */
  quantity: number;
}

/** Where a checkout stands while a person is being waited on. */
export type CheckoutState = 'confirmed' | 'security_code' | 'other';

export interface CartDriver {
  /** Put the item in the basket. The page must already be the product page. */
  addToCart(page: Page): Promise<void>;
  /**
   * Read what the cart says about THIS item. Null fields are refusals
   * downstream, and so is `otherItems` being anything but zero.
   */
  readCart(page: Page, item: CartItem): Promise<CartTotals>;
  /**
   * Take this item back out — dry runs must not leave a basket behind. Throws,
   * removing nothing, when the line cannot be told apart from the rest of the
   * cart or holds more than this mission put there.
   */
  removeFromCart(page: Page, item: CartItem): Promise<void>;
  /** The last click. Only ever called when live AND the selector is verified. */
  placeOrder(page: Page): Promise<void>;
  /** What the open checkout is showing, for a person-in-the-loop wait. */
  checkoutState?(page: Page): Promise<CheckoutState>;
}

/**
 * Target asked for the card's security code (CVV).
 *
 * ── Why this is its own error ───────────────────────────────────────────────
 *
 * The first live buy (31 Aug 2026) clicked Place Order and nothing happened:
 * "most likely a card-confirmation prompt swallowed the click". The
 * confirmation wait then ran out, threw a generic error, and the grant stayed
 * live for somebody to release by hand, with nobody told that a person could
 * have finished the order in the open window.
 *
 * A security code is a question for the card holder. Phantom never types it,
 * never stores it, and never clicks on past it. What it can do is say so,
 * loudly, and hold the window open (buy.ts does that).
 */
export class SecurityCodeNeeded extends CheckoutStepError {
  /** True when Place Order had already been clicked when the prompt was seen. */
  readonly afterClick: boolean;
  constructor(afterClick: boolean, screenshot: string) {
    super(
      'placeOrder',
      `Target is asking for the card's security code${afterClick ? ' after Place Order' : ''} — ` +
        `Phantom does not type it; a person must` +
        (screenshot ? `. What the page showed is in ${screenshot}` : ''),
      screenshot,
    );
    this.name = 'SecurityCodeNeeded';
    this.afterClick = afterClick;
  }
}

/**
 * Is a security-code (CVV) box showing?
 *
 * Runs INSIDE the page, so it must be self-contained: no imports, no closures.
 * Matches an input by what it says it is (autocomplete="cc-csc", or a name,
 * id, label, placeholder or data-test naming a CVV or security code), and
 * only when it is actually on screen. Never reads the box's value.
 */
export function securityCodeShowing(): boolean {
  const looksLikeCvv = /cc-csc|\bcvv\b|\bcvc\b|\bcsc\b|cvv|security[\s_-]*code|securitycode|card[\s_-]*verification/i;
  const inputs = Array.from(document.querySelectorAll('input'));
  for (const el of inputs) {
    const label = Array.from(el.labels ?? [])
      .map((l) => l.textContent ?? '')
      .join(' ');
    const said = [
      el.getAttribute('autocomplete'),
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('data-test'),
      label,
    ].join(' ');
    if (!looksLikeCvv.test(said)) continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
      return true;
    }
  }
  return false;
}

/**
 * Ask every frame, because a card field is the thing most often put in its
 * own iframe. Any frame that will not answer is a no from that frame, never
 * an error: this is a check, and a check that throws hides the real failure.
 */
async function securityCodeOn(page: Page): Promise<boolean> {
  // page.frames() includes the main frame, so asking each covers the page.
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  if (frames.length) {
    for (const f of frames) {
      if ((await f.evaluate(securityCodeShowing).catch(() => false)) === true) return true;
    }
    return false;
  }
  return (await page.evaluate(securityCodeShowing).catch(() => false)) === true;
}

/** The TCIN to look for in the cart, or null when the mission does not carry one. */
export function tcinOf(item: Pick<CartItem, 'externalId' | 'url'>): string | null {
  const id = String(item.externalId ?? '').trim();
  if (/^\d{5,}$/.test(id)) return id;
  const m = /\/A-(\d{5,})(?:\b|$)/.exec(String(item.url ?? ''));
  return m ? m[1]! : null;
}

/** What findCartLine says about the cart. */
export interface CartLines {
  /** Every line in the cart: one per quantity stepper. */
  lines: number;
  /** Lines that are this product and nothing else. One is the only good answer. */
  ours: number;
  /** Whether a single delete button belongs to our line alone (and is marked). */
  removable: boolean;
}

/**
 * Find this product's line in the cart and mark it.
 *
 * Runs INSIDE the page, so it must be self-contained: no imports, no
 * closures, nothing from module scope. Kept pure over a tiny slice of the DOM
 * (querySelectorAll, parentElement, getAttribute, setAttribute) so a test can
 * walk it over a fake cart.
 *
 * ── How a line is told apart ────────────────────────────────────────────────
 *
 * Each line has one quantity stepper (measured at the 31 Aug sitting). From a
 * stepper, climb to the nearest ancestor that holds a product link (a link
 * whose address carries "/A-<TCIN>"), giving up if the climb reaches anything
 * holding a second stepper first: that is the cart, not a line. The line is
 * ours when every product link in it is our TCIN. Then, from that line, the
 * delete button is the one at the nearest level that holds exactly one,
 * still never climbing into a second line.
 *
 * Before 19 Oct 2026 the driver read "the first quantity box" and clicked
 * "the first delete button", so a cart that already held something of the
 * owner's could be misread or have the wrong thing removed from it.
 */
export function findCartLine(arg: {
  tcin: string;
  marker: string;
  stepper: string;
  remove: string;
  /** Defaults to `document` in the page; a fake DOM in tests. */
  root?: unknown;
}): CartLines {
  type El = {
    parentElement: El | null;
    querySelectorAll(sel: string): ArrayLike<El>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };
  const root = (arg.root ?? document) as unknown as El;
  const steppers = Array.from(root.querySelectorAll(arg.stepper));
  const tcinsIn = (node: El): string[] => {
    const out: string[] = [];
    for (const a of Array.from(node.querySelectorAll('a[href]'))) {
      const m = /\/A-(\d{5,})(?:\b|$)/.exec(a.getAttribute('href') ?? '');
      if (m && !out.includes(m[1]!)) out.push(m[1]!);
    }
    return out;
  };
  const ours: El[] = [];
  for (const stepper of steppers) {
    let node = stepper.parentElement;
    while (node) {
      if (node.querySelectorAll(arg.stepper).length > 1) {
        node = null; // climbed into the cart without finding this line's product
        break;
      }
      const found = tcinsIn(node);
      if (found.length) {
        if (found.length === 1 && found[0] === arg.tcin) ours.push(node);
        break;
      }
      node = node.parentElement;
    }
  }
  const result: CartLines = { lines: steppers.length, ours: ours.length, removable: false };
  if (ours.length !== 1) return result;

  const line = ours[0]!;
  line.setAttribute('data-phantom-line', arg.marker);
  let scope: El | null = line;
  while (scope && scope.querySelectorAll(arg.stepper).length === 1) {
    const buttons = Array.from(scope.querySelectorAll(arg.remove));
    if (buttons.length === 1) {
      buttons[0]!.setAttribute('data-phantom-remove', arg.marker);
      result.removable = true;
      break;
    }
    if (buttons.length > 1) break;
    scope = scope.parentElement;
  }
  return result;
}

/** Find and mark this item's line. Null when the page would not answer. */
async function locateLine(page: Page, item: CartItem, marker: string): Promise<CartLines | null> {
  const tcin = tcinOf(item);
  if (!tcin) return null;
  return page
    .evaluate(findCartLine, {
      tcin,
      marker,
      stepper: TARGET_SELECTORS.cartItemQuantity.candidates[0]!,
      // The data-test one only. The text fallback ("Remove") is fine for
      // finding A delete button and wrong for finding THIS line's one.
      remove: TARGET_SELECTORS.removeItem.candidates[0]!,
    })
    .then((r) => (r && typeof r === 'object' && typeof (r as CartLines).lines === 'number' ? (r as CartLines) : null))
    .catch(() => null);
}

/** The quantity in our marked line's stepper, or null. */
async function lineQuantity(page: Page, marker: string): Promise<number | null> {
  try {
    const qty = page
      .locator(`[data-phantom-line="${marker}"] ${TARGET_SELECTORS.cartItemQuantity.candidates[0]!}`)
      .first();
    await qty.waitFor({ state: 'visible', timeout: 4000 });
    const text = (await qty.inputValue().catch(() => '')) || (await qty.innerText());
    return Number(String(text).replace(/[^0-9]/g, '')) || null;
  } catch {
    return null;
  }
}

/** A fresh marker per read, so a stale mark from an earlier read never matches. */
function newMarker(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Waiting on a real signal instead of on the clock.
 *
 * Every one of these was a fixed `waitForTimeout` — a flat sleep sized for the
 * worst case and paid on every buy, drop day or dead afternoon. Ten seconds of
 * it, mostly stacked on top of `find()`, which already waits for the element
 * it wants to be *visible*. So the rule now is: wait for the thing, capped, not
 * for a guess at how long the thing takes. Same requests, same politeness — the
 * only thing removed is the standing around, and in a drop the standing around
 * is the box.
 *
 * `settle` is a bounded network-quiet wait, not a sleep: it returns the instant
 * the page goes idle and only spends the whole budget when the page really is
 * slow. It never throws — a page that stays chatty is not a checkout failure,
 * and the self-verifying reads downstream are what actually gate the buy.
 */
const SETTLE = {
  /** After add-to-cart, before navigating away. readCart re-verifies the item
   *  actually landed, so this only has to let the add request dispatch. */
  afterAdd: 1500,
  /** After opening the order-summary accordion, before reading its lines. */
  afterToggle: 800,
  /** After clicking checkout, before looking for Place Order. `find` waits for
   *  the button on top of this, so it is a floor, not the whole wait. */
  afterCheckout: 1200,
  /** After removing an item. Nothing is racing a cleanup, but a flat sleep
   *  here is paid on every refused cart and every dry run. */
  afterRemove: 1200,
} as const;

/** How often, and for how long, to ask whether the order actually exists. */
const CONFIRM_POLL_MS = 400;
const CONFIRM_TIMEOUT_MS = 30_000;

async function settle(page: Page, maxMs: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: maxMs }).catch(() => {});
}

export const targetCart: CartDriver = {
  async addToCart(page) {
    const button = await find(page, 'addToCart');
    await button.click();
    // Let the add request go out, then move on the moment the page is quiet —
    // not a flat 2.5s. If it didn't land, readCart's own waits refuse the buy,
    // so this can be brief without risking a purchase of an empty cart.
    await settle(page, SETTLE.afterAdd);
  },

  async readCart(page, item) {
    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });

    // No flat wait here any more: every read below goes through `find`, which
    // waits for its element to be visible. A slow cart is caught by that wait;
    // a fast cart is read the instant it renders.

    // Open the order summary when it says it is shut. Soft on purpose: if
    // Target ever renders it open, or renames the toggle while leaving the
    // lines visible, reading still works — and if the lines stay hidden, the
    // reads below return nulls and verifyCart refuses, which is the correct
    // downstream fate for a cart we could not read.
    const toggle = page.locator(TARGET_SELECTORS.summaryToggle.candidates[0]!).first();
    if ((await toggle.getAttribute('aria-expanded').catch(() => null)) === 'false') {
      await toggle.click().catch(() => {});
      await settle(page, SETTLE.afterToggle);
    }

    // Wait for the cart to render a line at all, then find OURS. Nothing
    // below reads "the first" of anything any more.
    await find(page, 'cartItemQuantity');
    const marker = newMarker();
    const lines = await locateLine(page, item, marker);
    if (!lines || lines.ours !== 1) {
      // No line, two lines, or a line we cannot tell apart: every number on
      // this page is untrustworthy, and verifyCart refuses on otherItems null.
      return { unitPrice: null, quantity: null, tax: null, shipping: null, otherItems: null };
    }
    const otherItems = lines.lines - 1;
    const quantity = await lineQuantity(page, marker);
    if (otherItems > 0) {
      // The subtotal, tax and shipping are the whole cart's, so none of them
      // is this item's. verifyCart refuses on otherItems before reading them.
      return { unitPrice: null, quantity, tax: null, shipping: null, otherItems };
    }

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

    // Only our line is in the cart, so the cart's subtotal is our line's.
    const subtotal = await read('subtotal');
    return {
      unitPrice:
        subtotal !== null && quantity ? Math.round((subtotal / quantity) * 100) / 100 : null,
      quantity,
      tax: await read('tax'),
      shipping: await read('shipping'),
      otherItems,
    };
  },

  async removeFromCart(page, item) {
    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
    await find(page, 'cartItemQuantity');
    const marker = newMarker();
    const lines = await locateLine(page, item, marker);
    // Fail closed: when in doubt, the cart is left exactly as it is. An item
    // left in a basket costs nothing; a line of the owner's deleted does.
    if (!lines || lines.ours !== 1 || !lines.removable) {
      const shot = await screenshot(page, 'removeItem-unidentified');
      throw new CheckoutStepError(
        'removeItem',
        `could not tell which cart line is ${item.name}, so nothing was removed` +
          (shot ? `; what the page showed is in ${shot}` : ''),
        shot,
      );
    }
    // And only when the line holds what this mission put there. If the owner
    // already had one of these in the cart, the line now holds theirs and
    // ours, and deleting it would take theirs too.
    const quantity = await lineQuantity(page, marker);
    if (quantity !== Math.max(1, item.quantity || 1)) {
      throw new CheckoutStepError(
        'removeItem',
        `the cart line for ${item.name} holds ${quantity ?? 'an unreadable number'}, not the ` +
          `${Math.max(1, item.quantity || 1)} Phantom added, so it was left alone`,
        '',
      );
    }
    const remove = page.locator(`[data-phantom-remove="${marker}"]`).first();
    await remove.click();
    // The last flat sleep on this path. Same rule as the others: wait for the
    // page to go quiet, not for a guess at how long quiet takes. It matters
    // less here — nothing is racing a cleanup — but a 2s sleep on every
    // refused cart and every dry run is 2s of a drop window spent tidying.
    await settle(page, SETTLE.afterRemove);
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
    // A brief settle, then `find` waits for Place Order to be visible on top
    // of it — the flat 4s that used to sit here was spent waiting for a button
    // we were about to wait for anyway.
    await settle(page, SETTLE.afterCheckout);
    const place = await find(page, 'placeOrder');
    // A security-code box already on the review page means Place Order would
    // only bounce off it. Stop before the click; a person finishes this.
    if (await securityCodeOn(page)) {
      throw new SecurityCodeNeeded(false, await screenshot(page, 'placeOrder-securityCode'));
    }
    await place.click();

    // ── The click is not the order ──────────────────────────────────────────
    //
    // Learned on the first live buy (31 Aug 2026): this used to return right
    // here, and the caller recorded "bought". Target had not placed anything —
    // the pens were still in the cart, no email, no order — most likely a
    // card-confirmation prompt swallowed the click. The machine's one
    // unverified claim was the only one that mattered.
    //
    // So now the order exists only when the page says so. Deliberately loose
    // about HOW it says so — we have never seen Target's confirmation page,
    // and guessing one selector would be the sin this file exists to avoid —
    // and strict about the consequence: no confirmation within the wait means
    // a loud throw with a screenshot, the caller keeps the grant LIVE, and a
    // person checks the orders page. Fail closed on not knowing.
    const confirmed = (): Promise<boolean> => orderConfirmed(page);
    // Polled at 400ms, not 2.5s. The order is already submitted by this point,
    // so this is not a race — but a coarse poll means the machine can be up to
    // 2.1 seconds late to know it succeeded, and everything downstream (the
    // grant resolving to 'spent', the acquisition row, the log line a person
    // reads at 3am) waits on that. The budget is unchanged: still 30 seconds
    // before it gives up and shouts.
    for (let waited = 0; waited < CONFIRM_TIMEOUT_MS; waited += CONFIRM_POLL_MS) {
      await page.waitForTimeout(CONFIRM_POLL_MS);
      if (await confirmed()) return;
      // The prompt that most likely swallowed the 31 Aug click. Seen, it is
      // named at once rather than after thirty seconds of a generic wait.
      if (await securityCodeOn(page)) {
        throw new SecurityCodeNeeded(true, await screenshot(page, 'placeOrder-securityCode'));
      }
    }
    const shot = await screenshot(page, 'placeOrder-unconfirmed');
    throw new CheckoutStepError(
      'placeOrder',
      'clicked Place Order, but no confirmation appeared within 30s — the order may not ' +
        'have been placed. Check your Target orders page before releasing anything.' +
        (shot ? ` What the page showed is in ${shot}` : ''),
      shot,
    );
  },

  async checkoutState(page) {
    if (await orderConfirmed(page)) return 'confirmed';
    if (await securityCodeOn(page)) return 'security_code';
    return 'other';
  },
};

/**
 * Does the page say an order exists?
 *
 * Deliberately loose about HOW it says so (see placeOrder) and never throws:
 * a page that will not answer has not confirmed anything.
 */
async function orderConfirmed(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/thank|confirm|receipt/i.test(url)) return true;
  } catch {
    /* fall through to the text */
  }
  const text = await page
    .evaluate(() => document.body?.innerText?.slice(0, 6000) ?? '')
    .catch(() => '');
  return /thanks for your order|order placed|order number|we got your order|your order.s in/i.test(
    String(text),
  );
}
