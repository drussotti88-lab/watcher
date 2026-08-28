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
export function verifyCart(args: {
  watch: Watch;
  cartUnitPrice: number | null;
  cartQuantity: number | null;
  budget: Budget;
  spent: SpendLedger;
}): { ok: boolean; outcome: Outcome; note: string } {
  const { watch, cartUnitPrice, cartQuantity, budget, spent } = args;
  const wanted = Math.max(1, watch.quantity || 1);

  if (cartUnitPrice === null) {
    return { ok: false, outcome: 'failed', note: 'could not read the cart price' };
  }
  if (watch.ceiling === null || cartUnitPrice > watch.ceiling) {
    return {
      ok: false,
      outcome: 'price_exceeded',
      note: `cart says ${money(cartUnitPrice)}, ceiling is ${money(watch.ceiling ?? 0)}`,
    };
  }
  if (cartQuantity === null) {
    return { ok: false, outcome: 'failed', note: 'could not read the cart quantity' };
  }
  if (cartQuantity !== wanted) {
    return {
      ok: false,
      outcome: 'qty_unavailable',
      note: `cart has ${cartQuantity}, you asked for ${wanted}`,
    };
  }

  const total = round2(cartUnitPrice * cartQuantity);
  if (spent.run + total > budget.perRun || spent.day + total > budget.perDay) {
    return {
      ok: false,
      outcome: 'budget_exceeded',
      note: `cart total ${money(total)} breaks a spend cap`,
    };
  }

  return { ok: true, outcome: 'bought', note: `cart verified at ${money(total)}` };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** What every armed watch would cost if all of them fired. */
export function worstCase(watches: readonly Watch[]): number {
  return round2(
    watches
      .filter((w) => w.armed && w.ceiling !== null)
      .reduce((sum, w) => sum + w.ceiling! * Math.max(1, w.quantity || 1), 0),
  );
}
