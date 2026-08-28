/**
 * Waiting for a page to finish.
 *
 * Type-only import of Page, so this module — and its tests — never load
 * Playwright. The decision of when a page is "done" is ordinary logic and
 * deserves to be tested like ordinary logic.
 */
import type { Page } from 'playwright';

/** What a page looks like once it has actually rendered. */
export interface PageRead {
  title: string;
  text: string;
  html: string;
  textLength: number;
  /** True when the page stopped growing on its own; false when we ran out of time. */
  settled: boolean;
  waitedMs: number;
}

/** The only thing settleRead needs from a page. Keeps the logic testable. */
export interface TextSource {
  text(): Promise<string>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export interface SettleOpts {
  /** Never settle below this much text — guards against an empty shell. */
  minText?: number;
  /** Milliseconds of no growth before we call the page finished. */
  settleForMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** A hard signal. When this matches we stop immediately, however young. */
  until?: (text: string) => boolean;
}

/**
 * Wait until a page has stopped changing, then hand back its text.
 *
 * The first version of this stopped the moment the text passed a threshold,
 * which on Target meant reading at 1,446 characters while React was still
 * hydrating: no price, no "Out of stock", nothing to act on. The screenshot
 * taken a beat later had all of it. A reader that stops at "enough characters"
 * is really asking "has the shell arrived", when the question is "has the page
 * finished". So: grow past minText, then hold still for settleForMs.
 *
 * `until` exists for the case where we know the exact thing we're waiting for —
 * stopping on that is faster and surer than waiting out a settle window.
 */
export async function settleRead(src: TextSource, opts: SettleOpts = {}): Promise<{
  text: string;
  settled: boolean;
  waitedMs: number;
}> {
  const minText = opts.minText ?? 500;
  const settleForMs = opts.settleForMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 400;

  const started = src.now();
  const deadline = started + timeoutMs;

  let text = '';
  let lastLength = -1;
  let stableMs = 0;

  for (;;) {
    text = await src.text().catch(() => '');
    const length = text.trim().length;

    if (opts.until?.(text)) {
      return { text, settled: true, waitedMs: src.now() - started };
    }

    // Only start counting stability once there's a real page to be stable about.
    if (length >= minText && length === lastLength) {
      stableMs += pollMs;
      if (stableMs >= settleForMs) {
        return { text, settled: true, waitedMs: src.now() - started };
      }
    } else {
      stableMs = 0;
    }
    lastLength = length;

    if (src.now() + pollMs > deadline) {
      return { text, settled: false, waitedMs: src.now() - started };
    }
    await src.wait(pollMs);
  }
}

/**
 * Wait for a page to actually have content, then read it.
 *
 * These are all client-rendered apps. `domcontentloaded` fires long before any
 * product exists in the DOM, so measuring then tells you the page is "nearly
 * empty" when it is merely young.
 */
export async function readWhenReady(page: Page, opts: SettleOpts = {}): Promise<PageRead> {
  const { text, settled, waitedMs } = await settleRead(
    {
      text: () => page.evaluate(() => document.body?.innerText ?? ''),
      wait: (ms) => page.waitForTimeout(ms),
      now: () => Date.now(),
    },
    opts,
  );

  const [title, html] = await Promise.all([
    page.title().catch(() => ''),
    page.content().catch(() => ''),
  ]);
  return { title, text, html, textLength: text.trim().length, settled, waitedMs };
}
