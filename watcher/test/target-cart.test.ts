/**
 * The Target cart driver's honest parts: the money parser and the two locks.
 *
 * The selectors themselves were measured at the sitting (31 Aug 2026) by
 * dumping every data-test attribute on a real cart — these tests pin what was
 * measured, so a casual edit cannot quietly turn a reading back into a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_SELECTORS, targetCart, moneyFrom, CheckoutStepError, SecurityCodeNeeded,
  securityCodeShowing, findCartLine, tcinOf, type CartItem,
} from '../src/checkout/target.ts';
import { verifyCart } from '../src/money.ts';

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
  /** When a security-code box is on screen: from the start, or once Place
   *  Order has been clicked. */
  cvv?: 'before' | 'after';
  /** Every selector clicked, in order. */
  clicked?: string[];
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
    evaluate: async (fn: unknown) => {
      if (fn === securityCodeShowing) {
        if (opts.cvv === 'before') return true;
        if (opts.cvv === 'after') return (opts.clicked ?? []).includes(TARGET_SELECTORS.placeOrder.candidates[0]);
        return false;
      }
      return opts.bodyText ?? 'Review your order and payment';
    },
    locator: (sel: string) => ({
      first: () => ({
        waitFor: async () => {},
        click: async () => {
          opts.clicked?.push(sel);
        },
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
  await targetCart.removeFromCart(
    fakeCartPage(cartOf(line(OURS, 1)), { settles, sleeps }),
    ITEM,
  );
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

// ── Only this product's line ─────────────────────────────────────────────────
//
// Until 19 Oct 2026 readCart read the FIRST quantity box and the whole-cart
// subtotal, and removeFromCart clicked the FIRST delete button. The buy
// profile is the owner's own signed-in Target account, so its cart is his
// cart: anything already in it could be misread as this item, judged as part
// of its price, deleted by a dry run, or bought along with it.

/** A tiny DOM: enough of querySelectorAll, parentElement and attributes. */
class El {
  tag: string;
  attrs: Record<string, string>;
  children: El[];
  parentElement: El | null = null;
  text: string;
  constructor(tag: string, attrs: Record<string, string> = {}, children: El[] = [], text = '') {
    this.tag = tag;
    this.attrs = { ...attrs };
    this.children = children;
    this.text = text;
    for (const c of children) c.parentElement = this;
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(sel: string): El[] {
    return this.descendants().filter((e) => matches(e, sel));
  }
}

function matches(e: El, sel: string): boolean {
  if (sel === 'a[href]') return e.tag === 'a' && e.getAttribute('href') !== null;
  const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (m) return e.getAttribute(m[1]!) === m[2];
  throw new Error(`the fake DOM does not understand ${sel}`);
}

const STEPPER = TARGET_SELECTORS.cartItemQuantity.candidates[0]!.replace(/^\[data-test="(.*)"\]$/, '$1');
const DELETE = TARGET_SELECTORS.removeItem.candidates[0]!.replace(/^\[data-test="(.*)"\]$/, '$1');

const OURS = '95267143';
const HIS = '88841234';
const ITEM: CartItem = {
  externalId: OURS,
  url: `https://www.target.com/p/-/A-${OURS}`,
  name: 'Chaos Rising ETB',
  quantity: 1,
};

/** One cart line, shaped like the measured one: link, stepper, delete. */
function line(tcin: string, qty: number): El {
  return new El('div', { class: 'line' }, [
    new El('div', {}, [new El('a', { href: `/p/some-thing/-/A-${tcin}` }, [], 'title')]),
    new El('div', {}, [
      new El('select', { 'data-test': STEPPER, value: String(qty) }),
      new El('button', { 'data-test': DELETE }),
    ]),
  ]);
}

function cartOf(...lines: El[]): El {
  return new El('body', {}, [
    new El('main', {}, lines),
    new El('aside', {}, [
      new El('div', { 'data-test': 'cart-summary-subTotal' }, [], 'Subtotal (1 item) $49.99'),
      new El('div', { 'data-test': 'cart-summary-taxes' }, [], 'Estimated taxes $4.87'),
      new El('div', { 'data-test': 'cart-summary-fulfillment' }, [], 'FREE'),
    ]),
  ]);
}

/** A page over the tiny DOM. Runs the driver's own in-page function on it. */
function fakeCartPage(
  root: El,
  opts: { clicked?: El[]; settles?: number[]; sleeps?: number[] } = {},
) {
  const resolve = (sel: string): El | null => {
    const scoped = /^(\[data-phantom-line="[^"]+"\]) (.+)$/.exec(sel);
    try {
      if (scoped) return root.querySelectorAll(scoped[1]!)[0]?.querySelectorAll(scoped[2]!)[0] ?? null;
      return root.querySelectorAll(sel)[0] ?? null;
    } catch {
      return null; // a selector the tiny DOM cannot evaluate is simply not there
    }
  };
  return {
    url: () => 'https://www.target.com/cart',
    goto: async () => {},
    waitForTimeout: async (ms: number) => {
      opts.sleeps?.push(ms);
    },
    waitForLoadState: async (_s: string, o?: { timeout?: number }) => {
      opts.settles?.push(o?.timeout ?? 0);
    },
    evaluate: async (fn: (a: unknown) => unknown, arg?: Record<string, unknown>) =>
      arg && 'tcin' in arg ? fn({ ...arg, root }) : '',
    locator: (sel: string) => ({
      first: () => ({
        waitFor: async () => {
          if (!resolve(sel)) throw new Error(`timeout waiting for ${sel}`);
        },
        click: async () => {
          const e = resolve(sel);
          if (!e) throw new Error(`nothing to click at ${sel}`);
          opts.clicked?.push(e);
        },
        isVisible: async () => resolve(sel) !== null,
        getAttribute: async (n: string) => resolve(sel)?.getAttribute(n) ?? null,
        inputValue: async () => resolve(sel)?.getAttribute('value') ?? '',
        innerText: async () => resolve(sel)?.text ?? '',
      }),
    }),
    screenshot: async () => {},
  } as never;
}

const args = (root: El, tcin = OURS) => ({
  tcin,
  marker: 'm1',
  stepper: TARGET_SELECTORS.cartItemQuantity.candidates[0]!,
  remove: TARGET_SELECTORS.removeItem.candidates[0]!,
  root,
});

test('the TCIN comes from the mission, or from its address', () => {
  assert.equal(tcinOf({ externalId: OURS, url: '' }), OURS);
  assert.equal(tcinOf({ externalId: '', url: `https://www.target.com/p/x/-/A-${OURS}?preselect=1` }), OURS);
  assert.equal(tcinOf({ externalId: '', url: 'https://www.target.com/cart' }), null);
});

test('THE CART LINE IS FOUND BY THE PRODUCT, NOT BY BEING FIRST', () => {
  // His item first, ours second: "the first quantity box" would be his.
  const his = line(HIS, 3);
  const ours = line(OURS, 1);
  const root = cartOf(his, ours);
  const found = findCartLine(args(root));
  assert.deepEqual(found, { lines: 2, ours: 1, removable: true });
  assert.equal(ours.getAttribute('data-phantom-line'), 'm1', 'ours is the line marked');
  assert.equal(his.getAttribute('data-phantom-line'), null, 'his is not');
  assert.equal(ours.querySelectorAll(`[data-test="${DELETE}"]`)[0]!.getAttribute('data-phantom-remove'), 'm1');
  assert.equal(his.querySelectorAll(`[data-test="${DELETE}"]`)[0]!.getAttribute('data-phantom-remove'), null);
});

test('a cart that does not hold this product finds nothing, rather than the nearest thing', () => {
  // The guard must refuse a case that should fail, or it is only a comment.
  assert.deepEqual(findCartLine(args(cartOf(line(HIS, 1)))), { lines: 1, ours: 0, removable: false });
  assert.deepEqual(findCartLine(args(cartOf())), { lines: 0, ours: 0, removable: false });

  // A one-line cart whose only line is his, on a page whose recommendations
  // link to ours: the link outside the line must not make his line ours.
  const root = new El('body', {}, [
    new El('main', {}, [line(HIS, 1)]),
    new El('section', {}, [new El('a', { href: `/p/x/-/A-${OURS}` })]),
  ]);
  assert.equal(findCartLine(args(root)).ours, 0);
});

test('a line that links to two products is not ours to act on', () => {
  const mixed = new El('div', {}, [
    new El('a', { href: `/p/x/-/A-${OURS}` }),
    new El('a', { href: `/p/y/-/A-${HIS}` }),
    new El('select', { 'data-test': STEPPER, value: '1' }),
    new El('button', { 'data-test': DELETE }),
  ]);
  assert.equal(findCartLine(args(cartOf(mixed))).ours, 0);
});

test('a line with no delete button of its own is found but not removable', () => {
  const bare = new El('div', {}, [
    new El('a', { href: `/p/x/-/A-${OURS}` }),
    new El('select', { 'data-test': STEPPER, value: '1' }),
  ]);
  const found = findCartLine(args(cartOf(bare, line(HIS, 1))));
  assert.equal(found.ours, 1);
  assert.equal(found.removable, false, 'his delete button is not ours to borrow');
});

test('READING A CART WITH ONLY THIS PRODUCT GIVES ITS NUMBERS', async () => {
  const cart = await targetCart.readCart(fakeCartPage(cartOf(line(OURS, 1))), ITEM);
  assert.deepEqual(cart, { unitPrice: 49.99, quantity: 1, tax: 4.87, shipping: 0, otherItems: 0 });
});

test('A CART HOLDING THE OWNER\'S OTHER THINGS IS NEVER JUDGED AS THIS ITEM', async () => {
  // His three of something, then ours. The subtotal is the whole cart's, so
  // it is not read as ours at all, and verifyCart refuses the cart by name.
  const cart = await targetCart.readCart(fakeCartPage(cartOf(line(HIS, 3), line(OURS, 1))), ITEM);
  assert.equal(cart.quantity, 1, 'our line\'s quantity, not his three');
  assert.equal(cart.otherItems, 1);
  assert.equal(cart.unitPrice, null, 'the subtotal is not this item\'s price');

  const v = verifyCart({
    watch: {
      id: '1', retailer: 'Target' as never, externalId: OURS, url: ITEM.url, name: ITEM.name,
      armed: true, ceiling: 60, quantity: 1,
    },
    cart,
    limits: { budget: { perRun: 100, perDay: 100 }, spent: { run: 0, day: 0 }, shippingAllowance: 5 },
  });
  assert.equal(v.ok, false);
  assert.match(v.note, /1 other item/);
  assert.match(v.note, /Place Order would buy it too/);
});

test('a cart where this product cannot be told apart reads as nothing at all', async () => {
  const cart = await targetCart.readCart(fakeCartPage(cartOf(line(HIS, 1))), ITEM);
  assert.deepEqual(cart, { unitPrice: null, quantity: null, tax: null, shipping: null, otherItems: null });
});

test('REMOVING TAKES OUT THIS PRODUCT\'S LINE AND NOTHING ELSE', async () => {
  const his = line(HIS, 3);
  const ours = line(OURS, 1);
  const clicked: El[] = [];
  await targetCart.removeFromCart(fakeCartPage(cartOf(his, ours), { clicked }), ITEM);
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0], ours.querySelectorAll(`[data-test="${DELETE}"]`)[0], 'our delete button');
});

test('A LINE THAT CANNOT BE IDENTIFIED IS LEFT ALONE — no removal, a loud refusal', async () => {
  const clicked: El[] = [];
  await assert.rejects(
    () => targetCart.removeFromCart(fakeCartPage(cartOf(line(HIS, 1)), { clicked }), ITEM),
    (e: unknown) => e instanceof CheckoutStepError && /nothing was removed/.test(e.message),
  );
  assert.equal(clicked.length, 0, 'his line was not touched');
});

test('A LINE HOLDING MORE THAN PHANTOM ADDED IS LEFT ALONE — some of it is the owner\'s', async () => {
  // He already had one; Phantom added one; the line says two. Deleting it
  // would take his as well.
  const clicked: El[] = [];
  await assert.rejects(
    () => targetCart.removeFromCart(fakeCartPage(cartOf(line(OURS, 2)), { clicked }), ITEM),
    (e: unknown) => e instanceof CheckoutStepError && /left alone/.test(e.message),
  );
  assert.equal(clicked.length, 0);
});

// ── The card's security code ─────────────────────────────────────────────────

test('A SECURITY-CODE BOX ON THE REVIEW PAGE STOPS THE BUY BEFORE THE CLICK', async () => {
  const clicked: string[] = [];
  await assert.rejects(
    () => targetCart.placeOrder(fakeCheckoutPage({ cvv: 'before', clicked })),
    (e: unknown) => e instanceof SecurityCodeNeeded && e.afterClick === false,
  );
  assert.ok(!clicked.includes(TARGET_SELECTORS.placeOrder.candidates[0]), 'Place Order was never clicked');
});

test('A SECURITY-CODE BOX AFTER PLACE ORDER IS NAMED AT ONCE, NOT AFTER THIRTY SECONDS', async () => {
  const clicked: string[] = [];
  const sleeps: number[] = [];
  await assert.rejects(
    () => targetCart.placeOrder(fakeCheckoutPage({ cvv: 'after', clicked, sleeps })),
    (e: unknown) => e instanceof SecurityCodeNeeded && e.afterClick === true && /security code/.test(e.message),
  );
  assert.equal(clicked.filter((c) => c === TARGET_SELECTORS.placeOrder.candidates[0]).length, 1, 'clicked once');
  assert.ok(sleeps.reduce((a, b) => a + b, 0) < 5_000, 'seen on the first polls');
});

test('the checkout state says what a person would see', async () => {
  assert.equal(await targetCart.checkoutState!(fakeCheckoutPage({ bodyText: 'Thanks for your order!' })), 'confirmed');
  assert.equal(await targetCart.checkoutState!(fakeCheckoutPage({ cvv: 'before' })), 'security_code');
  assert.equal(await targetCart.checkoutState!(fakeCheckoutPage({})), 'other');
});

test('A CVV BOX IS RECOGNISED BY WHAT IT SAYS IT IS, AND ONLY WHEN IT IS ON SCREEN', () => {
  // securityCodeShowing runs inside the page, so it reads `document`; here a
  // stand-in document of inputs is enough. Note what it never touches: the
  // box's value.
  const input = (attrs: Record<string, string>, opts: { label?: string; hidden?: boolean } = {}) => ({
    getAttribute: (n: string) => attrs[n] ?? null,
    labels: opts.label ? [{ textContent: opts.label }] : [],
    getBoundingClientRect: () => (opts.hidden ? { width: 0, height: 0 } : { width: 80, height: 30 }),
    get value(): string {
      throw new Error('the value must never be read');
    },
  });
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
  const run = (inputs: unknown[]): boolean => {
    g.document = { querySelectorAll: () => inputs };
    g.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    try {
      return securityCodeShowing();
    } finally {
      g.document = saved.document;
      g.getComputedStyle = saved.getComputedStyle;
    }
  };
  assert.equal(run([input({ autocomplete: 'cc-csc' })]), true);
  assert.equal(run([input({ name: 'cvv' })]), true);
  assert.equal(run([input({ 'aria-label': 'Security code' })]), true);
  assert.equal(run([input({ id: 'x' }, { label: 'CVV' })]), true);
  // And the cases that must not count.
  assert.equal(run([input({ autocomplete: 'cc-csc' }, { hidden: true })]), false, 'a hidden box is not a prompt');
  assert.equal(run([input({ name: 'promoCode', 'aria-label': 'Promo code' })]), false);
  assert.equal(run([input({ name: 'zip' })]), false);
  assert.equal(run([]), false);
});
