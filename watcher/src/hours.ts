/**
 * When to be awake.
 *
 * Target runs its scheduled drops in the small hours, so polling all afternoon
 * is traffic spent on a page that will not change. That is not merely wasteful:
 * traffic is the one thing that earns a challenge, and a Watcher standing down
 * for four hours because it annoyed Target at lunchtime is a Watcher that is
 * off the air at 3am when it matters.
 *
 * ── What this deliberately does not decide ──────────────────────────────────
 *
 * Only the clock. Whether an explicit "check now" or a box dropping today
 * should override the window is a judgement about intent, and it belongs in the
 * loop where both are visible. A quiet-hours rule that swallowed a button press
 * would make the button a liar.
 */
import type { Settings } from './hub.ts';

/** Minutes since midnight, in whatever zone the window is written in. */
export function localMinutes(now: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  });
  let hours = 0;
  let minutes = 0;
  for (const part of fmt.formatToParts(now)) {
    if (part.type === 'hour') hours = Number(part.value);
    if (part.type === 'minute') minutes = Number(part.value);
  }
  // Some locales render midnight as 24. Fold it, or "24:10" sorts after
  // everything and the window never opens.
  if (hours === 24) hours = 0;
  return hours * 60 + minutes;
}

function toMinutes(hhmm: string): number | null {
  const parts = hhmm.split(':');
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export interface Wakefulness {
  awake: boolean;
  /** Said in words, for the line the loop prints. */
  reason: string;
  /** Milliseconds until the window opens. Null when awake or paused. */
  opensInMs: number | null;
}

/**
 * Should the Watcher be looking at pages right now?
 *
 * A window may cross midnight — 22:00 to 06:00 is one window, not two — which
 * is the case that a naive `from <= now && now < until` gets exactly backwards,
 * and it is also the shape of every window anyone would actually set here.
 */
export function isAwake(settings: Settings, now: Date = new Date()): Wakefulness {
  if (settings.paused) {
    return { awake: false, reason: 'paused — the master switch is off', opensInMs: null };
  }

  const from = toMinutes(settings.activeFrom ?? '');
  const until = toMinutes(settings.activeUntil ?? '');
  if (from === null || until === null || from === until) {
    return { awake: true, reason: '', opensInMs: null };
  }

  const nowMin = localMinutes(now, settings.timezone ?? '');
  const inside =
    from < until
      ? nowMin >= from && nowMin < until
      : nowMin >= from || nowMin < until; // the window wraps past midnight

  if (inside) return { awake: true, reason: '', opensInMs: null };

  const untilOpen = (from - nowMin + 1440) % 1440;
  const zone = settings.timezone ? ` ${settings.timezone}` : '';
  return {
    awake: false,
    reason:
      `outside watching hours (${settings.activeFrom}–${settings.activeUntil}${zone})` +
      ` — opens in ${describe(untilOpen)}`,
    // Never zero: a zero here would make the loop spin.
    opensInMs: Math.max(untilOpen, 1) * 60_000,
  };
}

function describe(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Reasons to look anyway.
 *
 * Quiet hours are about not wasting requests on a page that will not change.
 * They are not a reason to ignore something you asked for by hand, and they are
 * not a reason to sleep through a release day — Target's published street date
 * is the one moment we know the page *will* change.
 */
export function overrides(
  missions: { checkNow?: boolean; releaseDate?: string | null }[],
  today: string,
): string {
  if (missions.some((m) => m.checkNow)) return 'a check was asked for by hand';
  if (missions.some((m) => m.releaseDate && String(m.releaseDate).slice(0, 10) === today)) {
    return 'something drops today';
  }
  return '';
}
