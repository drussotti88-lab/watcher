/**
 * How often we are allowed to touch a retailer.
 *
 * Three rules, and each one exists because of a specific way this could go
 * wrong:
 *
 *  1. **Per retailer, not per mission.** Ten missions at Target must not mean
 *     ten times the traffic. The budget belongs to the site, and missions queue
 *     for it.
 *
 *  2. **Jitter.** Never poll on the exact second. Clockwork is the tell — a
 *     request arriving at :00.000 every minute for a week looks like nothing a
 *     person does.
 *
 *  3. **Hard back-off on a challenge.** A bot check means stop, not retry.
 *     Arguing with one is how a soft flag becomes a hard block, and each
 *     successive challenge doubles the stand-down.
 *
 * Pure: the clock and the randomness are arguments, so all of this is testable
 * without waiting and without flakiness.
 */

import { quietInterval } from './quiet.ts';

export interface Pacing {
  /** Minimum gap between two requests to the same retailer. */
  minSpacingMs: number;
  /** A random 0..jitterMs is added to every gap. */
  jitterMs: number;
  /** First stand-down after a challenge. */
  backoffMs: number;
  /** Ceiling on the doubling. */
  maxBackoffMs: number;
}

/**
 * The floor beneath the floor.
 *
 * A drop window may tighten the spacing; it may not abolish it. Five seconds
 * is the hard stop no setting can go under, so that the worst a mistyped
 * burst value can do is make us brisk rather than blocked.
 */
export const MIN_SAFE_SPACING_MS = 5_000;

/**
 * ── Why a LISTING rests, and not only a retailer ─────────────────────────────
 *
 * On 3 Sep 2026 one Walmart listing — a Prismatic Evolutions ETB — served the
 * press-and-hold on every read, three times an hour from 3:43pm. The
 * retailer's own back-off never escalated past its first step, because the
 * OTHER Walmart listing read cleanly each pass and a clean read forgives the
 * retailer. So the two of them oscillated: wall, twenty minutes, wall, for
 * hours, handing PerimeterX a fresh "this address runs a bot" signal each
 * time, until the household's ordinary browsing started being challenged too.
 *
 * A page that has refused six times in a row is telling us something, and the
 * fix is to believe it about THAT PAGE. So a listing keeps its own doubling
 * rest, and — this is the part that was missing — another listing reading
 * fine does not forgive it. Only the page itself coming back clean does.
 */
export const LISTING_REST_MS = 20 * 60_000;
export const MAX_LISTING_REST_MS = 24 * 60 * 60_000;

export const DEFAULT_PACING: Pacing = {
  // One request per retailer every 20s at the very fastest. A mission asking
  // for 30s intervals still gets them; three missions on one retailer share.
  minSpacingMs: 20_000,
  jitterMs: 8_000,
  backoffMs: 20 * 60_000,
  maxBackoffMs: 4 * 60 * 60_000,
};

interface State {
  /** Earliest time the next request may go out. */
  nextAllowedAt: number;
  /** Current penalty, doubling per consecutive challenge. */
  penaltyMs: number;
  /** Set while standing down, so the reason can be reported. */
  standDownUntil: number;
  consecutiveChallenges: number;
}

export class Pacer {
  private readonly pacing: Pacing;
  private readonly random: () => number;
  private readonly state = new Map<string, State>();
  /** Per listing: when it may be read again, and how long the last rest was. */
  private readonly listings = new Map<number, { until: number; restMs: number; walls: number }>();
  /** A tighter floor while a drop window is open. Null means the ordinary one. */
  private burstMs: number | null = null;

  constructor(pacing: Pacing = DEFAULT_PACING, random: () => number = Math.random) {
    this.pacing = pacing;
    this.random = random;
  }

  /**
   * Tighten the floor for a drop window, or restore it.
   *
   * Only the *spacing* moves. The challenge back-off is untouched and still
   * takes precedence — bursting is about how eagerly we look at a shop that is
   * answering, never about arguing with one that has said no. A stand-down in
   * progress stays in force at full length, which is the whole point of it.
   *
   * Refuses to go below the safe floor rather than trusting its caller: this
   * number arrives from a settings field, and the cost of a typo here is the
   * block that takes Phantom off the air during the drop it was tightened
   * for.
   */
  setBurstSpacing(ms: number | null): void {
    if (ms === null || !Number.isFinite(ms) || ms <= 0) {
      this.burstMs = null;
      return;
    }
    this.burstMs = Math.max(MIN_SAFE_SPACING_MS, ms);
  }

  /** The floor in force right now, burst or ordinary. */
  get spacingMs(): number {
    return this.burstMs ?? this.pacing.minSpacingMs;
  }

  private get(retailer: string): State {
    let s = this.state.get(retailer);
    if (!s) {
      s = { nextAllowedAt: 0, penaltyMs: 0, standDownUntil: 0, consecutiveChallenges: 0 };
      this.state.set(retailer, s);
    }
    return s;
  }

  /** How long to wait before touching this retailer. 0 means go now. */
  waitMs(retailer: string, now: number): number {
    const s = this.get(retailer);
    return Math.max(0, Math.max(s.nextAllowedAt, s.standDownUntil) - now);
  }

  /** True when we are standing down after a challenge rather than merely early. */
  standingDown(retailer: string, now: number): boolean {
    return this.get(retailer).standDownUntil > now;
  }

  /**
   * This listing served a challenge. Rest it, doubling each consecutive time.
   *
   * Separate from the retailer's stand-down and longer-lived on purpose: the
   * retailer resumes in twenty minutes and everything else on it goes back to
   * being read, while this one page waits out its own, growing, silence.
   */
  listingChallenged(listingId: number, now: number): number {
    const prev = this.listings.get(listingId);
    const restMs = prev ? Math.min(MAX_LISTING_REST_MS, prev.restMs * 2) : LISTING_REST_MS;
    const entry = { until: now + restMs, restMs, walls: (prev?.walls ?? 0) + 1 };
    this.listings.set(listingId, entry);
    return entry.until;
  }

  /** This listing read cleanly. Only this forgives it — see the note above. */
  listingSucceeded(listingId: number): void {
    this.listings.delete(listingId);
  }

  /** How long this listing is resting for. 0 means it may be read. */
  listingRestMs(listingId: number, now: number): number {
    const entry = this.listings.get(listingId);
    return entry ? Math.max(0, entry.until - now) : 0;
  }

  /** How many times in a row this listing has refused. For the log. */
  listingWalls(listingId: number): number {
    return this.listings.get(listingId)?.walls ?? 0;
  }

  /** Note that a request just went out. Sets the next allowed time, with jitter. */
  record(retailer: string, now: number): void {
    const s = this.get(retailer);
    // Jitter scales with the floor: 8s of wobble on a 5s burst would make the
    // burst meaningless, and clockwork is only a tell at a steady cadence.
    const jitter = Math.min(this.pacing.jitterMs, Math.round(this.spacingMs * 0.4));
    s.nextAllowedAt = now + this.spacingMs + this.random() * jitter;
  }

  /**
   * A retailer served a challenge instead of a page.
   *
   * The whole retailer stands down, not the one mission — a challenge is about
   * us, not about the product. Returns when it may resume.
   */
  challenged(retailer: string, now: number): number {
    const s = this.get(retailer);
    s.consecutiveChallenges += 1;
    s.penaltyMs = s.penaltyMs === 0
      ? this.pacing.backoffMs
      : Math.min(this.pacing.maxBackoffMs, s.penaltyMs * 2);
    s.standDownUntil = now + s.penaltyMs;
    return s.standDownUntil;
  }

  /** A clean read. Forgives the accumulated penalty. */
  succeeded(retailer: string): void {
    const s = this.get(retailer);
    s.penaltyMs = 0;
    s.standDownUntil = 0;
    s.consecutiveChallenges = 0;
  }

  /** For reporting: how many challenges in a row this retailer has served. */
  challengeStreak(retailer: string): number {
    return this.get(retailer).consecutiveChallenges;
  }
}

/**
 * Is this mission due?
 *
 * A mission asks to be checked every N seconds. It is due when that long has
 * passed since it was last *checked* — not since the last time we tried, so a
 * retailer standing down does not silently reset everyone's schedule.
 */
export function isDue(lastCheckedAt: string | null, everySeconds: number, now: number): boolean {
  if (!lastCheckedAt) return true;
  const last = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= everySeconds * 1000;
}

/**
 * Choose what to check next.
 *
 * Longest-waiting first, so a fast mission cannot starve a slow one when they
 * share a retailer's budget.
 */
export function nextUp<
  T extends {
    retailer: string;
    listingId?: number;
    checkEverySeconds: number;
    lastCheckedAt: string;
    checkNow?: boolean;
    state?: string;
    lastChangedAt?: string;
    armed?: boolean;
    releaseDate?: string | null;
  },
>(missions: T[], pacer: Pacer, now: number, dropOpen = false): T | null {
  const due = missions
    // The interval a quiet listing has EARNED, which is its own when anything
    // is happening and a multiple of it when nothing has been for hours. See
    // quiet.ts for why: 3,194 reads a day from one house got that house's
    // ordinary browsing challenged by two retailers at once.
    .filter((m) => m.checkNow === true || isDue(m.lastCheckedAt || null, quietInterval(m, now, dropOpen), now))
    // Note what this filter is NOT excepting. A test run jumps the queue of
    // missions; it does not jump the retailer's budget. Letting a button in a
    // web page bypass the pacing is how you get a bot check while looking at
    // the screen that caused it.
    .filter((m) => pacer.waitMs(m.retailer, now) === 0)
    // A page resting off its own refusals is skipped even when the retailer
    // is answering, and even for a hand-pressed check: pressing the button
    // harder is not an argument a bot check accepts.
    .filter((m) => m.listingId === undefined || pacer.listingRestMs(m.listingId, now) === 0)
    .sort((a, b) => {
      // An explicitly requested check goes first: somebody is watching the page
      // waiting for it, and every other mission's schedule can absorb a turn.
      if (a.checkNow !== b.checkNow) return a.checkNow ? -1 : 1;
      const at = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
      const bt = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
      return at - bt;
    });
  return due[0] ?? null;
}
