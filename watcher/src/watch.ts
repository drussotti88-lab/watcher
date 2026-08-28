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
import type { Hub, Mission, ObservationOut, RunOut } from './hub.ts';
import { Pacer, isDue, nextUp } from './rate.ts';
import { readListing, type Reading } from './read.ts';
import { unknownRead } from './readers/types.ts';

export interface Verdict {
  /** Post this reading to the Hub? Almost always yes. */
  observation: ObservationOut;
  /** Record a run? Only when something happened. */
  run: RunOut | null;
}

/**
 * Turn a reading into what the Hub should be told.
 *
 * Deliberately pure and deliberately separate from the loop: this is where the
 * judgements live, so they can be tested without a browser, a clock or a
 * network.
 */
export function judge(mission: Mission, reading: Reading): Verdict {
  const observation: ObservationOut = {
    listingId: mission.listingId,
    state: reading.state,
    confidence: reading.confidence,
    price: reading.price,
    sellerKind: reading.seller.kind,
    sellerName: reading.seller.name,
    availableQuantity: reading.availableQuantity,
    orderLimit: reading.orderLimit,
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
  };

  // A challenge is about us, not the product. Worth a run: it is the thing you
  // want to see when the numbers stop moving.
  if (reading.challenged) {
    return {
      observation,
      run: { ...base, outcome: 'blocked', reason: `${reading.challengeReason} — standing down` },
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

  if (reading.price > mission.ceiling) {
    return {
      observation,
      run: {
        ...base,
        outcome: 'declined',
        reason: `${money(reading.price)} is over the ${money(mission.ceiling)} ceiling`,
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

  // Everything a purchase needs is true. The one missing piece is the checkout
  // flow itself, which is written with a browser open and a person watching.
  return {
    observation,
    run: {
      ...base,
      outcome: 'declined',
      quantity: mission.quantity,
      total: reading.price * mission.quantity,
      reason:
        `would have bought ${mission.quantity} at ${money(reading.price)} ` +
        `(${money(reading.price * mission.quantity)} total) — checkout is not built yet`,
    },
  };
}

function money(n: number | null): string {
  return n === null ? 'an unknown price' : `$${n.toFixed(2)}`;
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
   * broken Watcher produces. Null when something was checked, or when the
   * wait is a retailer holding us back rather than the schedule.
   */
  nextDueInMs: number | null;
  blocked: string[];
  waitingOn: string[];
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
  for (;;) {
    const mission = nextUp(remaining, pacer, now());
    if (!mission) break;
    remaining.splice(remaining.indexOf(mission), 1);
    done.add(mission.id);

    pacer.record(mission.retailer, now());

    // One page falling over must not end the pass — the other retailer is
    // still worth checking, and the failure is worth a row saying so.
    let reading: Reading;
    try {
      reading = await read(deps.browser, mission.retailer, mission.externalId, mission.url);
    } catch (err) {
      reading = failedRead(`the check could not be completed: ${(err as Error).message}`);
      result.failed += 1;
    }
    result.checked += 1;

    const { observation, run } = judge(mission, reading);

    if (reading.challenged) {
      const until = pacer.challenged(mission.retailer, now());
      const mins = Math.round((until - now()) / 60000);
      result.blocked.push(`${mission.retailer}: ${reading.challengeReason}, ${mins}m`);
      log(`  ${mission.retailer} served a challenge — standing down ${mins}m`);
      // Drop everything else queued for that retailer this pass.
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (remaining[i]!.retailer === mission.retailer) remaining.splice(i, 1);
      }
    } else {
      pacer.succeeded(mission.retailer);
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
    if (!isDue(m.lastCheckedAt || null, m.checkEverySeconds, nowMs)) continue;
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
      const dueAt = new Date(m.lastCheckedAt).getTime() + m.checkEverySeconds * 1000;
      if (!Number.isFinite(dueAt)) continue;
      const wait = Math.max(0, dueAt - nowMs);
      if (soonest === null || wait < soonest) soonest = wait;
    }
    result.nextDueInMs = soonest;
  }

  return result;
}
