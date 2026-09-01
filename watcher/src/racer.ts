/**
 * Stop when you can answer the question, not when the page stops moving.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A read cost about 5.7 seconds, measured over thirty reads on 1 Sep 2026.
 * That number, not the pacing between reads, is what this system is actually
 * racing: the probe-limit test showed Target tolerating a check every five
 * seconds without complaint, which means the spacing could go below the cost
 * of a single look. Waiting faster does not help when looking is the slow part.
 *
 * Nearly all of that 5.7s was deliberate waiting. The old path navigated to
 * `domcontentloaded`, then held for two full seconds of the page's TEXT not
 * changing before reading anything. That rule was written for a real bug —
 * Target was being read mid-hydration at 1,446 characters with no price — but
 * it answers the question "has this page finished rendering?", and that is not
 * the question. The question is "do I know the state and the price yet?", and
 * on Target the answer never comes from the text at all: it comes from a JSON
 * response captured off the wire while React is still drawing.
 *
 * So: run the real reader on a loop, and stop the instant it gives a confident
 * answer. The stop condition is the deliverable itself, which cannot be fooled
 * by a page that renders early or one that keeps twitching forever.
 *
 * ── Why 'exact' and not 'anything' ──────────────────────────────────────────
 *
 * The readers already grade themselves. 'exact' means a state AND a price with
 * no contradiction between them — precisely what a decision needs. 'inferred'
 * means a state without a price, which is the shape a half-arrived page takes,
 * so stopping there would reintroduce the mid-hydration bug at a new address.
 *
 * An inferred read is kept as the fallback and handed back at the deadline:
 * "out of stock, no price" is worth reporting, it is just not worth stopping
 * early for.
 */
import type { ProductRead } from './readers/types.ts';

export interface RaceDeps {
  /** Run the real reader against the page as it stands right now. */
  read(): Promise<ProductRead>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export interface RaceOpts {
  /** How often to ask. */
  pollMs?: number;
  /** Give up waiting for 'exact' after this long. */
  timeoutMs?: number;
}

export interface RaceResult {
  /** The best answer we got, or null if the page never said anything usable. */
  read: ProductRead | null;
  /** True when we stopped early on a confident answer rather than timing out. */
  won: boolean;
  waitedMs: number;
  /** How many times we asked. Cheap to record and the thing to tune on. */
  polls: number;
}

/**
 * Ask the reader over and over until it knows the answer.
 *
 * The first poll happens immediately, before any wait: on Walmart the data is
 * `__NEXT_DATA__` in the initial HTML, so the answer can be there before the
 * first tick, and a loop that sleeps first would pay 120ms for nothing on
 * every single check of that retailer.
 */
export async function raceToRead(deps: RaceDeps, opts: RaceOpts = {}): Promise<RaceResult> {
  const pollMs = opts.pollMs ?? 120;
  const timeoutMs = opts.timeoutMs ?? 9000;

  const started = deps.now();
  const deadline = started + timeoutMs;

  let best: ProductRead | null = null;
  let polls = 0;

  for (;;) {
    polls += 1;
    // A reader that throws on a document that does not exist yet is normal at
    // this stage, not a failure. Keep asking.
    const read = await deps.read().catch(() => null);

    if (read && read.confidence === 'exact') {
      return { read, won: true, waitedMs: deps.now() - started, polls };
    }
    // Keep the best thing seen. A later poll that knows LESS — a page
    // mid-navigation, a body not captured yet — must not overwrite an answer
    // we already had.
    if (read && read.state !== 'unknown' && best === null) best = read;

    if (deps.now() + pollMs > deadline) {
      return { read: best, won: false, waitedMs: deps.now() - started, polls };
    }
    await deps.wait(pollMs);
  }
}
