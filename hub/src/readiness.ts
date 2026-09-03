/**
 * Is anything going to stop the next drop working?
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * On 2 Sep 2026 Walmart was switched off in Settings. Every pass since 4:18pm
 * ended `shops switched off: Walmart, Pokemon Center`, and nobody noticed
 * until the drop was an hour away. Nothing was broken. A toggle was off, the
 * run log said so seventy times, and the log is not a thing anybody reads on a
 * Wednesday afternoon.
 *
 * Every failure that night was a switch, not a bug. So this asks the only
 * question worth asking in the ninety minutes before a scheduled drop — what,
 * right now, would stop this from working — and the page says it loudly enough
 * to interrupt somebody doing something else.
 *
 * ── Why each blocker names its own fix ──────────────────────────────────────
 *
 * A warning that says "Walmart is off" and leaves you hunting through Settings
 * has spent your attention without saving you anything. The fix travels with
 * the finding.
 *
 * Pure, and given everything it needs. No clock, no database, no request — so
 * every one of these can be tested at a fixed instant, which is the only way
 * to test a thing that only matters at 7:59pm on a Wednesday.
 */
import { WARN_MINUTES, upcomingDrop } from './schedule.ts';

/** Phantom is considered gone after this long without a word. */
const SILENT_MINUTES = 10;

export interface Blocker {
  /** What is wrong, in the words a person would use. */
  what: string;
  /** Where to fix it. */
  fix: string;
}

export interface Readiness {
  retailer: string;
  /**
   * Minutes until it opens. Once the hour has passed this counts down to NEXT
   * week's, so a caller wanting "how long has this been going" reads
   * `minutesSince` instead — see the note there.
   */
  minutesUntil: number;
  /**
   * Minutes since it opened. 0 before the hour.
   *
   * The pair exists because a weekly clock has no negative numbers: twenty
   * minutes after Wednesday's drop is also ten thousand and sixty minutes
   * before next Wednesday's, and both are true. `minutesSince > 0` is what
   * distinguishes "running" from "about to".
   */
  minutesSince: number;
  running: boolean;
  note: string;
  blockers: Blocker[];
}

export interface ReadinessInput {
  now: Date;
  settings: {
    pausedRetailers?: string[] | null;
    paused?: boolean | null;
    burstSpacingSeconds?: number | null;
    activeFrom?: string | null;
    activeUntil?: string | null;
    timezone?: string | null;
  } | null;
  /** When Phantom last reported. Null means never. */
  agentSeenAt?: string | null;
  /** Enough of each mission to know whether this shop is being watched at all. */
  missions?: readonly { retailer?: string | null; enabled?: boolean | null }[];
  /** Bot checks served per shop in the last day. Queues do not count. */
  walls?: readonly { retailer: string; n: number }[];
}

const toMinutes = (hhmm: string): number | null => {
  const parts = hhmm.split(':');
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
};

/**
 * Would quiet hours have Phantom asleep at the drop?
 *
 * The subtlest blocker of the set, and the one most likely to be set months
 * earlier for a good reason. Target's drops are in the small hours, so a
 * window of 02:00–06:00 is a sensible thing to have configured — and it would
 * silently swallow an 8pm Wednesday.
 */
export function asleepAtDrop(from: string, until: string, dropAt: string): boolean {
  const a = toMinutes(from);
  const b = toMinutes(until);
  const d = toMinutes(dropAt);
  if (a === null || b === null || d === null) return false;
  // Equal values mean no restriction — the same rule the watcher applies.
  if (a === b) return false;
  // A window may cross midnight: 22:00–06:00 is one window, not two.
  const awake = a < b ? d >= a && d < b : d >= a || d < b;
  return !awake;
}

export function dropReadiness(input: ReadinessInput): Readiness | null {
  const drop = upcomingDrop(input.now, WARN_MINUTES);
  if (!drop) return null;

  const s = input.settings ?? {};
  const retailer = drop.slot.retailer;
  const blockers: Blocker[] = [];

  // ── The one that actually happened ────────────────────────────────────────
  const off = (s.pausedRetailers ?? []).some(
    (r) => String(r).toLowerCase() === retailer.toLowerCase(),
  );
  if (off) {
    blockers.push({
      what: `${retailer} is switched off — nothing is watching it`,
      fix: 'Settings → Which shops, and how hard',
    });
  }

  if (s.paused === true) {
    blockers.push({
      what: 'Everything is paused',
      fix: 'Settings → When to watch → Pause everything',
    });
  }

  // ── Is the machine even alive ─────────────────────────────────────────────
  const seen = input.agentSeenAt ? Date.parse(input.agentSeenAt) : NaN;
  if (!Number.isFinite(seen)) {
    blockers.push({ what: 'Phantom has never reported in', fix: 'Start it on the machine' });
  } else {
    const silentFor = Math.round((input.now.getTime() - seen) / 60_000);
    if (silentFor > SILENT_MINUTES) {
      blockers.push({
        what: `Phantom has been silent for ${silentFor} minutes`,
        fix: 'Settings → Phantom, or restart it on the machine',
      });
    }
  }

  // ── Is anything at that shop actually on the watchlist ────────────────────
  const watching = (input.missions ?? []).filter(
    (m) => String(m.retailer ?? '').toLowerCase() === retailer.toLowerCase() && m.enabled !== false,
  );
  if (watching.length === 0) {
    blockers.push({
      what: `No live mission at ${retailer}`,
      fix: 'Add a product, or resume a paused mission',
    });
  }

  // ── The window will open, but it will not tighten anything ────────────────
  if (!s.burstSpacingSeconds || Number(s.burstSpacingSeconds) <= 0) {
    blockers.push({
      what: 'Drop-window spacing is unset, so the scheduled window cannot speed anything up',
      fix: 'Settings → Which shops, and how hard → Drop-window spacing',
    });
  }

  /*
   * ── The shop has been turning this browser away ──────────────────────────
   *
   * Not a switch, and nothing to flip — which is exactly why it needs saying.
   * A press-and-hold on the watch profile means twenty minutes of nothing
   * from that shop, and several in a day means the evening's coverage is a
   * coin toss. The fix names the thing that still works when the watcher is
   * walled: the handoff to a browser the shop trusts.
   */
  const walls = (input.walls ?? []).find(
    (w) => String(w.retailer).toLowerCase() === retailer.toLowerCase(),
  );
  if (walls && walls.n > 0) {
    blockers.push({
      what: `${retailer} served ${walls.n} bot check${walls.n === 1 ? '' : 's'} to the watcher in the last 24 hours — coverage tonight may be patchy`,
      fix: 'Nothing to switch. Hold my place opens your own browser if the watcher is walled',
    });
  }

  if (
    // Both clocks are the owner's own, so the comparison is like for like:
    // watching hours are stored in `settings.timezone` and the drop is defined
    // in the retailer's, which for a US retailer and a US owner is the same
    // wall clock. If we ever watch a shop that drops on another continent this
    // has to convert, and the test that catches it should be written then.
    asleepAtDrop(String(s.activeFrom ?? ''), String(s.activeUntil ?? ''), drop.slot.at)
  ) {
    blockers.push({
      what: `Watching hours have Phantom asleep at ${drop.slot.at}`,
      fix: 'Settings → When to watch',
    });
  }

  return {
    retailer,
    minutesUntil: drop.minutesUntil,
    minutesSince: drop.minutesSince,
    running: drop.running,
    note: drop.slot.note,
    blockers,
  };
}
