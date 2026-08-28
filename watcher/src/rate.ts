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

  constructor(pacing: Pacing = DEFAULT_PACING, random: () => number = Math.random) {
    this.pacing = pacing;
    this.random = random;
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

  /** Note that a request just went out. Sets the next allowed time, with jitter. */
  record(retailer: string, now: number): void {
    const s = this.get(retailer);
    s.nextAllowedAt = now + this.pacing.minSpacingMs + this.random() * this.pacing.jitterMs;
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
export function nextUp<T extends { retailer: string; checkEverySeconds: number; lastCheckedAt: string }>(
  missions: T[],
  pacer: Pacer,
  now: number,
): T | null {
  const due = missions
    .filter((m) => isDue(m.lastCheckedAt || null, m.checkEverySeconds, now))
    .filter((m) => pacer.waitMs(m.retailer, now) === 0)
    .sort((a, b) => {
      const at = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
      const bt = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
      return at - bt;
    });
  return due[0] ?? null;
}
