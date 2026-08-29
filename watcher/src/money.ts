/**
 * The money rails. Pure functions — no browser, no network, no clock of its own.
 *
 * This is the part that must be right, because everything it guards against
 * happens at 3am while you're asleep. Each rule below maps to a specific way an
 * unattended buyer loses money, and each one is tested.
 */
import type { Observation, Outcome, Watch } from './types.ts';

export interface Budget {
  /** Most this single run may spend across all watches. */
  perRun: number;
  /** Most that may be spent in a rolling 24 hours. */
  perDay: number;
}

export interface SpendLedger {
  /** Already committed during this run. */
  run: number;
  /** Already committed in the last 24h, from the Hub. */
  day: number;
}

export interface Decision {
  buy: boolean;
  outcome: Outcome;
  unitPrice: number | null;
  quantity: number;
  total: number | null;
  note: string;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Should we buy this, right now, given what we just saw and what we've already
 * spent?
 *
 * Deliberately returns a reason in every branch — a refusal you can't explain
 * is a refusal you'll be tempted to remove.
 */
export function decide(args: {
  watch: Watch;
  observation: Observation;
  budget: Budget;
  spent: SpendLedger;
  /** External ids already bought in this run — the duplicate guard. */
  alreadyBought: ReadonlySet<string>;
  /** When false, everything stops short of submitting. */
  live: boolean;
  /** False when the Hub could not be reached to authorise. */
  authorised: boolean;
}): Decision {
  const { watch, observation, budget, spent, alreadyBought, live, authorised } = args;
  const qty = Math.max(1, watch.quantity || 1);
  const none = (outcome: Outcome, note: string): Decision => ({
    buy: false,
    outcome,
    unitPrice: observation.price,
    quantity: qty,
    total: null,
    note,
  });

  // A challenge page tells us nothing about stock. Never act on it.
  if (observation.challenged) {
    return none('blocked', 'page was a bot challenge, not a product page');
  }

  if (!watch.armed) {
    return none('not_authorised', 'watch is not armed');
  }

  // Duplicate guard: the single worst failure is buying the same thing N times
  // because the loop ran N times.
  if (alreadyBought.has(watch.externalId)) {
    return none('duplicate_prevented', 'already bought in this run');
  }

  if (observation.state !== 'in') {
    return none('sold_out', `stock reads "${observation.state}"`);
  }

  // Never buy on a guess. If the reader isn't sure it's in stock, it isn't.
  if (observation.confidence === 'unknown') {
    return none('sold_out', 'stock state was not read confidently');
  }

  if (watch.ceiling === null || watch.ceiling <= 0) {
    return none('not_authorised', 'armed watch has no price ceiling');
  }

  // No visible price means we cannot honour the ceiling. Refuse rather than
  // find out what it cost afterwards.
  if (observation.price === null) {
    return none('price_exceeded', 'no price visible; cannot verify the ceiling');
  }

  if (observation.price > watch.ceiling) {
    return none(
      'price_exceeded',
      `${money(observation.price)} is over your ceiling of ${money(watch.ceiling)}`,
    );
  }

  const total = round2(observation.price * qty);

  if (spent.run + total > budget.perRun) {
    return none(
      'budget_exceeded',
      `${money(total)} would take this run to ${money(spent.run + total)}, ` +
        `over the per-run cap of ${money(budget.perRun)}`,
    );
  }

  if (spent.day + total > budget.perDay) {
    return none(
      'budget_exceeded',
      `${money(total)} would take today to ${money(spent.day + total)}, ` +
        `over the daily cap of ${money(budget.perDay)}`,
    );
  }

  // Fail closed on spending: if the Hub could not authorise, do not buy.
  // Watching continues regardless; only the money stops.
  if (!authorised) {
    return none('not_authorised', 'hub did not authorise the spend');
  }

  if (!live) {
    return {
      buy: false,
      outcome: 'dry_run',
      unitPrice: observation.price,
      quantity: qty,
      total,
      note: `would buy ${qty} at ${money(observation.price)} = ${money(total)}`,
    };
  }

  return {
    buy: true,
    outcome: 'bought',
    unitPrice: observation.price,
    quantity: qty,
    total,
    note: `buying ${qty} at ${money(observation.price)} = ${money(total)}`,
  };
}

/**
 * Last gate, run against what the CART actually says immediately before submit.
 *
 * The product page and the cart can disagree — price moves, quantity silently
 * changes. Whatever the page said earlier is not evidence about what you are
 * about to be charged.
 */
/**
 * What the cart actually says, once everything is added up.
 *
 * Read from the checkout page rather than inferred, because the whole point of
 * this check is that the listed price was never the amount that leaves your
 * account.
 */
export interface CartTotals {
  /** Per unit, before tax — what the listing advertised. */
  unitPrice: number | null;
  quantity: number | null;
  /** Sales tax on the whole order. */
  tax: number | null;
  /** Postage on the whole order. Zero is a real answer; null is not. */
  shipping: number | null;
}

export interface CartLimits {
  budget: Budget;
  spent: SpendLedger;
  /** Account-wide, per order. Not part of the ceiling — see below. */
  shippingAllowance: number;
}

/**
 * The last gate before money moves.
 *
 * ── What the ceiling means ──────────────────────────────────────────────────
 *
 * The most to pay **per unit, including tax**. Not the listed price: a listed
 * price is always pre-tax, and pre-tax is not what leaves your account.
 *
 * ── Why shipping is not in it ───────────────────────────────────────────────
 *
 * Shipping is charged per order and the ceiling is per unit, so the two cannot
 * be added without lying about one of them. Guppy's answer is a "+$15 shipping
 * buffer" bolted onto the max price, which turns a $30 ceiling into $45 while
 * the mission log still says $30. Here they stay separate: the ceiling covers
 * the goods and the tax on them, and postage is checked against its own
 * account-wide allowance, so a refusal can say which one was too much.
 */
export function verifyCart(args: {
  watch: Watch;
  cart: CartTotals;
  limits: CartLimits;
}): { ok: boolean; outcome: Outcome; note: string; total: number | null } {
  const { watch, cart, limits } = args;
  const wanted = Math.max(1, watch.quantity || 1);
  const no = (outcome: Outcome, note: string): {
    ok: boolean;
    outcome: Outcome;
    note: string;
    total: number | null;
  } => ({ ok: false, outcome, note, total: null });

  if (cart.unitPrice === null) return no('failed', 'could not read the cart price');
  if (cart.quantity === null) return no('failed', 'could not read the cart quantity');
  if (cart.quantity !== wanted) {
    return no('qty_unavailable', `cart has ${cart.quantity}, you asked for ${wanted}`);
  }
  if (watch.ceiling === null) {
    return no('price_exceeded', 'this watch has no price ceiling, so nothing authorises a purchase');
  }

  // Fail closed on an unreadable number. A missing tax line is not zero tax;
  // it is a checkout page we did not understand, and the ceiling is defined in
  // terms of it.
  if (cart.tax === null) {
    return no('failed', 'could not read the tax, and the ceiling is defined including it');
  }
  if (cart.shipping === null) return no('failed', 'could not read the shipping cost');

  const goods = round2(cart.unitPrice * cart.quantity);
  const withTax = round2(goods + cart.tax);
  const perUnit = round2(withTax / cart.quantity);

  if (perUnit > watch.ceiling) {
    return no(
      'price_exceeded',
      `${money(perUnit)} per unit with tax (${money(cart.unitPrice)} + ` +
        `${money(round2(cart.tax / cart.quantity))} tax) is over the ` +
        `${money(watch.ceiling)} ceiling`,
    );
  }

  if (cart.shipping > limits.shippingAllowance) {
    return no(
      'shipping_exceeded',
      `shipping is ${money(cart.shipping)} and the allowance is ` +
        `${money(limits.shippingAllowance)}`,
    );
  }

  // The caps are on money out of the door, so they see the whole order.
  const total = round2(withTax + cart.shipping);
  if (limits.spent.run + total > limits.budget.perRun) {
    return no('budget_exceeded', `${money(total)} would break the ${money(limits.budget.perRun)} per-run cap`);
  }
  if (limits.spent.day + total > limits.budget.perDay) {
    return no('budget_exceeded', `${money(total)} would break the ${money(limits.budget.perDay)} daily cap`);
  }

  return {
    ok: true,
    outcome: 'bought',
    note:
      `cart verified: ${cart.quantity} x ${money(cart.unitPrice)} + ` +
      `${money(cart.tax)} tax + ${money(cart.shipping)} shipping = ${money(total)}`,
    total,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What every armed watch would cost if all of them fired.
 *
 * The shipping allowance counts once per armed watch, because each is a
 * separate order. Leaving it out understates the night by exactly the amount
 * nobody budgets for.
 */
export function worstCase(watches: readonly Watch[], shippingAllowance = 0): number {
  const armed = watches.filter((w) => w.armed && w.ceiling !== null);
  return round2(
    armed.reduce((sum, w) => sum + w.ceiling! * Math.max(1, w.quantity || 1), 0) +
      armed.length * shippingAllowance,
  );
}
