/**
 * The loop.
 *
 * Pull the missions the Hub says are active, check whichever is due and whose
 * retailer will have us, report what was seen, and — when something actually
 * happened — record a run saying what and why.
 *
 * ── What a run is, and is not ────────────────────────────────────────────────
 *
 * Not one row per poll. A mission checking a static product every minute for a
 * week would bury the four rows that matter under ten thousand saying "still
 * out of stock". A run is written when the mission *did something or could
 * not*: stock appeared, or the page could not be read.
 *
 * ── On buying ────────────────────────────────────────────────────────────────
 *
 * Nothing here buys anything, and the reason is not caution in the abstract:
 * the checkout flow does not exist yet, and it is the one part that has to be
 * written with a browser open and a person watching. An armed mission that
 * finds stock therefore records `declined` with a reason saying exactly that,
 * which is honest, and leaves a run in the history you can point at later to
 * check the detection half worked.
 */
import type { Browser } from './browser.ts';
import { isQueue, queueScope } from './challenge.ts';
import { DEFAULT_SETTINGS, type Hub, type Mission, type ObservationOut, type RunOut, type Settings } from './hub.ts';
import { Pacer, isDue, nextUp } from './rate.ts';
import { quietInterval } from './quiet.ts';
import { readListing, type Reading } from './read.ts';
import type { Activity } from './activity.ts';
import { unknownRead } from './readers/types.ts';

/**
 * The stock-loaded alarm's thresholds.
 *
 * Target loads a scheduled drop's inventory into the shipping ATP field hours
 * before the page turns buyable (proven 1 Sep 2026: "30k+" was readable the
 * evening before a 3am drop — in the window this Phantom happened to be off).
 * The field is already read on every check, so the alarm costs no traffic at
 * all — it is a comparison, not a probe.
 *
 * 100 as the trip line, not 1: quantities of 8–20 are ordinary shelf stock
 * (and 20 is display-capped), so alerting on those would cry wolf weekly. A
 * drop load-in arrives as hundreds to tens of thousands. The prior must be
 * small so a live drop draining 30k → 20k → 90 → 0 fires nothing on the way
 * down and once — at most — on the way up.
 */
export const STOCK_LOADED_MIN = 100;
export const STOCK_LOADED_PRIOR_MAX = 50;

/** Did warehouse stock just appear where there was none? The drop precursor. */
export function stockLoaded(
  prev: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return (next ?? 0) >= STOCK_LOADED_MIN && (prev ?? 0) <= STOCK_LOADED_PRIOR_MAX;
}

export interface Verdict {
  /** Post this reading to the Hub? Almost always yes. */
  observation: ObservationOut;
  /** Record a run? Only when something happened. */
  run: RunOut | null;
  /**
   * Everything a purchase needs is true, says the detection side.
   *
   * A verdict, not an action: judge() stays pure, and whether anything is
   * actually bought is the pass's business — authorisation from the Hub first,
   * then the cart, then the cart's own numbers get the final word.
   */
  buy?: { unitPrice: number; quantity: number } | null;
}

/**
 * Turn a reading into what the Hub should be told.
 *
 * Deliberately pure and deliberately separate from the loop: this is where the
 * judgements live, so they can be tested without a browser, a clock or a
 * network.
 */
export function judge(
  mission: Mission,
  reading: Reading,
  settings: Settings = DEFAULT_SETTINGS,
): Verdict {
  const observation: ObservationOut = {
    listingId: mission.listingId,
    productName: reading.name,
    state: reading.state,
    confidence: reading.confidence,
    price: reading.price,
    sellerKind: reading.seller.kind,
    sellerName: reading.seller.name,
    availableQuantity: reading.availableQuantity,
    orderLimit: reading.orderLimit,
    addToCart: reading.addToCart,
    isPreOrder: reading.preOrder.isPreOrder,
    releaseDate: reading.preOrder.releaseDate,
    imageUrl: reading.imageUrl,
    note: reading.note,
  };

  const base = {
    missionId: mission.id,
    state: reading.state,
    price: reading.price,
    sellerKind: reading.seller.kind,
    sellerName: reading.seller.name,
    // On every run, not only the bought one. A pre-order that was DECLINED is
    // then legible later as exactly that, rather than as an unexplained
    // refusal — and the answer is the page's own, at the moment the mission
    // acted, which is the only moment it is fixed.
    isPreOrder: reading.preOrder.isPreOrder === true,
    releaseDate: reading.preOrder.releaseDate ?? null,
  };

  // ── Somebody else's mission ───────────────────────────────────────────────
  //
  // This Phantom pulls the union of every enabled mission so one read serves
  // everyone watching that listing. The reading is shared — it is a fact about
  // the world — but everything downstream of it belongs to the person whose
  // mission it is: a run row is *their* history, and arming is *their* money.
  //
  // So a read-only mission stops here. The observation still goes to the Hub,
  // where it lands on the listing and every mission on that listing sees it.
  // No run, and no buy verdict, ever.
  if (mission.readOnly) return { observation, run: null };

  // A challenge is about us, not the product. Worth a run: it is the thing you
  // want to see when the numbers stop moving. A QUEUE is the exception — that
  // one is about the product: retailers put up waiting rooms when something
  // is dropping, so its run says so instead of apologising.
  if (reading.challenged) {
    const reason = isQueue(reading.challengeReason)
      ? 'waiting room is up — a drop may be live, get in line yourself now'
      : `${reading.challengeReason} — standing down`;
    return {
      observation,
      run: { ...base, outcome: 'blocked', reason },
    };
  }

  // An unreadable page is a failure with a reason, never a silent "out of stock".
  if (reading.confidence === 'unknown' && reading.state === 'unknown') {
    return {
      observation,
      run: { ...base, outcome: 'failed', reason: reading.note || 'the page could not be read' },
    };
  }

  // Out of stock is the normal case and the whole point of not logging it.
  if (reading.state !== 'in') return { observation, run: null };

  // ── In stock. Now the mission's mandate decides what that means. ──────────

  if (!mission.armed) {
    return {
      observation,
      run: {
        ...base,
        outcome: 'in_stock',
        reason: `in stock at ${money(reading.price)} — this mission is watching only`,
      },
    };
  }

  // The reason `retailer_only` is the default: the retailer is the one running
  // MSRP drops. A marketplace listing being available is the thing you are
  // racing, not the thing you want.
  if (mission.sellerPolicy === 'retailer_only' && reading.seller.kind !== 'retailer') {
    const who = reading.seller.name || reading.seller.kind;
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: `sold by ${who}, and this mission is retailer-only`,
      },
    };
  }

  /*
   * ── In stock is not the same as buyable ──────────────────────────────────
   *
   * Learned on 2 Sep 2026 at 8pm, from Walmart's own node during a live drop:
   *
   *     availabilityStatusV2  IN_STOCK
   *     sellerName            Walmart.com
   *     canAddToCart          false
   *
   * All three true at once. The item was real, it was Walmart's own, and it
   * was behind a per-item waiting room that only a signed-in person could
   * join. A competing tracker alerted "In Stock" on that same data and sent a
   * room full of people to a page they could not buy from.
   *
   * So an armed mission stops here rather than driving a checkout at a page
   * with no button on it. `declined` and not `failed`: nothing went wrong, the
   * answer is simply no for now, and the next pass asks again.
   *
   * Only `false` stops it. `null` means the retailer did not say — Target and
   * Pokémon Center never do — and treating silence as refusal would disarm
   * two retailers out of three.
   */
  if (reading.addToCart === false) {
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: 'in stock but the retailer will not add it to a cart — a queue or a hold',
      },
    };
  }

  // ── A pre-order is orderable, and it is not stock ─────────────────────────
  //
  // Every reader already knew this and nothing acted on it. schema.org's
  // PreOrder maps to state 'in' — correctly, you can put it in a basket — and
  // Walmart states `preOrder.isPreOrder` outright. So a mission armed to catch
  // a restock would have paid for something shipping in three months and
  // reported success.
  //
  // Checked before the ceiling on purpose: "this is a pre-order" is a better
  // reason to decline than "it costs too much", and it is the one you want in
  // the log.
  if (reading.preOrder.isPreOrder && mission.preOrderPolicy !== 'allow') {
    const when = reading.preOrder.releaseDate
      ? `releases ${reading.preOrder.releaseDate}`
      : 'no release date given';
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: `pre-order (${when}), and this mission buys stock only`,
      },
    };
  }

  if (mission.ceiling === null) {
    return {
      observation,
      run: { ...base, outcome: 'declined', reason: 'armed with no price ceiling — refusing to spend' },
    };
  }

  if (reading.price === null) {
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: 'in stock but no price could be read — refusing to buy blind',
      },
    };
  }

  // The ceiling means item + tax per unit, and a listed price is always
  // pre-tax. Comparing the two directly would let through everything priced
  // just under the ceiling, every time, and only find out at the checkout.
  //
  // With no tax rate set this is the listed price unchanged, which is the old
  // behaviour and still safe — the real number is caught by verifyCart before
  // anything is submitted.
  const withTax = round2(reading.price * (1 + settings.taxRate));
  if (withTax > mission.ceiling) {
    const taxNote = settings.taxRate > 0
      ? ` (${money(reading.price)} + ${(settings.taxRate * 100).toFixed(2)}% tax)`
      : '';
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: `${money(withTax)}${taxNote} is over the ${money(mission.ceiling)} ceiling`,
      },
    };
  }

  if (reading.confidence !== 'exact') {
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: `the reading is ${reading.confidence}, not exact — refusing to spend on a guess`,
      },
    };
  }

  // Everything a purchase needs is true. This is a verdict, not a purchase:
  // the pass takes it to the Hub for authorisation, and the cart's own numbers
  // get the final word before anything is submitted. No run is recorded here —
  // the buy attempt records the one that says what actually happened.
  return {
    observation,
    run: null,
    buy: { unitPrice: reading.price, quantity: Math.max(1, mission.quantity || 1) },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number | null): string {
  return n === null ? 'an unknown price' : `$${n.toFixed(2)}`;
}

/**
 * The longest one check may take before we call it stuck.
 *
 * The read's own slow path tops out around nineteen seconds, so this is not a
 * performance limit — it is the line past which a check is not slow, it is
 * hung, and the pass has to move on without it.
 */
const CHECK_CEILING_MS = 45_000;

/**
 * Reject if a promise has not settled in time.
 *
 * The underlying work is NOT cancelled — nothing here can force Playwright to
 * abandon a stalled socket. What this does is stop that work from holding the
 * watcher hostage: the pass records a failed check, says so, and carries on.
 * An orphaned promise resolving into nothing later is a leak we can live with;
 * a watcher that quietly stops watching is not.
 *
 * The timer is deliberately NOT unref'd. It was, briefly, and that let the
 * event loop drain early enough that `--test-force-exit` cut the suite short —
 * 38 tests reported out of 57, all passing, nothing red. A test run that
 * silently stops early is the same species of lie as a watcher that silently
 * stops watching. Every timer here is cleared the moment its promise settles,
 * so holding a reference costs nothing real.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the check did not finish within ${Math.round(ms / 1000)}s — abandoned`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** A reading that commits to nothing, for when the check itself threw. */
function failedRead(note: string): Reading {
  return {
    ...unknownRead(note),
    challenged: false,
    challengeReason: '',
    imageUrl: '',
    ms: 0,
  };
}

/** How a listing gets read. Injectable so a pass can be tested without Chrome. */
export type ReadFn = (
  browser: Browser,
  retailer: string,
  externalId: string,
  url: string,
) => Promise<Reading>;

export interface WatchDeps {
  browser: Browser;
  hub: Hub;
  now?: () => number;
  log?: (line: string) => void;
  /** Defaults to the real one. Overridden in tests. */
  read?: ReadFn;
  /**
   * Where the per-check log goes. Optional so every existing test still
   * constructs a pass without one, and so a Phantom with no Hub still runs.
   */
  activity?: Activity;
  /**
   * What to do when judge() says everything a purchase needs is true.
   *
   * Absent means this Phantom cannot buy — the honest run is recorded instead.
   * Injectable so the pass can be tested without a Hub, a cart or a card.
   */
  buyer?: (mission: Mission, reading: Reading) => Promise<RunOut>;
  /**
   * How long a pass may keep working before handing control back.
   *
   * ── The bug this exists for ────────────────────────────────────────────
   *
   * A pass used to check ONE mission per retailer and return, and the caller
   * then slept the whole interval. With 39 missions across three shops that is
   * three checks every ninety-six seconds — so the fourteen Target listings
   * took TWENTY-TWO MINUTES to come round again. On a drop, twenty-two minutes
   * is not slow, it is absent.
   *
   * Worse, it made the drop-window burst decorative. Tightening the spacing
   * from twenty seconds to seven does nothing when the pass stops after the
   * first check either way: the pacer was being asked for permission it had
   * already granted, and then we went to sleep instead of using it.
   *
   * So a pass now DRAINS its due list, waiting out the pacer between checks,
   * until nothing is due or this window is spent. The window is what still
   * brings us back to the Hub for fresh missions and settings on a regular
   * cadence — without it, a long queue would starve the list it is working
   * from.
   */
  windowMs?: number;
  /**
   * Is a drop window open?
   *
   * When one is, nothing is quiet: every listing is read at the interval its
   * mission asked for, however long it has been sitting still. Decided in
   * drop.ts and passed in, so there is one answer to "is a drop on" in the
   * process rather than two that can disagree.
   */
  dropOpen?: boolean;
  /** Injectable so draining can be tested without real time passing. */
  wait?: (ms: number) => Promise<void>;
  /** The per-check ceiling. Injectable so a hang can be tested in milliseconds. */
  checkCeilingMs?: number;
  /**
   * Listings somebody has just asked to be checked, read fresh every turn.
   *
   * ── Why a callback and not a list ──────────────────────────────────────
   *
   * Because the answer changes DURING a pass. A person presses Check now
   * while fourteen Target listings are being worked through; if the pass only
   * knew what was urgent when it started, that button would wait out the
   * whole queue — which is the behaviour it exists to avoid.
   *
   * Consulted before every single pick, so the wait between pressing and
   * being checked is the poll interval plus the retailer's own spacing, and
   * nothing else.
   */
  urgent?: () => ReadonlySet<number>;
}

export interface PassResult {
  checked: number;
  reported: number;
  runs: number;
  /** Checks that threw rather than returning a reading. */
  failed: number;
  /**
   * Milliseconds until the soonest mission is due, when nothing was checked.
   *
   * A pass that prints "0 checked" and no reason is the same quiet that a
   * broken Phantom produces. Null when something was checked, or when the
   * wait is a retailer holding us back rather than the schedule.
   */
  nextDueInMs: number | null;
  blocked: string[];
  waitingOn: string[];
}

/**
 * How long until SOME due mission's retailer will have us again.
 *
 * Only counts missions that are due on their own schedule — a listing whose
 * next check is twenty minutes out is not worth holding a pass open for, and
 * waiting on it would starve the ones that are ready.
 */
function soonestAllowed(
  missions: Mission[],
  pacer: Pacer,
  now: number,
  dropOpen = false,
): number | null {
  let soonest: number | null = null;
  for (const m of missions) {
    if (!(m.checkNow === true || isDue(m.lastCheckedAt || null, quietInterval(m, now, dropOpen), now))) continue;
    const wait = pacer.waitMs(m.retailer, now);
    if (wait <= 0) return 0;
    if (soonest === null || wait < soonest) soonest = wait;
  }
  return soonest;
}

/**
 * One pass: check every mission that is due and whose retailer will have us.
 *
 * Returns rather than looping, so the loop itself stays a five-line thing and
 * everything interesting can be tested a pass at a time.
 */
export async function pass(missions: Mission[], pacer: Pacer, deps: WatchDeps): Promise<PassResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const read = deps.read ?? readListing;
  const result: PassResult = {
    checked: 0,
    reported: 0,
    runs: 0,
    failed: 0,
    nextDueInMs: null,
    blocked: [],
    waitingOn: [],
  };

  const remaining = [...missions];
  const done = new Set<number>();

  // ── The window ────────────────────────────────────────────────────────────
  //
  // A pass keeps working until its list is empty or its time is up, waiting out
  // the retailer's own spacing in between rather than going to sleep on top of
  // it. Zero means the old behaviour — one round and out — so every existing
  // test still describes what it always did.
  const windowMs = deps.windowMs ?? 0;
  const dropOpen = deps.dropOpen === true;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();

  for (;;) {
    // Somebody may have pressed the button a second ago. Ask now, not when
    // this pass began — a queue of fourteen is exactly when it gets pressed.
    const urgent = deps.urgent?.();
    if (urgent && urgent.size > 0) {
      for (const m of remaining) {
        if (urgent.has(m.listingId)) m.checkNow = true;
      }
    }

    let mission = nextUp(remaining, pacer, now(), dropOpen);

    // Nothing allowed right now. That is not the same as nothing to do: the
    // usual reason is a retailer's spacing, and the whole point of the window
    // is to spend it waiting for that rather than idling past it.
    if (!mission && windowMs > 0) {
      const spent = now() - started;
      const soonest = soonestAllowed(remaining, pacer, now(), dropOpen);
      // Only worth waiting if the wait fits inside what is left of the window,
      // and only for a mission that is actually due to be checked.
      if (soonest !== null && spent + soonest < windowMs) {
        await wait(soonest);
        mission = nextUp(remaining, pacer, now(), dropOpen);
      }
    }

    if (!mission) break;
    remaining.splice(remaining.indexOf(mission), 1);
    done.add(mission.id);

    pacer.record(mission.retailer, now());

    // One page falling over must not end the pass — the other retailer is
    // still worth checking, and the failure is worth a row saying so.
    let reading: Reading;
    try {
      // ── The belt ──────────────────────────────────────────────────────────
      //
      // A hard ceiling on one check, because on 1 Sep 2026 a read hung
      // forever and took the whole watcher with it. The process stayed alive
      // and stopped doing anything, which is worse than crashing: the
      // supervisor restarts a crash and cannot see a hang.
      //
      // The specific cause was a captured response body with no timeout, and
      // that is fixed at its source. This is here because the lesson is not
      // "that one await" — it is that any await against a browser can be the
      // one that never comes back, and a watcher must not be able to stop
      // watching quietly.
      //
      // Generous: the slow path inside a read is already bounded at about
      // nineteen seconds, so anything reaching this is not slow, it is stuck.
      reading = await withDeadline(
        read(deps.browser, mission.retailer, mission.externalId, mission.url),
        deps.checkCeilingMs ?? CHECK_CEILING_MS,
      );
    } catch (err) {
      reading = failedRead(`the check could not be completed: ${(err as Error).message}`);
      result.failed += 1;
    }
    result.checked += 1;

    const verdict = judge(mission, reading, deps.hub.settings);
    const { observation } = verdict;
    let run = verdict.run;

    // The detection side says buy. What happens next is the buy path's story,
    // and the run it returns is the truth of what happened — bought, dry_run,
    // duplicate_prevented, or a cart that disagreed with the page.
    if (verdict.buy) {
      if (deps.buyer) {
        try {
          run = await deps.buyer(mission, reading);
        } catch (err) {
          run = {
            missionId: mission.id,
            state: reading.state,
            price: reading.price,
            sellerKind: reading.seller.kind,
            sellerName: reading.seller.name,
            outcome: 'failed',
            reason: `the buy attempt itself failed: ${(err as Error).message}`,
          };
        }
      } else {
        run = {
          missionId: mission.id,
          state: reading.state,
          price: reading.price,
          sellerKind: reading.seller.kind,
          sellerName: reading.seller.name,
          outcome: 'declined',
          reason:
            `would buy ${verdict.buy.quantity} at ${money(reading.price)} — ` +
            'buying is not enabled on this Phantom',
        };
      }
    }

    // The drop precursor, checked before the routine line so the alarm is its
    // own row: warehouse quantity appearing on a listing that had none. Fires
    // once per load-in (the mission's stored quantity is the prior, and the
    // next pull of the watchlist carries the new number).
    if (stockLoaded(mission.availableQuantity, reading.availableQuantity)) {
      const n = Math.round(reading.availableQuantity ?? 0);
      log(
        `  STOCK LOADED at ${mission.retailer} — ${mission.productName}: ` +
          `~${n} units in the warehouse; a drop is likely near`,
      );
      deps.activity?.record({
        kind: 'check',
        level: 'warn',
        retailer: mission.retailer,
        missionId: mission.id,
        listingId: mission.listingId,
        state: reading.state,
        availableQuantity: reading.availableQuantity,
        message:
          `STOCK LOADED: ${mission.productName} — ${mission.retailer} shows ` +
          `~${n} units ready to ship; a drop is likely near`,
      });
    }

    // One line per check, whether or not anything happened. This is the half
    // that runs deliberately counter to the rest of the file: a run row is
    // written only when something changed, because a history of ten thousand
    // "still out of stock" is unreadable. A *diagnostic* log is the opposite —
    // a failure at 14:02 means one thing when the checks around it succeeded
    // and something else entirely when they did not, and you cannot tell which
    // from the failures alone.
    deps.activity?.record({
      kind: 'check',
      level: reading.challenged
        ? 'warn'
        : reading.confidence === 'unknown' && reading.state === 'unknown'
          ? 'error'
          : 'info',
      retailer: mission.retailer,
      missionId: mission.id,
      listingId: mission.listingId,
      state: reading.state,
      price: reading.price,
      ms: reading.ms,
      availableQuantity: reading.availableQuantity,
      message: run
        ? `${run.outcome}: ${run.reason}`
        : `${reading.state}${reading.price === null ? '' : ` at $${reading.price.toFixed(2)}`}`,
      detail: [
        reading.note,
        reading.challenged ? `challenge: ${reading.challengeReason}` : '',
        `confidence ${reading.confidence}`,
        reading.seller.kind === 'unknown' ? '' : `seller ${reading.seller.kind}`,
      ]
        .filter(Boolean)
        .join(' · '),
    });

    if (reading.challenged && isQueue(reading.challengeReason)) {
      // A waiting room, not a wall. No long stand-down — the next pass should
      // look again at the ordinary pace, because the interesting moment is
      // when the queue comes DOWN.
      //
      // Whether the REST of this shop's checks are skipped depends on what
      // kind of queue it is. A site-wide one (Queue-it) puts every page
      // behind the same door, and reading N copies of it proves nothing. A
      // per-item one (Walmart, measured 2 Sep 2026: one itemID in the
      // redirect) leaves every other listing readable — and on a drop night
      // those other listings are exactly what you want read.
      result.blocked.push(`${mission.retailer}: WAITING ROOM UP — drop likely live`);
      log(`  QUEUE at ${mission.retailer} — waiting room is up; a drop may be live`);
      if (queueScope(reading.challengeReason) === 'site') {
        for (let i = remaining.length - 1; i >= 0; i -= 1) {
          if (remaining[i]!.retailer === mission.retailer) remaining.splice(i, 1);
        }
      }
    } else if (reading.challenged) {
      const until = pacer.challenged(mission.retailer, now());
      const mins = Math.round((until - now()) / 60000);
      // And rest THIS PAGE, for longer each time it refuses. A retailer that
      // answers for everything else while one listing always walls is the
      // shape that kept an address warm for hours — see rate.ts.
      const listingUntil = pacer.listingChallenged(mission.listingId, now());
      const listingMins = Math.round((listingUntil - now()) / 60000);
      const walls = pacer.listingWalls(mission.listingId);
      result.blocked.push(`${mission.retailer}: ${reading.challengeReason}, ${mins}m`);
      log(`  ${mission.retailer} served a challenge — standing down ${mins}m`);
      if (walls > 1) {
        log(`  that page has refused ${walls} times running — resting it ${listingMins}m`);
      }
      // Drop everything else queued for that retailer this pass.
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (remaining[i]!.retailer === mission.retailer) remaining.splice(i, 1);
      }
    } else {
      pacer.succeeded(mission.retailer);
      pacer.listingSucceeded(mission.listingId);
    }

    const { sent } = await deps.hub.report([observation]);
    result.reported += sent;

    if (run) {
      await deps.hub.recordRun(run);
      result.runs += 1;
      log(`  ${mission.productName} (${mission.retailer}): ${run.outcome} — ${run.reason}`);
    } else {
      log(`  ${mission.productName} (${mission.retailer}): ${reading.state}, ${reading.ms}ms`);
    }
  }

  // Say what we did not get to, and why, rather than going quiet.
  //
  // Only missions that were due and did *not* get checked. A mission checked a
  // moment ago still looks due — its lastCheckedAt came from the Hub before the
  // pass began — and reporting "waiting on Target" immediately after checking
  // Target is worse than saying nothing.
  const nowMs = now();
  const named = new Set<string>();
  for (const m of missions) {
    if (done.has(m.id)) continue;
    if (named.has(m.retailer)) continue;
    if (!isDue(m.lastCheckedAt || null, quietInterval(m, nowMs), nowMs)) continue;
    const wait = pacer.waitMs(m.retailer, nowMs);
    if (wait <= 0) continue;
    const label = pacer.standingDown(m.retailer, nowMs) ? 'standing down' : 'pacing';
    named.add(m.retailer);
    result.waitingOn.push(`${m.retailer} (${label}, ${Math.ceil(wait / 1000)}s)`);
  }

  // Nothing checked and nobody holding us back means everything is simply on
  // schedule. Say when the next one is, rather than printing a bare zero.
  if (result.checked === 0 && result.waitingOn.length === 0) {
    let soonest: number | null = null;
    for (const m of missions) {
      if (m.checkNow) return result; // a test run is pending, not "nothing due"
      if (!m.lastCheckedAt) return result; // due now; something else is wrong
      // The interval it has EARNED, not the one it asked for. This said
      // `m.checkEverySeconds` until 5 Sep 2026 — three isDue call sites were
      // moved onto quietInterval and this fourth one was missed, so a listing
      // resting on a thirty-minute cadence reported itself "due in 0s" every
      // pass. The number is only printed, which is exactly why it survived:
      // wrong output that nobody acts on is the kind that lasts.
      const dueAt =
        new Date(m.lastCheckedAt).getTime() + quietInterval(m, nowMs, dropOpen) * 1000;
      if (!Number.isFinite(dueAt)) continue;
      const wait = Math.max(0, dueAt - nowMs);
      if (soonest === null || wait < soonest) soonest = wait;
    }
    result.nextDueInMs = soonest;
  }

  return result;
}
