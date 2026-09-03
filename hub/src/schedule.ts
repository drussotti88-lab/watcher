/**
 * Drops that happen on a clock.
 *
 * ── A copy, on purpose ──────────────────────────────────────────────────────
 *
 * This file is duplicated in watcher/src/schedule.ts. The two halves are
 * separate programs on separate deploys, and every other thing they share —
 * the waiting-room wording, the ingest shape — is a contract pinned by tests
 * on both sides rather than a package. Phantom uses it to tighten the pace;
 * the Hub uses it to shout beforehand if something is switched off. If they
 * ever disagree about when a drop is, the tests here and there both fail.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Most of this system is built around not knowing when something will happen:
 * staged stock opens a window on evidence, a queue shouts when it appears, and
 * the pacer spends its requests as though every hour were equally likely.
 *
 * Walmart's queue drops are not like that. They land at 8:00pm America/Chicago
 * on Wednesdays, and on 2 Sep 2026 the first alert of the drop was timestamped
 * 8:00:34 — thirty-four seconds after the hour, to the second. An event you can
 * put in a diary should not be waited for by luck.
 *
 * ── What a schedule is allowed to do ────────────────────────────────────────
 *
 * Two things, both cheap and both reversible: tighten the pace for the minutes
 * that matter, and say out loud beforehand if something is switched off. It
 * does NOT arm anything, buy anything, or join anything. A schedule is a guess
 * about when to pay attention, and a guess must never be allowed to spend
 * money.
 *
 * The window closes by itself, which is the same discipline as the manual drop
 * window: the failure mode of a switch is leaving it on.
 */

/** A drop that recurs weekly at a known local time. */
export interface DropSlot {
  retailer: string;
  /** 0 = Sunday … 6 = Saturday, read in `timezone`. */
  weekday: number;
  /** HH:MM, 24-hour, in `timezone`. */
  at: string;
  /** IANA zone. The drop is defined in the retailer's clock, not the machine's. */
  timezone: string;
  /** What we actually know, for the log and the banner. */
  note: string;
}

/**
 * The schedule, as observed rather than as published.
 *
 * A constant and not a setting, deliberately. There is one known drop and it
 * was learned by watching, so the honest place for it is source with a note
 * saying where it came from. It becomes a setting the day there are three of
 * them and they start disagreeing — not before.
 */
export const KNOWN_DROPS: readonly DropSlot[] = [
  {
    retailer: 'Walmart',
    weekday: 3,
    at: '20:00',
    timezone: 'America/Chicago',
    note: 'Walmart queue drops. Confirmed 2 Sep 2026: opened 20:00:00, first alert 20:00:34, over by 20:43.',
  },
];

/**
 * Open the burst this long before the hour.
 *
 * Five minutes. Long enough that the tightened pace is already running when
 * the clock turns over, short enough that it is not an hour of extra traffic
 * at the retailer most willing to serve a bot check.
 */
export const LEAD_MINUTES = 5;

/**
 * And keep it open this long after.
 *
 * Forty-five. The 2 Sep drop was over inside forty-three minutes — in stock at
 * 20:00, gone by 20:43 — so this covers the observed event with a little room
 * and then stops, rather than pacing hard into an empty evening.
 */
export const TAIL_MINUTES = 45;

/**
 * How long before a drop to start complaining about switches.
 *
 * Ninety minutes, because that is enough time to notice, fix it, and let a
 * pass run — and because the failure this exists for (Walmart switched off
 * since 4:18pm, spotted at 7pm) needs to be caught by a person who is doing
 * something else.
 */
export const WARN_MINUTES = 90;

const MINUTES_IN_WEEK = 7 * 24 * 60;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Where we are in the week, in a named zone, as minutes since Sunday 00:00.
 *
 * Going through Intl rather than arithmetic on the UTC offset is what makes
 * this survive daylight saving. "8pm Chicago" is 01:00 UTC in summer and 02:00
 * in winter, and a schedule that drifted by an hour twice a year would be
 * wrong on exactly the two nights nobody was expecting it to be.
 */
export function zonedWeekMinutes(now: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    ...(timezone ? { timeZone: timezone } : {}),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  let weekday = 0;
  let hours = 0;
  let minutes = 0;
  for (const part of fmt.formatToParts(now)) {
    if (part.type === 'weekday') {
      const i = DAYS.indexOf(part.value);
      if (i >= 0) weekday = i;
    }
    if (part.type === 'hour') hours = Number(part.value);
    if (part.type === 'minute') minutes = Number(part.value);
  }
  // Some locales render midnight as 24, which would sort a Wednesday drop into
  // Thursday.
  if (hours === 24) hours = 0;
  return weekday * 1440 + hours * 60 + minutes;
}

function slotWeekMinutes(slot: DropSlot): number | null {
  const parts = slot.at.split(':');
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return slot.weekday * 1440 + h * 60 + m;
}

/**
 * Minutes until this drop next opens: 0 at the moment it starts, then counting
 * down from a week away.
 *
 * Never negative. "Twenty minutes ago" is expressed as "ten thousand and sixty
 * minutes from now", which is the same instant on a weekly clock and saves
 * every caller from a sign convention.
 */
export function minutesUntil(slot: DropSlot, now: Date): number | null {
  const target = slotWeekMinutes(slot);
  if (target === null) return null;
  const here = zonedWeekMinutes(now, slot.timezone);
  return (((target - here) % MINUTES_IN_WEEK) + MINUTES_IN_WEEK) % MINUTES_IN_WEEK;
}

/** Minutes since it opened, if it opened within the last `MINUTES_IN_WEEK`. */
export function minutesSince(slot: DropSlot, now: Date): number | null {
  const until = minutesUntil(slot, now);
  if (until === null) return null;
  return until === 0 ? 0 : MINUTES_IN_WEEK - until;
}

export interface ScheduledDrop {
  slot: DropSlot;
  /** Minutes until it opens. 0 while it is running. */
  minutesUntil: number;
  /** Minutes since it opened, when it is running. */
  minutesSince: number;
  /** True between LEAD_MINUTES before and TAIL_MINUTES after. */
  running: boolean;
}

/**
 * The drop that is happening, or about to.
 *
 * `withinMinutes` is how far ahead to look. Pass LEAD_MINUTES to drive pacing;
 * pass WARN_MINUTES to drive a warning. One function, because the alternative
 * is two that can disagree about when a drop is.
 */
export function upcomingDrop(
  now: Date,
  withinMinutes: number,
  slots: readonly DropSlot[] = KNOWN_DROPS,
): ScheduledDrop | null {
  let best: ScheduledDrop | null = null;
  for (const slot of slots) {
    const until = minutesUntil(slot, now);
    if (until === null) continue;
    const since = MINUTES_IN_WEEK - until;
    const running = until <= LEAD_MINUTES || since <= TAIL_MINUTES;
    const soon = until <= withinMinutes;
    if (!running && !soon) continue;
    const found: ScheduledDrop = {
      slot,
      minutesUntil: until,
      minutesSince: until === 0 ? 0 : since,
      running,
    };
    // The nearest one wins, and a running drop beats a distant one even when
    // its "minutes until" is nearly a week.
    if (!best) best = found;
    else if (found.running && !best.running) best = found;
    else if (found.running === best.running && found.minutesUntil < best.minutesUntil) best = found;
  }
  return best;
}
