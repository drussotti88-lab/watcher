/**
 * The buy attempt: what happens after judge() says everything is true.
 *
 * The order is the design, and every step can only make the answer safer:
 *
 *   1. Ask the Hub for a spend authorisation. The Hub owns the daily cap and
 *      the duplicate lock; an unreachable Hub is a NO. Nothing before this
 *      point has committed anything.
 *   2. Open the BUY profile — the signed-in one, used only here — put the item
 *      in the cart, and read what the cart actually says.
 *   3. verifyCart gets the final word. The product page's price was evidence;
 *      the cart's numbers are the charge.
 *   4. live && ok → place the order, resolve the grant 'spent' (which disarms
 *      the mission — one mission, one purchase). Anything else → take the item
 *      back out, release the grant, and record precisely why.
 *
 * A crash between add-to-cart and resolution leaves the grant live, which
 * keeps its money counted against the cap and blocks a second grant for the
 * mission. That is on purpose: a crash mid-checkout is exactly when nobody
 * knows whether money moved, and the wrong response to not knowing is to
 * authorise more. A person releases it from the app after looking at their
 * orders page.
 */
import type { Page } from 'playwright';
import type { Browser } from './browser.ts';
import type { Hub, Mission, RunOut } from './hub.ts';
import type { Reading } from './read.ts';
import type { Activity } from './activity.ts';
import { verifyCart, type CartTotals } from './money.ts';
import { targetCart, type CartDriver } from './checkout/target.ts';

export interface BuyDeps {
  hub: Hub;
  /** Opens the BUY profile. Constructed per attempt, closed in finally. */
  openBuyBrowser: () => Promise<{ page: () => Promise<Page>; close: () => Promise<void> }>;
  /** Per-retailer cart drivers. Only Target exists today, and that is stated. */
  drivers?: Partial<Record<string, CartDriver>>;
  /** False stops on the line before the button. The default, emphatically. */
  live: boolean;
  activity?: Activity;
  log?: (line: string) => void;
}

const DRIVERS: Partial<Record<string, CartDriver>> = { Target: targetCart };

/** Build the pass's `buyer` callback out of these dependencies. */
export function makeBuyer(deps: BuyDeps): (mission: Mission, reading: Reading) => Promise<RunOut> {
  return (mission, reading) => attemptBuy(deps, mission, reading);
}

/**
 * Where the seconds went.
 *
 * A drop is decided in the gap between "stock appeared" and "order placed",
 * and until this existed that gap was one opaque number — you could see a buy
 * took 14 seconds and not which part to fix. Every phase is marked, so the
 * next slow buy names its own bottleneck instead of inviting a guess.
 *
 * Deliberately plain: a clock and a list. Nothing here may throw, because a
 * stopwatch that can break a purchase is worse than no stopwatch.
 */
export interface Stopwatch {
  mark(phase: string): void;
  summary(): string;
  total(): number;
}

export function stopwatch(now: () => number = Date.now): Stopwatch {
  const started = now();
  let last = started;
  const marks: [string, number][] = [];
  return {
    mark(phase) {
      const at = now();
      marks.push([phase, at - last]);
      last = at;
    },
    summary() {
      const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
      const parts = marks.map(([phase, ms]) => `${phase} ${secs(ms)}`);
      return parts.length ? `${parts.join(' · ')} — ${secs(last - started)} total` : '';
    },
    total() {
      return last - started;
    },
  };
}

export async function attemptBuy(
  deps: BuyDeps,
  mission: Mission,
  reading: Reading,
): Promise<RunOut> {
  const log = deps.log ?? (() => {});
  const base = {
    missionId: mission.id,
    state: reading.state,
    price: reading.price,
    sellerKind: reading.seller.kind,
    sellerName: reading.seller.name,
  };
  // Started before the authorisation so the clock covers everything a drop
  // spends, not just the browser half.
  const clock = stopwatch();
  const record = (run: RunOut): RunOut => {
    const timing = clock.summary();
    deps.activity?.record({
      kind: 'buy',
      level: run.outcome === 'bought' || run.outcome === 'dry_run' ? 'info' : 'warn',
      retailer: mission.retailer,
      missionId: mission.id,
      ms: clock.total(),
      message: `${run.outcome}: ${run.reason}`,
      detail: timing,
    });
    if (timing) log(`  timing: ${timing}`);
    return run;
  };

  const driver = deps.drivers?.[mission.retailer] ?? DRIVERS[mission.retailer];
  if (!driver) {
    return record({
      ...base,
      outcome: 'declined',
      reason: `no checkout flow exists for ${mission.retailer} yet — Target is first, per the plan`,
    });
  }

  // ── 1. Permission, from the one place that can give it ─────────────────────
  const auth = await deps.hub.authorise(mission.id);
  clock.mark('authorise');
  if (!auth.granted) {
    return record({ ...base, outcome: auth.refusal, reason: auth.reason });
  }
  log(`  authorised $${auth.amount.toFixed(2)} for ${mission.productName} — opening the buy profile`);

  // ── 2–4. The cart, and what it costs to be wrong about it ─────────────────
  let browser: Awaited<ReturnType<BuyDeps['openBuyBrowser']>> | null = null;
  let inCart = false;
  try {
    browser = await deps.openBuyBrowser();
    const page = await browser.page();
    clock.mark('browser');

    await page.goto(mission.url, { waitUntil: 'domcontentloaded' });
    clock.mark('open');
    await driver.addToCart(page);
    clock.mark('cart');
    inCart = true;

    const cart: CartTotals = await driver.readCart(page);
    clock.mark('read');
    const check = verifyCart({
      watch: {
        id: String(mission.id),
        retailer: mission.retailer as never,
        externalId: mission.externalId,
        url: mission.url,
        name: mission.productName,
        armed: true,
        ceiling: mission.ceiling,
        quantity: Math.max(1, mission.quantity || 1),
      },
      cart,
      limits: {
        // The Hub's grant already enforced the daily cap; these bounds are the
        // per-order sanity check with the cart's own numbers.
        budget: { perRun: auth.amount, perDay: auth.amount },
        spent: { run: 0, day: 0 },
        shippingAllowance: deps.hub.settings.shippingAllowance,
      },
    });

    if (!check.ok) {
      await driver.removeFromCart(page).catch(() => {});
      inCart = false;
      await deps.hub.resolveAuthorisation(auth.id, 'released', `cart refused: ${check.note}`);
      return record({
        ...base,
        outcome: check.outcome === 'price_exceeded' ? 'price_exceeded' : 'declined',
        quantity: cart.quantity,
        total: check.total,
        reason: `the cart got the final word: ${check.note}`,
      });
    }

    if (!deps.live) {
      await driver.removeFromCart(page).catch(() => {});
      inCart = false;
      await deps.hub.resolveAuthorisation(auth.id, 'released', 'dry run — stopped before the button');
      return record({
        ...base,
        outcome: 'dry_run',
        quantity: cart.quantity,
        total: check.total,
        reason:
          `DRY RUN complete: cart verified at $${(check.total ?? 0).toFixed(2)} all-in, ` +
          `stopped on the line before the button. live: false is doing its job.`,
      });
    }

    // ── The click. Everything above this line was reversible. ────────────────
    //
    // placeOrder returns only once the page has CONFIRMED an order exists —
    // a click alone proved nothing on the first live attempt (31 Aug 2026:
    // "bought" recorded, pens still in the cart). If confirmation never
    // appears it throws, landing in the mid-checkout path below: the grant
    // stays live and a person checks the orders page. 'spent' is only ever
    // written about an order the retailer acknowledged.
    await driver.placeOrder(page);
    clock.mark('place');
    await deps.hub.resolveAuthorisation(
      auth.id,
      'spent',
      `bought ${cart.quantity} at $${(check.total ?? 0).toFixed(2)} all-in`,
    );
    return record({
      ...base,
      outcome: 'bought',
      quantity: cart.quantity,
      total: check.total,
      reason: `BOUGHT: ${cart.quantity} × ${mission.productName} at $${(check.total ?? 0).toFixed(2)} all-in`,
    });
  } catch (err) {
    // Something threw mid-flow. If the item never reached the cart, the grant
    // is safely releasable; if it did — or we cannot tell — the grant stays
    // live and a person looks. Fail closed on not knowing.
    const detail = (err as Error).message;
    if (!inCart) {
      await deps.hub.resolveAuthorisation(auth.id, 'released', `failed before the cart: ${detail}`);
      return record({ ...base, outcome: 'failed', reason: `buy failed before the cart: ${detail}` });
    }
    return record({
      ...base,
      outcome: 'failed',
      reason:
        `buy failed mid-checkout: ${detail} — the authorisation stays live and its money stays ` +
        `committed until you check your orders page and release it in the app`,
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}
