/**
 * When to hurry, and which shops to look at.
 *
 * Two settings that change the shape of a pass, kept together because they
 * answer the same question — what is this Watcher allowed to spend its next
 * request on — and kept pure so both are testable without a clock or a browser.
 *
 * ── Why a drop window exists ─────────────────────────────────────────────────
 *
 * The ordinary floor is one request per shop every 20–28 seconds. That is the
 * right pace for a system meant to run every day for years without being
 * noticed. It is the wrong pace for the ninety seconds that decide a drop: at
 * 20s spacing an armed mission sees a live drop about three times before it is
 * gone, and two of those may be the queue.
 *
 * So the burst is an *exception with an end*, not a new default. It opens
 * either because a person said so (with an expiry, because the failure mode of
 * a switch is leaving it on) or because something on the watchlist is released
 * today — the one day the shop is guaranteed to be interesting.
 */
import type { Mission, Settings } from './hub.ts';

/** Today as YYYY-MM-DD in a named zone, or this machine's own when blank. */
export function todayIn(timezone: string, now: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now));
  } catch {
    // An unknown zone must not decide the day wrongly and silently — fall back
    // to the machine's own clock, which is what a blank setting means anyway.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now));
  }
}

export interface DropWindow {
  open: boolean;
  /** Plain words for the log, so a tightened pace always says why. */
  reason: string;
}

/**
 * Is a drop window open right now?
 *
 * A manual window wins on its own; a release date opens one for the day. Both
 * require `burstSpacingSeconds` to be set at all — with no burst configured
 * there is nothing to open, and claiming a window while pacing normally would
 * put a lie in the log.
 */
export function dropWindow(
  settings: Settings,
  missions: readonly Mission[],
  now: number,
): DropWindow {
  const shut = { open: false, reason: '' };
  if (!settings.burstSpacingSeconds || settings.burstSpacingSeconds <= 0) return shut;

  const until = String(settings.dropModeUntil ?? '');
  if (until) {
    const t = Date.parse(until);
    if (Number.isFinite(t) && t > now) {
      const mins = Math.ceil((t - now) / 60_000);
      return { open: true, reason: `drop mode is on for another ${mins}m` };
    }
  }

  const today = todayIn(String(settings.timezone ?? ''), now);
  const dropping = missions.filter((m) => m.enabled && m.releaseDate === today);
  if (dropping.length) {
    const names = dropping.slice(0, 2).map((m) => m.productName).join(', ');
    const more = dropping.length > 2 ? ` +${dropping.length - 2} more` : '';
    return { open: true, reason: `released today: ${names}${more}` };
  }
  return shut;
}

/** The burst floor in milliseconds, or null when no window is open. */
export function burstMsFor(
  settings: Settings,
  missions: readonly Mission[],
  now: number,
): number | null {
  return dropWindow(settings, missions, now).open
    ? Number(settings.burstSpacingSeconds) * 1000
    : null;
}

/**
 * Is this shop switched on?
 *
 * Unknown shop names are ON, deliberately. The list names what is *off*, so a
 * retailer this build has never heard of — a new reader landing before the
 * settings catch up — keeps working rather than silently going dark.
 */
export function retailerOn(settings: Settings, retailer: string): boolean {
  const off = settings.pausedRetailers ?? [];
  return !off.some((r) => r.toLowerCase() === String(retailer).toLowerCase());
}

/** The shops that are off, for one honest line in the startup log. */
export function pausedList(settings: Settings): string {
  return (settings.pausedRetailers ?? []).join(', ');
}
