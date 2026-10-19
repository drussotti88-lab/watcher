/**
 * When to hurry, and which shops to look at.
 *
 * Two settings that change the shape of a pass, kept together because they
 * answer the same question — what is this Phantom allowed to spend its next
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
 * a switch is leaving it on) or because a shop is showing STAGED STOCK.
 *
 * ── Why staged stock, and not a release date ─────────────────────────────────
 *
 * This used to open on "something on the watchlist releases today", and that
 * was the wrong signal wearing the right clothes. A release date is the
 * publisher's street date — the day a product first exists anywhere — and it
 * says nothing about whether THIS retailer has any, or when they will put it
 * up. Keying a burst to it bought a whole day of tightened pacing for an event
 * that might never come, and stayed silent for the thing we actually care
 * about: the 2am restock of a product released last March.
 *
 * Staged stock is the retailer's own inventory system saying the units are in
 * the building and not yet sellable. Measured 1 Sep 2026: ~30,000 units
 * readable against an unbuyable listing the evening before a 3am drop. That is
 * a drop being loaded, it is specific to this shop, and it ends by itself when
 * the stock sells — so the window opens on evidence and closes without anyone
 * remembering to close it.
 */
import type { Mission, Settings } from './hub.ts';
import { STOCK_LOADED_MIN } from './watch.ts';
import { LEAD_MINUTES, upcomingDrop } from './schedule.ts';

/**
 * Stock counted against a listing that cannot be sold yet.
 *
 * The same threshold the STOCK LOADED alarm uses, deliberately: the banner
 * that says a drop is near and the pacing that acts on it must never disagree
 * about what "near" means. Shelf quantities (8–20, display-capped) are below
 * it and cannot open a window.
 */
function staged(m: Mission): boolean {
  return (m.availableQuantity ?? 0) >= STOCK_LOADED_MIN && m.state !== 'in';
}

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
  /**
   * The shops the window is for. Null means every shop that is switched on,
   * which only a person can ask for (drop mode in the app).
   *
   * ── Why a window names its shops ────────────────────────────────────────
   *
   * Until 19 Oct 2026 a window was one yes-or-no for the whole machine. So
   * Walmart's Wednesday 8pm slot tightened Target's and Pokémon Center's
   * spacing to the burst floor and woke every resting listing at both, for
   * fifty minutes a week, and it did so even while Walmart was switched off.
   * Evidence of a drop at one shop says nothing about any other.
   */
  retailers: string[] | null;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === String(b).toLowerCase();

function shopsOf(ms: readonly Mission[]): string[] {
  const out: string[] = [];
  for (const m of ms) if (!out.some((r) => same(r, m.retailer))) out.push(m.retailer);
  return out;
}

/**
 * Does this window cover this shop? Open, switched on, and named (or a
 * manual window, which names every shop that is on).
 */
export function windowCovers(window: DropWindow, settings: Settings, retailer: string): boolean {
  if (!window.open) return false;
  if (!retailerOn(settings, retailer)) return false;
  if (window.retailers === null) return true;
  return window.retailers.some((r) => same(r, retailer));
}

/**
 * Is a drop window open right now?
 *
 * A manual window wins on its own; staged stock opens one on evidence. Both
 * require `burstSpacingSeconds` to be set at all — with no burst configured
 * there is nothing to open, and claiming a window while pacing normally would
 * put a lie in the log.
 */
export function dropWindow(
  settings: Settings,
  missions: readonly Mission[],
  now: number,
): DropWindow {
  const shut: DropWindow = { open: false, reason: '', retailers: [] };
  if (!settings.burstSpacingSeconds || settings.burstSpacingSeconds <= 0) return shut;

  const until = String(settings.dropModeUntil ?? '');
  if (until) {
    const t = Date.parse(until);
    if (Number.isFinite(t) && t > now) {
      const mins = Math.ceil((t - now) / 60_000);
      return { open: true, reason: `drop mode is on for another ${mins}m`, retailers: null };
    }
  }

  const naming = (ms: readonly Mission[]): string => {
    const names = ms.slice(0, 2).map((m) => m.productName).join(', ');
    return names + (ms.length > 2 ? ` +${ms.length - 2} more` : '');
  };

  /*
   * ── A drop with an appointment ──────────────────────────────────────────
   *
   * Checked before staged stock because it is the more certain signal: staged
   * stock infers a drop from inventory, this one knows the hour. Walmart's
   * queue drops land at 8pm Chicago on Wednesdays, and on 2 Sep 2026 the first
   * alert was thirty-four seconds after the hour. Nothing about waiting for
   * that by luck is defensible once you know the time.
   *
   * It opens five minutes early and shuts forty-five minutes later on its own.
   * It opens only for the shop whose slot it is, and not at all when that
   * shop is switched off: until 19 Oct 2026 it ignored the switch, and a
   * paused Walmart still tightened everyone else's pace every Wednesday.
   */
  const scheduled = upcomingDrop(new Date(now), LEAD_MINUTES);
  if (scheduled?.running && retailerOn(settings, scheduled.slot.retailer)) {
    const when =
      scheduled.minutesUntil > 0
        ? `in ${scheduled.minutesUntil}m`
        : `${scheduled.minutesSince}m ago`;
    return {
      open: true,
      reason: `scheduled ${scheduled.slot.retailer} drop, ${when}`,
      retailers: [scheduled.slot.retailer],
    };
  }

  // A switched-off shop's missions are not evidence of anything we will act
  // on, so they open nothing.
  const on = missions.filter((m) => m.enabled && retailerOn(settings, m.retailer));
  const loaded = on.filter((m) => staged(m));
  if (loaded.length) {
    return { open: true, reason: `stock staged: ${naming(loaded)}`, retailers: shopsOf(loaded) };
  }

  // A drop that has actually opened, on a mission that means to buy. Narrow on
  // purpose: without it the window would shut at the exact moment the staged
  // stock became sellable, which is the moment speed is worth most. It is
  // self-limiting — a completed buy disarms its mission.
  const live = on.filter((m) => m.armed && m.state === 'in');
  if (live.length) {
    return { open: true, reason: `live and armed: ${naming(live)}`, retailers: shopsOf(live) };
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
  const same = (r: string) => r.toLowerCase() === String(retailer).toLowerCase();
  if ((settings.pausedRetailers ?? []).some(same)) return false;
  // The exception to "unknown shops are on": a shop that ships OFF until the
  // owner switches it on. Best Buy (19 Oct 2026) is read from this house's
  // address only once he has said so.
  if (OPT_IN_RETAILERS.some(same)) return (settings.enabledRetailers ?? []).some(same);
  return true;
}

/** Shops that are off until switched on. Mirrors store.OPT_IN_RETAILERS in the app. */
export const OPT_IN_RETAILERS: readonly string[] = ['Best Buy'];

/** The shops that are off, for one honest line in the startup log. */
export function pausedList(settings: Settings): string {
  return (settings.pausedRetailers ?? []).join(', ');
}
