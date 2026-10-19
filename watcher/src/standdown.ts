/**
 * What Phantom remembers about walls across a restart.
 *
 * ── Why this is written down at all ──────────────────────────────────────────
 *
 * From 29 Sep 2026 Target walled the watch profile and stayed walled. Not one
 * Target reading landed after 2 Oct; in the week to 19 Oct Phantom walked into
 * that wall about 5,800 times. The pacer's stand-down did double, but it lived
 * in memory, so every restart (the keeper, an auto-update, a crash) set it
 * back to twenty minutes and the knocking started again. And the catalogue
 * sweep, which only counts as done when its last Target query lands, was
 * planned afresh every time the plan ran dry: thirteen Target searches into
 * the same wall, over and over.
 *
 * So two things are kept in a small file under logs/ (gitignored, never sent
 * anywhere): the pacer's stand-downs and listing rests, and when the last
 * sweep was planned. Nothing in it is a secret or names a person: shop names,
 * listing ids and timestamps.
 *
 * ── Fail open on watching ────────────────────────────────────────────────────
 *
 * A missing, unreadable or mangled file means starting from nothing, which is
 * exactly what happened before this file existed. It never stops a pass.
 */
import type { PacerSnapshot } from './rate.ts';

export const STANDDOWN_FILE = 'logs/standdowns.json';

/** When the last catalogue sweep was planned, and whether it has since finished. */
export interface SweepMemory {
  /** Epoch ms the last plan was built. */
  plannedAt: number;
  /**
   * True once the app has said "no sweep due" since that plan: the sweep
   * finished (or was switched off), so the next one due is a new sweep and
   * not a retry of a failed one.
   */
  settled: boolean;
}

export interface Remembered {
  pacer: PacerSnapshot | null;
  sweep: SweepMemory | null;
}

export interface MemoryDeps {
  /** The file's text, or null when there is none. May throw. */
  read: (path: string) => string | null;
  /** Replace the file's text. May throw. */
  write: (path: string, text: string) => void;
}

/** Read what an earlier run wrote. Anything wrong with it reads as nothing. */
export function loadMemory(deps: MemoryDeps, path = STANDDOWN_FILE): Remembered {
  const none: Remembered = { pacer: null, sweep: null };
  let text: string | null;
  try {
    text = deps.read(path);
  } catch {
    return none;
  }
  if (!text) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== 'object') return none;
  const o = parsed as { pacer?: unknown; sweep?: unknown };

  const pacer =
    o.pacer && typeof o.pacer === 'object' ? (o.pacer as PacerSnapshot) : null;

  let sweep: SweepMemory | null = null;
  if (o.sweep && typeof o.sweep === 'object') {
    const s = o.sweep as Partial<SweepMemory>;
    if (typeof s.plannedAt === 'number' && Number.isFinite(s.plannedAt)) {
      sweep = { plannedAt: s.plannedAt, settled: s.settled === true };
    }
  }
  return { pacer, sweep };
}

/** Write it down. Returns the error's message rather than throwing. */
export function saveMemory(
  deps: MemoryDeps,
  memory: Remembered,
  now: number,
  path = STANDDOWN_FILE,
): string | null {
  try {
    deps.write(
      path,
      JSON.stringify(
        { savedAt: new Date(now).toISOString(), pacer: memory.pacer, sweep: memory.sweep },
        null,
        2,
      ),
    );
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * The least time between two plans of a sweep that did not finish.
 *
 * A day, because a sweep is a daily thing to begin with: one that could not
 * finish today gets another go tomorrow, not another go the moment its plan
 * runs dry. The app keeps saying a sweep is due until the last Target query
 * lands, and while Target is walling us that is never.
 */
export const SWEEP_RETRY_MS = 24 * 60 * 60_000;

/**
 * May a new sweep be planned now?
 *
 * Yes when nothing was planned before, or the last one has settled (the app
 * has since said "not due"). Otherwise the last plan did not finish, and it
 * is retried once a day. That binds a hand-pressed sweep too: the app's
 * "asked for by hand" flag stays up until a sweep finishes, so it cannot tell
 * a fresh press from yesterday's, and letting it through would rebuild the
 * plan every pass just as before.
 */
export function mayPlanSweep(memory: SweepMemory | null, now: number): boolean {
  if (!memory) return true;
  if (memory.settled) return true;
  // A plan dated in the future means the clock moved; do not let that hold
  // the sweep off until the clock catches up.
  if (memory.plannedAt > now + 60_000) return true;
  return now - memory.plannedAt >= SWEEP_RETRY_MS;
}

/** When a retry would next be allowed, for the log. */
export function nextSweepAllowedAt(memory: SweepMemory | null): number | null {
  if (!memory || memory.settled) return null;
  return memory.plannedAt + SWEEP_RETRY_MS;
}
