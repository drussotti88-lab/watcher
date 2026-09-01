/**
 * One Phantom at a time.
 *
 * Two instances do not politely share: they share a Chrome profile directory,
 * and the second one to reach it gets "That Chrome profile is already open in
 * another process" on every check. Worse, they share nothing else — separate
 * pacers, so a retailer that told ONE of them to stand down keeps getting
 * knocked on by the other, which is the exact behaviour the pacer exists to
 * prevent.
 *
 * This happened for real on 1 Sep 2026: a restart script whose connection
 * dropped mid-wait launched a watcher, a second launch followed, and for five
 * minutes the two of them fought over the profile while Pokémon Center's
 * stand-down kept resetting.
 *
 * The lock is a file with a pid in it, checked with signal 0 — the standard
 * "does this process exist" probe, which sends nothing. Deliberately not
 * clever: no daemons, no ports, nothing to leave behind but a file a person
 * can delete.
 */

export interface LockDeps {
  /** The lock file's contents, or null when there is no lock file. */
  read(): string | null;
  write(text: string): void;
  remove(): void;
  /** Is there a live process with this pid? */
  alive(pid: number): boolean;
  /** This process's own pid. */
  pid: number;
}

export type LockResult = { ok: true } | { ok: false; heldBy: number };

/**
 * Claim the lock, or report who has it.
 *
 * A lock file naming a pid that is GONE is stale — a hard kill, a power cut, a
 * crash — and is taken over without ceremony. Refusing to start because of a
 * file left behind by a process that died last week is the failure mode that
 * makes people delete the lock and never think about it again.
 */
export function takeLock(deps: LockDeps): LockResult {
  const raw = deps.read();
  if (raw !== null) {
    const held = Number(String(raw).trim().split(/\s+/)[0]);
    // Our own pid in the file means a previous run of this same process left
    // it; that is ours to take, not a conflict.
    if (Number.isInteger(held) && held > 0 && held !== deps.pid && deps.alive(held)) {
      return { ok: false, heldBy: held };
    }
  }
  deps.write(`${deps.pid}\n${new Date().toISOString()}\n`);
  return { ok: true };
}

/**
 * Let it go — but only if it is still ours.
 *
 * An instance that lost the race must not delete the winner's lock on its way
 * out. That would turn one bad launch into a permanently unlocked system,
 * which is worse than the problem.
 */
export function releaseLock(deps: LockDeps): void {
  const raw = deps.read();
  if (raw === null) return;
  const held = Number(String(raw).trim().split(/\s+/)[0]);
  if (held !== deps.pid) return;
  deps.remove();
}

/** What to print when somebody else has it. Says how to get out of it. */
export function heldMessage(pid: number, path: string): string {
  return `
  Phantom is already running (pid ${pid}).

  Two of them fight over the same Chrome profile and keep separate pacers,
  so a retailer that told one to stand down still gets knocked on by the
  other. Only one runs at a time.

  To stop the one that is running:   npm run stop
  If nothing is really running:      delete ${path}
`;
}
