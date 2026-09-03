/**
 * Reading a shelf less often when the shelf is not moving.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * On 3 Sep 2026 this system made 3,194 page reads in twenty-four hours from
 * one house: thirteen Target listings and two Walmart ones, every sixty
 * seconds, around the clock. Most of those listings had said "out of stock"
 * for days. That is one request every twenty-seven seconds, all day, every
 * day, to two retailers — and by the afternoon Walmart AND Target were both
 * putting a press-and-hold in front of Roberto's own browser, on his own
 * address, while he was shopping.
 *
 * Nothing was wrong with the reads. There were simply far too many of them,
 * and almost none of them could have told us anything: a product that has
 * been out for a week is not going to change between 3:00:00 and 3:01:00 and
 * be gone by 3:02:00.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The longer a listing has been saying the same thing, the less often we ask.
 * The moment it changes — or a drop window opens, or somebody presses the
 * button, or it is in stock, or its street date is near — it goes straight
 * back to the interval the mission asked for.
 *
 * So the fast path is exactly as fast as it ever was, in every case where
 * speed is worth anything, and the other twenty-three hours of the day cost a
 * tenth as much. That is the whole trade, and it is not a trick played on the
 * retailer: it is asking for less.
 */

/** How long a listing must have been unchanged to earn each multiplier. */
export const STEPS: readonly { afterHours: number; times: number }[] = [
  { afterHours: 1, times: 3 },
  { afterHours: 6, times: 8 },
  { afterHours: 24, times: 15 },
  { afterHours: 24 * 7, times: 30 },
];

/** However quiet it gets, never longer than this between reads. */
export const MAX_INTERVAL_S = 30 * 60;

export interface QuietInput {
  checkEverySeconds: number;
  state?: string;
  lastChangedAt?: string | null;
  checkNow?: boolean;
  armed?: boolean;
  releaseDate?: string | null;
}

/**
 * Never slowed down, whatever else is true.
 *
 * In stock is the obvious one: a thing that is buyable now is the thing the
 * whole system exists for, and its next change is the one we must not miss.
 * Armed is the same argument with money attached. A release inside a week is
 * where a street-date stock load appears, which is the earliest signal there
 * is. And `checkNow` means somebody is watching the screen.
 */
export function alwaysFast(m: QuietInput, now: number): boolean {
  if (m.checkNow === true) return true;
  if (m.armed === true) return true;
  if (m.state === 'in' || m.state === 'in_stock' || m.state === 'staged') return true;
  if (m.releaseDate) {
    const at = new Date(m.releaseDate).getTime();
    if (Number.isFinite(at)) {
      const days = (at - now) / 86_400_000;
      if (days >= -1 && days <= 7) return true;
    }
  }
  return false;
}

/**
 * How often to read this listing, in seconds.
 *
 * `dropOpen` is the drop window: during one, nothing is quiet. That is
 * decided elsewhere (drop.ts) and passed in rather than recomputed, so there
 * is exactly one answer to "is a drop on" in the process.
 */
export function quietInterval(m: QuietInput, now: number, dropOpen = false): number {
  const asked = Math.max(1, m.checkEverySeconds);
  if (dropOpen || alwaysFast(m, now)) return asked;

  const changed = m.lastChangedAt ? new Date(m.lastChangedAt).getTime() : NaN;
  // Never seen it change: we have no evidence it is quiet, so treat it as
  // busy. A listing added a minute ago must not start out on a half-hour
  // cadence just because its history is empty.
  if (!Number.isFinite(changed)) return asked;

  const hours = (now - changed) / 3_600_000;
  let times = 1;
  for (const step of STEPS) if (hours >= step.afterHours) times = step.times;

  return Math.min(MAX_INTERVAL_S, asked * times);
}

/** For the log: a word for what the cadence is doing, or '' when ordinary. */
export function quietLabel(m: QuietInput, now: number, dropOpen = false): string {
  const asked = Math.max(1, m.checkEverySeconds);
  const actual = quietInterval(m, now, dropOpen);
  if (actual <= asked) return '';
  return `resting (every ${Math.round(actual / 60)}m — unchanged for ${
    Math.round((now - new Date(m.lastChangedAt!).getTime()) / 3_600_000)
  }h)`;
}
