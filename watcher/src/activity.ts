/**
 * The activity log, written here and posted there.
 *
 * Until now everything the Watcher knew about its own health lived in a
 * terminal window and died with it. "It's failing a lot" was a true statement
 * nobody could act on, because by the time anyone looked, the reasons had
 * scrolled away. This is the fix: one line per check, kept.
 *
 * ── Two destinations, on purpose ─────────────────────────────────────────────
 *
 * Every line is written to a local file *and* queued for the Hub. Not
 * redundancy for its own sake — they fail at different times and that is the
 * point. The Hub is where the log is readable from a phone, and it is exactly
 * the thing that is unreachable when the interesting failures happen. The
 * local file is what still has the answer afterwards.
 *
 * ── Scrubbed before it is written, not before it is sent ─────────────────────
 *
 * scrub() runs in record(), which is upstream of both destinations. Doing it
 * at send time would leave the raw text sitting on disk, and "we clean it up
 * on the way out" is a promise that only holds until something reads the file.
 *
 * ── Nothing here may break a pass ────────────────────────────────────────────
 *
 * A logger that can throw turns a diagnostic into an outage. Every method
 * swallows its own failures; the worst case is that a line is lost, which is
 * strictly better than losing the check it was describing.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scrub } from './scrub.ts';

export interface ActivityLine {
  at?: string;
  kind: 'check' | 'pass' | 'hub' | 'browser' | 'startup' | 'sweep';
  level?: 'info' | 'warn' | 'error';
  retailer?: string;
  missionId?: number | null;
  listingId?: number | null;
  state?: string;
  price?: number | null;
  ms?: number | null;
  availableQuantity?: number | null;
  message: string;
  detail?: string;
}

/** What the log needs from the Hub. Narrow on purpose, so tests need no Hub. */
export interface ActivitySink {
  recordActivity(lines: ActivityLine[]): Promise<boolean>;
}

export interface ActivityOptions {
  sink?: ActivitySink;
  /** Literal values to remove by value — this Watcher's own token, and so on. */
  secrets?: readonly string[];
  /** Where the local files go. Blank disables the local half. */
  dir?: string;
  /** How many days of local files to keep. */
  keepDays?: number;
  /** Post once the queue reaches this. Small enough to be current, big enough
   *  not to make a request per check. */
  batchSize?: number;
  /**
   * Send anyway once the oldest line has waited this long.
   *
   * Batching alone means up to `batchSize` lines sit in memory indefinitely on
   * a quiet watchlist — and they are lost outright if the process is killed
   * rather than asked to stop, which is how nearly an hour of checks went
   * missing from the Hub while the local file had them all.
   */
  flushAfterMs?: number;
  /** Stop buffering past this, and say so, rather than eating the heap. */
  maxQueue?: number;
  now?: () => number;
}

export class Activity {
  private readonly sink: ActivitySink | null;
  private readonly secrets: readonly string[];
  private readonly dir: string;
  private readonly keepDays: number;
  private readonly batchSize: number;
  private readonly flushAfterMs: number;
  private readonly maxQueue: number;
  private readonly now: () => number;

  private queue: ActivityLine[] = [];
  /** When the oldest unsent line was queued. Zero when the queue is empty. */
  private queuedSince = 0;
  private dropped = 0;
  private lastFileError = '';

  constructor(opts: ActivityOptions = {}) {
    this.sink = opts.sink ?? null;
    this.secrets = opts.secrets ?? [];
    this.dir = opts.dir ?? '';
    this.keepDays = opts.keepDays ?? 7;
    this.batchSize = Math.max(1, opts.batchSize ?? 25);
    this.flushAfterMs = Math.max(1000, opts.flushAfterMs ?? 120_000);
    this.maxQueue = Math.max(this.batchSize, opts.maxQueue ?? 2000);
    this.now = opts.now ?? Date.now;
    if (this.dir) {
      try {
        mkdirSync(resolve(this.dir), { recursive: true });
        this.sweepOldFiles();
      } catch (err) {
        this.lastFileError = (err as Error).message;
      }
    }
  }

  /** Lines waiting to reach the Hub. Printed by the loop so a stall is visible. */
  get backlog(): number {
    return this.queue.length;
  }

  /** Lines thrown away because the queue was full. Never silently zero. */
  get lost(): number {
    return this.dropped;
  }

  get fileError(): string {
    return this.lastFileError;
  }

  /**
   * Record one line. Scrubs, writes it to disk, queues it for the Hub.
   *
   * Returns the scrubbed line, which is what the tests assert on and what the
   * caller may print — printing the unscrubbed original to a terminal that
   * ends up in a screenshot is the same leak by a slower route.
   */
  record(line: ActivityLine): ActivityLine {
    const clean: ActivityLine = {
      ...line,
      at: line.at ?? new Date(this.now()).toISOString(),
      // Defaulted here rather than only on the Hub, so the local file and the
      // uploaded row say the same thing. They did not, and a log that reads
      // differently depending on where you read it is a log you cannot trust.
      level: line.level ?? 'info',
      message: scrub(line.message ?? '', this.secrets),
      ...(line.detail === undefined ? {} : { detail: scrub(line.detail, this.secrets) }),
      ...(line.retailer === undefined ? {} : { retailer: scrub(line.retailer, this.secrets) }),
    };

    this.write(clean);

    if (this.queue.length >= this.maxQueue) {
      // Drop the oldest. A log that stops recording the moment things go wrong
      // is a log that is missing precisely the part you needed.
      this.queue.shift();
      this.dropped += 1;
    }
    if (this.queue.length === 0) this.queuedSince = this.now();
    this.queue.push(clean);
    return clean;
  }

  /** Send what is queued. Never throws; a failure leaves the queue intact. */
  async flush(force = false): Promise<{ sent: number; queued: number }> {
    if (!this.sink) return { sent: 0, queued: this.queue.length };
    if (this.queue.length === 0) return { sent: 0, queued: 0 };
    // Full enough, old enough, or asked. Age is what stops a quiet watchlist
    // holding a dozen lines in memory until something kills the process.
    const waited = this.now() - this.queuedSince;
    if (!force && this.queue.length < this.batchSize && waited < this.flushAfterMs) {
      return { sent: 0, queued: this.queue.length };
    }

    const batch = this.queue.slice(0, 200);
    try {
      const ok = await this.sink.recordActivity(batch);
      if (!ok) return { sent: 0, queued: this.queue.length };
      this.queue.splice(0, batch.length);
      this.queuedSince = this.queue.length ? this.now() : 0;
      return { sent: batch.length, queued: this.queue.length };
    } catch {
      // Deliberately silent. The Hub being unreachable is already reported by
      // the loop; a logger complaining about not being able to log is noise on
      // top of the real signal.
      return { sent: 0, queued: this.queue.length };
    }
  }

  /** One file per day of NDJSON, so a day can be read or deleted on its own. */
  private write(line: ActivityLine): void {
    if (!this.dir) return;
    try {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      appendFileSync(join(resolve(this.dir), `activity-${day}.ndjson`), JSON.stringify(line) + '\n');
      this.lastFileError = '';
    } catch (err) {
      this.lastFileError = (err as Error).message;
    }
  }

  /** Keep the local copy bounded the same way the Hub's table is. */
  private sweepOldFiles(): void {
    const cutoff = this.now() - this.keepDays * 86400_000;
    for (const name of readdirSync(resolve(this.dir))) {
      if (!name.startsWith('activity-') || !name.endsWith('.ndjson')) continue;
      const path = join(resolve(this.dir), name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path);
      } catch {
        /* a file we cannot stat is a file we leave alone */
      }
    }
  }
}
