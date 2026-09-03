/**
 * Writing down a page we could not read.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `queues-are-signals.md` closed with the one thing blocking every piece of
 * queue work: joining a waiting room unattended needs a real captured queue
 * page to build against, and a queue only exists during a drop. So the capture
 * has to happen automatically, in the ordinary watching loop, at the moment it
 * occurs — nobody is going to be at the keyboard with devtools open at 9pm on
 * the right Wednesday.
 *
 * It also answers the quieter failure. Walmart's waiting room says none of
 * Queue-it's words, so for months a queue arrived as "no product node for
 * usItemId ... in __NEXT_DATA__" — a failure row that names the parser rather
 * than the page. Whether tonight's detector fires or not, the page itself is
 * now on disk and the question is settled by reading it.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * Nothing here is sent anywhere. A captured page is the logged-in DOM: it can
 * carry a session cookie's effects, a name, an address, a store id. It lands
 * under `logs/`, which is gitignored, and it stays on the machine that wrote
 * it until a person decides otherwise. The scrub that cleans activity lines is
 * deliberately NOT applied — a half-scrubbed artifact invites being treated as
 * safe to share, and this one never is.
 *
 * Every function is best-effort and swallows its own errors. A capture that
 * throws would turn an unreadable page into a crashed pass, which trades a
 * missing artifact for a missing check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CAPTURE_DIR = resolve('logs/queue');

/** Filesystem-safe, sortable, and readable at a glance in a directory listing. */
export function captureName(retailer: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${retailer.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${stamp}`;
}

export interface OddPage {
  retailer: string;
  url: string;
  title: string;
  text: string;
  html: string;
  /** Why we are writing it down: a challenge reason, or the reader's note. */
  reason: string;
  /** Optional: a screenshot, when the caller still has the page in hand. */
  screenshot?: () => Promise<Buffer>;
}

/**
 * Write one unreadable page to disk. Returns the folder, or '' if it could not.
 *
 * Text and HTML go to separate files rather than one JSON blob because the
 * first thing anybody does with a captured queue is read the text and grep the
 * markup, and both are miserable through JSON escaping.
 */
export async function captureOddPage(page: OddPage, at: Date = new Date()): Promise<string> {
  try {
    const dir = resolve(CAPTURE_DIR, captureName(page.retailer, at));
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      resolve(dir, 'meta.json'),
      JSON.stringify(
        {
          retailer: page.retailer,
          url: page.url,
          title: page.title,
          reason: page.reason,
          at: at.toISOString(),
          textLength: page.text.length,
          htmlLength: page.html.length,
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(dir, 'text.txt'), page.text);
    writeFileSync(resolve(dir, 'page.html'), page.html);

    // Last, and separately guarded: a screenshot is the nicest artifact and the
    // most likely to fail, because it needs a page that is still alive. Losing
    // it must not lose the HTML that was already written.
    if (page.screenshot) {
      try {
        writeFileSync(resolve(dir, 'screen.png'), await page.screenshot());
      } catch {
        /* the page went away; the markup is already safe */
      }
    }
    return dir;
  } catch {
    return '';
  }
}

/**
 * Is this page worth writing down?
 *
 * A challenge always is — that is the artifact we have been waiting for. An
 * ordinary unreadable page is worth it only where the parser had something to
 * say and could not: a Walmart page with no `__NEXT_DATA__` product node during
 * a drop is either a waiting room or a shape change, and both are answered by
 * looking at the page.
 *
 * Everything else is declined on purpose. "Capture every failure" fills the
 * disk with timeouts and makes the folder useless on the one night it matters.
 */
export function worthCapturing(challenged: boolean, retailer: string, note: string): boolean {
  if (challenged) return true;
  if (retailer !== 'Walmart') return false;
  return /no product node|__NEXT_DATA__/i.test(note);
}
