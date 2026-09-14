/**
 * Noticing a Walmart drawing, early and reliably.
 *
 * ── The whole job, and what it is not ───────────────────────────────────────
 *
 * A drawing is decided at random after its window closes, so an entry in the
 * first second is worth exactly what one an hour before close is worth. There
 * is no race here and this must not be built as though there were. The only
 * failure mode is not knowing a window opened — so the work is to LOOK, on a
 * sane cadence, and to shout once when something changes.
 *
 * That also settles the cadence argument before it starts. A drawing announced
 * days ahead, opening at a stated minute, does not need reading every sixty
 * seconds. It needs reading often enough to catch the announcement and to
 * notice the window opening within a few minutes — and Walmart is the shop
 * that put a press-and-hold in front of this house's own browsing in
 * September, so "often enough" is the most it gets.
 *
 * ── Why it reads while Walmart is switched off ──────────────────────────────
 *
 * Walmart product watching is off in this house's config, deliberately, and
 * this reads one page anyway. That is not a loophole: the shop toggle means
 * "stop working through my Walmart watchlist", and this is a single content
 * page on a slow clock whose whole purpose is to tell a person something they
 * asked to be told. Its own switch is `drawWatch` in the config, and turning
 * that off stops it dead.
 *
 * `neverTouch` still outranks everything, as it always has — a host on that
 * list is not contacted by anything in this program, and that is enforced in
 * the browser context rather than trusted to callers like this one.
 */
import type { Browser } from './browser.ts';
import { detectChallenge } from './challenge.ts';
import { readWhenReady } from './settle.ts';
import { nextData } from './readers/walmart-search.ts';
import {
  readWalmartDraw,
  drawEntryEnabled,
  type DrawRow,
} from './readers/walmart-draw.ts';

/** Walmart's page for this. One URL, and it has not moved since launch. */
export const DRAW_URL = 'https://www.walmart.com/shop/collectibles/draw';

export interface DrawScan {
  rows: DrawRow[];
  challenged: boolean;
  challengeReason: string;
  /** Walmart's own feature flag. Null when the page did not say. */
  entryEnabled: boolean | null;
  ms: number;
  note: string;
}

/**
 * How long between looks, in seconds.
 *
 * Three speeds, and the argument for each:
 *
 *   - **Nothing announced**: half an hour. Drawings arrive a few times a
 *     month; checking a quiet page every minute is how an address gets
 *     challenged, and the cost of hearing about an announcement twenty
 *     minutes late is nothing at all, because the window is days away.
 *
 *   - **Something announced, opening later**: still half an hour, until the
 *     last hour before the stated start.
 *
 *   - **Inside the hour before a start, or something already open**: two
 *     minutes. This is the only part that is time-sensitive, and even here
 *     two minutes is generous — being first buys nothing.
 */
export function drawInterval(rows: readonly DrawRow[], now: number = Date.now()): number {
  const SLOW = 30 * 60;
  const NEAR = 2 * 60;
  for (const row of rows) {
    if (row.phase === 'open') return NEAR;
    if (row.windowAt) {
      const until = Date.parse(row.windowAt) - now;
      // The hour before, and a grace period after: Walmart's stated minute and
      // the minute the button actually appears are not guaranteed to be the
      // same, and the reader refuses to infer one from the other.
      if (until < 60 * 60_000 && until > -3 * 60 * 60_000) return NEAR;
    }
  }
  return SLOW;
}

/**
 * Read the drawings page once.
 *
 * One page load, no clicks, nothing touched. Entering is a separate act with a
 * person behind it — an entry commits a payment method to a charge that lands
 * days later, and nothing in a polling loop is going to authorise one.
 */
export async function scanDraws(
  browser: Browser,
  now: number = Date.now(),
): Promise<DrawScan> {
  const started = Date.now();
  const page = await browser.page();
  const fail = (note: string): DrawScan => ({
    rows: [], challenged: false, challengeReason: '', entryEnabled: null,
    ms: Date.now() - started, note,
  });

  try {
    await page.goto(DRAW_URL, { waitUntil: 'domcontentloaded' });
    const read = await readWhenReady(page, { minText: 400, settleForMs: 2000, timeoutMs: 40_000 });

    const challenge = detectChallenge(read.title, read.text);
    if (challenge.challenged) {
      return {
        rows: [], challenged: true, challengeReason: challenge.reason,
        entryEnabled: null, ms: Date.now() - started,
        note: `challenged: ${challenge.reason}`,
      };
    }

    const data = nextData(await page.content());
    if (data === null) {
      // Said plainly rather than reported as "no drawings". Those look
      // identical in an empty list and mean opposite things: one is a quiet
      // week, the other is a page we can no longer read.
      return fail('no __NEXT_DATA__ on the drawings page — the shape has moved');
    }

    const rows = readWalmartDraw(data, now);
    return {
      rows,
      challenged: false,
      challengeReason: '',
      entryEnabled: drawEntryEnabled(data),
      ms: Date.now() - started,
      note: rows.length === 0 ? 'the page parsed, and is advertising no drawings' : '',
    };
  } catch (err) {
    return fail(`could not read the drawings page: ${(err as Error).message}`);
  }
}

/**
 * A reading turned into what the Hub's contract asks for.
 *
 * Written out field by field, and that is the whole point. The first version
 * posted `scan.rows` straight down the wire: the reader calls Walmart's id
 * `usItemId` and the Hub's contract calls it `externalId`, so every row was
 * silently skipped by a `if (!externalId) continue` and the endpoint answered
 * 200 with `recorded: 0`. Phantom logged four drawings, the Hub held none, and
 * both halves believed they had done their job — for two hours, two days
 * before the drawing this was built for.
 *
 * `toDiscovered` in scan.ts has done it this way all along, for this reason.
 * An explicit mapper is a place where a rename shows up as a type error
 * instead of as an empty table.
 */
export function toDrawingIn(row: DrawRow): {
  externalId: string;
  name: string;
  url: string;
  imageUrl: string;
  price: number | null;
  orderLimit: number | null;
  phase: string;
  windowLabel: string;
  windowText: string;
  windowAt: string | null;
} {
  return {
    externalId: row.usItemId,
    name: row.name,
    url: row.url,
    imageUrl: row.imageUrl,
    price: row.price,
    orderLimit: row.orderLimit,
    phase: row.phase,
    windowLabel: row.windowLabel,
    windowText: row.windowText,
    windowAt: row.windowAt,
  };
}

/**
 * What changed since last time, in the terms a person cares about.
 *
 * Edge-triggered on purpose. "A drawing is open" is true for hours and saying
 * it every two minutes is how a channel gets muted; "a drawing just opened" is
 * true once. The three that matter:
 *
 *   - **opened**   — the button is live. Go and enter.
 *   - **announced** — a new one has a date. Put it in the diary.
 *   - **gone**     — it was on the page and is not any more. Said because a
 *                    window you meant to enter and did not is worth knowing
 *                    about, and because it is how we learn how long they last.
 */
export interface DrawChange {
  kind: 'opened' | 'announced' | 'gone';
  row: DrawRow;
}

export function drawChanges(
  before: readonly DrawRow[],
  after: readonly DrawRow[],
): DrawChange[] {
  const was = new Map(before.map((r) => [r.usItemId, r]));
  const is = new Map(after.map((r) => [r.usItemId, r]));
  const out: DrawChange[] = [];

  for (const row of after) {
    const prior = was.get(row.usItemId);
    if (!prior) {
      // Brand new on the page. Open on arrival is the loud one; anything else
      // is a diary entry.
      out.push({ kind: row.phase === 'open' ? 'opened' : 'announced', row });
      continue;
    }
    if (row.phase === 'open' && prior.phase !== 'open') out.push({ kind: 'opened', row });
  }

  for (const row of before) {
    if (!is.has(row.usItemId)) out.push({ kind: 'gone', row });
  }
  return out;
}
