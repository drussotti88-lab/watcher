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
import { detectChallenge } from './challenge.ts';
import { targetCart, SecurityCodeNeeded, type CartDriver, type CartItem, type CheckoutState } from './checkout/target.ts';

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
  /** How long to hold the window open for a person. Injectable for tests. */
  humanWaitMs?: number;
  humanPollMs?: number;
  waitMs?: (ms: number) => Promise<void>;
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

/**
 * Is the buy window showing a challenge rather than a shop?
 *
 * Reads the same detector the watch path uses, so "press and hold", a queue,
 * an Access Denied and an empty Imperva shell are named the same way in both
 * halves of the system.
 *
 * Never throws: this runs inside a catch block, and a diagnostic that can
 * itself fail replaces a bad error message with a worse one.
 */
async function challengeOn(browser: { page: () => Promise<Page> }): Promise<string | null> {
  try {
    const page = await browser.page();
    const [title, text, html] = await Promise.all([
      page.title().catch(() => ''),
      page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '').catch(() => ''),
      page.content().catch(() => ''),
    ]);
    const c = detectChallenge(title, text, html);
    return c.challenged ? c.reason : null;
  } catch {
    return null;
  }
}

/**
 * Hold the window open and wait for a person to answer.
 *
 * ── The line this sits on ───────────────────────────────────────────────────
 *
 * A press-and-hold is a question addressed to a human, and this code will
 * never answer one. What it can do is not throw the opportunity away: the
 * browser is open on somebody's desk, they can see the same page, and if they
 * clear it the drop is still live. Waiting for a person is the opposite of
 * defeating a check — it is the check working exactly as intended.
 *
 * Two minutes, because a drop rarely outlasts that and a grant held open on a
 * machine nobody is sitting at is money committed to nothing.
 */
const HUMAN_WAIT_MS = 120_000;
const HUMAN_POLL_MS = 2_000;

async function waitForHuman(
  browser: { page: () => Promise<Page> },
  deps: BuyDeps,
): Promise<boolean> {
  const log = deps.log ?? (() => {});
  const waited = deps.waitMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = deps.humanWaitMs ?? HUMAN_WAIT_MS;
  const poll = deps.humanPollMs ?? HUMAN_POLL_MS;

  for (let spent = 0; spent < budget; spent += poll) {
    await waited(poll);
    if ((await challengeOn(browser)) === null) return true;
    // Say it again as the clock runs down. Once at the top of a scrolling log
    // is too quiet for the one line that needs a person to move.
    if (spent > 0 && spent % 20_000 < poll) {
      log(`  still waiting on the check — ${Math.round((budget - spent) / 1000)}s left`);
    }
  }
  return false;
}

/** Our security-code error, by class or by name (a test fake may only carry the name). */
function isSecurityCode(err: unknown): boolean {
  return err instanceof SecurityCodeNeeded || (err as { name?: string } | null)?.name === 'SecurityCodeNeeded';
}

/**
 * Target wants the card's security code. Say so, hold the window open for a
 * person, and settle the grant by what the page shows when the wait ends.
 *
 * ── The line this sits on ───────────────────────────────────────────────────
 *
 * Phantom never types a security code, never reads one, and never clicks on
 * past the box. The person types it and presses Place Order themselves, in
 * the window already open on their desk; all this does is watch for the
 * result. Same shape as the press-and-hold wait above, for the same reason.
 *
 * ── How the grant ends ──────────────────────────────────────────────────────
 *
 *   - The page confirms an order: SPENT. A person finished it, and the order
 *     exists, so the money did move.
 *   - The box is still there when the wait runs out: RELEASED. With the box
 *     unanswered the order cannot have gone through, so nothing was bought.
 *     Our item is taken back out of the cart (only our line; see the driver).
 *   - The box went away but no confirmation came: left LIVE. That is the one
 *     case where nobody can tell whether an order was placed, and releasing it
 *     would let a second buy through on top of one that may exist. A person
 *     checks the orders page, as for any mid-checkout failure.
 */
async function securityCodeHold(
  deps: BuyDeps,
  ctx: {
    mission: Mission;
    base: Omit<RunOut, 'outcome' | 'reason'>;
    record: (run: RunOut) => RunOut;
    clock: Stopwatch;
    page: Page;
    driver: CartDriver;
    authId: number;
    tidy: (p: Page) => Promise<string>;
    afterClick: boolean;
  },
): Promise<RunOut> {
  const { mission, base, record, clock, page, driver, authId } = ctx;
  const log = deps.log ?? (() => {});
  const waited = deps.waitMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = deps.humanWaitMs ?? HUMAN_WAIT_MS;
  const poll = deps.humanPollMs ?? HUMAN_POLL_MS;
  const stateOf = async (): Promise<CheckoutState> => {
    if (!driver.checkoutState) return 'other';
    return driver.checkoutState(page).catch((): CheckoutState => 'other');
  };

  log(
    `  ${mission.retailer} wants the card's SECURITY CODE — type it and press Place Order ` +
      `yourself in the open window. Phantom will not type it. I will wait.`,
  );
  deps.activity?.record({
    kind: 'buy',
    level: 'error',
    retailer: mission.retailer,
    missionId: mission.id,
    message: `HUMAN NEEDED: ${mission.retailer} is asking for the card's security code`,
    detail:
      'the buy window is open on this machine — type the code and place the order there; ' +
      'Phantom never types it',
  });

  let state: CheckoutState = 'security_code';
  for (let spent = 0; spent < budget; spent += poll) {
    await waited(poll);
    state = await stateOf();
    if (state === 'confirmed') break;
    if (spent > 0 && spent % 20_000 < poll) {
      log(`  still waiting on the security code — ${Math.round((budget - spent) / 1000)}s left`);
    }
  }
  clock.mark('human');

  if (state === 'confirmed') {
    await deps.hub.resolveAuthorisation(authId, 'spent', 'bought; a person entered the security code');
    return record({
      ...base,
      outcome: 'bought',
      reason:
        `BOUGHT: ${mission.productName} — ${mission.retailer} asked for the card's security code, ` +
        `you entered it, and the order was confirmed`,
    });
  }

  if (state === 'security_code') {
    const left = await ctx.tidy(page);
    await deps.hub.resolveAuthorisation(authId, 'released', 'security code went unanswered');
    return record({
      ...base,
      outcome: 'blocked',
      reason:
        `${mission.retailer} asked for the card's security code and nobody entered it in time. ` +
        `Nothing was bought and the money is released. Phantom never types a security code.${left}`,
    });
  }

  return record({
    ...base,
    outcome: 'failed',
    reason:
      `${mission.retailer} asked for the card's security code; the box went away but no order ` +
      `confirmation appeared${ctx.afterClick ? ' after Place Order' : ''}. The authorisation stays ` +
      `live and its money stays committed until you check your orders page and release it in the app`,
  });
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
    // Carried on every run, not only the bought one, so a DECLINED pre-order
    // is still legible later as "we refused a pre-order" rather than as an
    // unexplained refusal. It is the reading's own answer at the moment the
    // mission acted, which is the only moment this question has a fixed
    // answer.
    isPreOrder: reading.preOrder.isPreOrder === true,
    releaseDate: reading.preOrder.releaseDate ?? null,
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
  let page: Page | null = null;
  let inCart = false;
  // Which product every cart step is about. The owner's own Target cart may
  // hold other things, and nothing here may read or remove those.
  const item: CartItem = {
    externalId: mission.externalId,
    url: mission.url,
    name: mission.productName,
    quantity: Math.max(1, mission.quantity || 1),
  };
  /**
   * Take our item back out, and say so when that could not be done safely.
   * Never throws: tidying up must not turn a clean refusal into a failure.
   */
  const tidy = async (p: Page): Promise<string> => {
    try {
      await driver.removeFromCart(p, item);
      return '';
    } catch (err) {
      return ` (left in your Target cart: ${(err as Error).message})`;
    }
  };
  try {
    browser = await deps.openBuyBrowser();
    page = await browser.page();
    clock.mark('browser');

    await page.goto(mission.url, { waitUntil: 'domcontentloaded' });
    clock.mark('open');
    await driver.addToCart(page);
    clock.mark('cart');
    inCart = true;

    const cart: CartTotals = await driver.readCart(page, item);
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
      const left = await tidy(page);
      inCart = false;
      await deps.hub.resolveAuthorisation(auth.id, 'released', `cart refused: ${check.note}`);
      return record({
        ...base,
        outcome: check.outcome === 'price_exceeded' ? 'price_exceeded' : 'declined',
        quantity: cart.quantity,
        total: check.total,
        reason: `the cart got the final word: ${check.note}${left}`,
      });
    }

    if (!deps.live) {
      const left = await tidy(page);
      inCart = false;
      await deps.hub.resolveAuthorisation(auth.id, 'released', 'dry run — stopped before the button');
      return record({
        ...base,
        outcome: 'dry_run',
        quantity: cart.quantity,
        total: check.total,
        reason:
          `DRY RUN complete: cart verified at $${(check.total ?? 0).toFixed(2)} all-in, ` +
          `stopped on the line before the button. live: false is doing its job.${left}`,
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
    // ── The card's security code ────────────────────────────────────────────
    //
    // Checked first because it is our own, specific error: the driver has
    // already looked at the page and seen a CVV box. Before 19 Oct 2026 this
    // case was a thirty-second wait ending in a generic throw, the grant left
    // live for somebody to release by hand, and nobody told that the order
    // could still be finished in the open window.
    if (isSecurityCode(err) && browser && page) {
      return await securityCodeHold(deps, {
        mission,
        base,
        record,
        clock,
        page,
        driver,
        authId: auth.id,
        tidy,
        afterClick: (err as SecurityCodeNeeded).afterClick === true,
      });
    }

    // ── Was it a wall, or was it us? ────────────────────────────────────────
    //
    // On the first live drop rehearsal (1 Sep 2026) addToCart threw "none of
    // [data-test=addToCartButton] … appeared — the selector table needs the
    // sitting". Every word of that was wrong about the cause: the selectors
    // were fine, and what the page was showing was Target's press-and-hold
    // check. A message that blames our own code sends you off rewriting a
    // selector table while the drop happens without you.
    //
    // So before anything else, look at what the page actually is.
    const challenge = browser ? await challengeOn(browser) : null;
    if (challenge) {
      // We do not answer these, and we are not going to. A press-and-hold is a
      // question addressed to a person, and the browser it is asked in is open
      // on that person's desk — so the honest move is to say so loudly, hold
      // the window open, and carry on if they answer it in time.
      const detail = (err as Error).message;
      log(`  ${challenge} at ${mission.retailer} — ANSWER IT IN THE OPEN WINDOW, I will wait`);
      deps.activity?.record({
        kind: 'buy',
        level: 'error',
        retailer: mission.retailer,
        missionId: mission.id,
        message: `HUMAN NEEDED: ${mission.retailer} is asking for ${challenge}`,
        detail: 'the buy window is open on this machine — answer it there and the buy continues',
      });

      const cleared = await waitForHuman(browser!, deps);
      clock.mark('human');
      if (!cleared) {
        await deps.hub.resolveAuthorisation(
          auth.id,
          'released',
          `${challenge} went unanswered`,
        );
        return record({
          ...base,
          outcome: 'blocked',
          reason:
            `${mission.retailer} put up ${challenge} and nobody answered it in time. ` +
            `Nothing was bought and the money is released. This is a question for a ` +
            `person, and it is not one this machine will ever answer for you.`,
        });
      }
      // Answered. The grant is released rather than reused, and the next pass
      // does the buy properly from the top.
      //
      // Deliberately NOT an inline retry. Re-running the cart flow from inside
      // a catch block is a second path to the button that no test walks, and
      // the button is the one place in this system where being clever costs
      // real money. The next check is seconds away now that a pass drains its
      // list, and it re-reads the page, re-authorises, and lets the cart have
      // the final word on the price — none of which should be skipped just
      // because we were already most of the way there.
      log('  cleared — the next check will do the buy properly');
      await deps.hub.resolveAuthorisation(auth.id, 'released', `${challenge} cleared by a person`);
      return record({
        ...base,
        outcome: 'blocked',
        reason:
          `${mission.retailer} asked for ${challenge} and you cleared it. Nothing was bought on ` +
          `this attempt — the next check starts again from the page, which is the only way the ` +
          `cart still gets the final word on the price.`,
      });
    }

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
