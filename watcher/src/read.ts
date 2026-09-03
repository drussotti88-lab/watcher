/**
 * Reading one listing, whichever retailer it is.
 *
 * Each of the three needs a different strategy, established by looking at real
 * pages rather than by reasoning about them:
 *
 *   Pokémon Center  schema.org JSON-LD, complete and in the page
 *   Target          nothing useful in the HTML; the price and stock arrive
 *                   after hydration in two separate API calls, so the page has
 *                   to be *listened to* rather than scraped
 *   Walmart         the whole product sits in the __NEXT_DATA__ blob
 *
 * This file is the only place that knows which is which.
 */
import type { Page, Response } from 'playwright';
import type { Browser } from './browser.ts';
import { detectChallenge } from './challenge.ts';
import { captureOddPage, worthCapturing } from './capture.ts';
import { raceToRead } from './racer.ts';
import { readWhenReady } from './settle.ts';
import { isInterestingApi } from './apisniff.ts';
import { offersFromLd } from './inspect.ts';
import { readTargetBodies } from './readers/target.ts';
import { readPokemonCenterOffers } from './readers/pokemoncenter.ts';
import { readWalmartNextData } from './readers/walmart.ts';
import type { ProductRead } from './readers/types.ts';
import { unknownRead } from './readers/types.ts';

export interface Reading extends ProductRead {
  /** True when the retailer served a bot check instead of a page. */
  challenged: boolean;
  challengeReason: string;
  imageUrl: string;
  ms: number;
}

/**
 * How hard to look, and for how long.
 *
 * 120ms because the overshoot is the cost: at the old 400ms poll a page that
 * became readable at t+1010 was reported at t+1200. At 120 the worst case is a
 * tenth of a second, and each look is one `page.evaluate` costing single-digit
 * milliseconds.
 *
 * 9s for the confident answer. Every clean read measured has come in under
 * three; anything past nine is not slow, it is wrong, and the fallback below
 * is what finds out which kind of wrong.
 */
const FAST_POLL_MS = 120;
const FAST_TIMEOUT_MS = 9_000;

/**
 * The fallback's own budget. Was 30s, which is what made a walled Pokémon
 * Center page cost half a minute EACH — and there were eight of them. The page
 * has already had nine seconds by the time we get here.
 */
const SLOW_TIMEOUT_MS = 10_000;

/**
 * A promise that cannot wait forever.
 *
 * ── The hang this exists for ────────────────────────────────────────────────
 *
 * On the evening of 1 Sep 2026 Phantom stopped reporting three times and
 * looked, each time, like a crash: the log ended mid-pass, no stack, no exit
 * line. It was not a crash. The process was ALIVE and stuck — which is the
 * worse failure, because a crash gets restarted by the supervisor and a hang
 * does not. The machine sat there for an hour with a drop running.
 *
 * The culprit is below: `response.text()` in Playwright has no timeout, and
 * the pass then waited on `Promise.all` of every captured body. One response
 * whose body never finishes arriving — a stalled connection, a request that
 * outlives the navigation that made it — and that await never returns. Nothing
 * downstream of it ever runs again.
 *
 * Two guards now. This one bounds each body, and pass() bounds the whole read,
 * because the lesson is not "that one await" — it is that ANY await against a
 * browser can be the one that never comes back.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(fallback); }
    }, ms);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

/** How long a single captured response body may take to arrive. */
const BODY_MS = 4_000;
/** How long the whole set of them may hold up a finished read. */
const BODIES_MS = 1_500;

/** Everything the readers need, pulled out of the page in one pass. */
interface Scraped {
  ld: unknown[];
  nextData: unknown;
  ogImage: string;
}

async function scrape(page: Page): Promise<Scraped> {
  // With `waitUntil: 'commit'` the first look can land before there is a
  // document to look at. That is a normal moment in the race, not a failure.
  return page.evaluate(() => {
    const ld: unknown[] = [];
    for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        ld.push(JSON.parse(el.textContent ?? ''));
      } catch {
        /* one malformed block must not lose the good ones */
      }
    }

    let nextData: unknown = null;
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd?.textContent) {
      try {
        nextData = JSON.parse(nd.textContent);
      } catch {
        /* ditto */
      }
    }

    // og:image, not a per-retailer selector. All three set it, it is one code
    // path, and it is the same URL their own share cards use.
    const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    const ogImage = og?.getAttribute('content') ?? '';

    return { ld, nextData, ogImage };
  });
}

/**
 * Load a listing and read it.
 *
 * The response listener is attached before navigating, because on Target the
 * calls that carry the price fire *during* hydration. Attach afterwards and
 * they are already gone.
 */
export async function readListing(
  browser: Browser,
  retailer: string,
  externalId: string,
  url: string,
): Promise<Reading> {
  const started = Date.now();
  const page = await browser.page();

  const bodies: unknown[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: Response): void => {
    const type = res.headers()['content-type'] ?? '';
    if (!isInterestingApi(res.url(), type)) return;
    pending.push(
      (async () => {
        const text = await withTimeout(res.text(), BODY_MS, '');
        if (!text || text.length > 4_000_000) return;
        try {
          bodies.push(JSON.parse(text));
        } catch {
          /* not JSON after all */
        }
      })().catch(() => {}),
    );
  };

  const fail = (note: string): Reading => ({
    ...unknownRead(note),
    challenged: false,
    challengeReason: '',
    imageUrl: '',
    ms: Date.now() - started,
  });

  page.on('response', onResponse);
  let lastOgImage = '';
  try {
    // `commit`, not `domcontentloaded`. We are not waiting for a lifecycle
    // event any more — the reader itself says when it knows the answer — so
    // returning the moment the response starts means the race below begins
    // one to two seconds earlier on a heavy app.
    await page.goto(url, { waitUntil: 'commit' });
    const navMs = Date.now() - started;

    // ── The race ────────────────────────────────────────────────────────────
    //
    // Ask the real reader every 120ms and stop the instant it is confident.
    // On Target the answer arrives on the wire, not in the DOM, so the old
    // two-second text-settle was two seconds spent watching something the
    // reader never looks at.
    const race = await raceToRead(
      {
        read: async () => {
          const scraped = await scrape(page);
          lastOgImage = scraped.ogImage || lastOgImage;
          return readFor(retailer, externalId, scraped, bodies);
        },
        wait: (ms) => page.waitForTimeout(ms),
        now: () => Date.now(),
      },
      { pollMs: FAST_POLL_MS, timeoutMs: FAST_TIMEOUT_MS },
    );

    if (race.won && race.read) {
      // Bounded. We want the bodies that arrived, not a promise that one more
      // is still coming — the reader has already said it knows the answer.
      await withTimeout(Promise.all(pending), BODIES_MS, [] as unknown[]);
      return {
        ...race.read,
        challenged: false,
        challengeReason: '',
        imageUrl: race.read.imageUrl || lastOgImage,
        ms: Date.now() - started,
      };
    }

    // ── The page did not answer ─────────────────────────────────────────────
    //
    // Either it is a wall, or it is genuinely slow. Both need the page's title
    // and text, which the race never asked for. The settle window is short
    // here on purpose: the page has already had FAST_TIMEOUT_MS of our
    // attention, and the reason we are down here is that watching it has not
    // been working.
    const read = await readWhenReady(page, {
      minText: 800,
      settleForMs: 1200,
      timeoutMs: SLOW_TIMEOUT_MS,
    });
    await withTimeout(Promise.all(pending), BODIES_MS, [] as unknown[]);

    const challenge = detectChallenge(read.title, read.text, read.html);
    if (challenge.challenged) {
      // Written down before we return. A waiting room is the artifact every
      // piece of future queue work is blocked on, and it exists for the length
      // of one drop.
      await captureOddPage({
        retailer,
        url: page.url(),
        title: read.title,
        text: read.text,
        html: read.html,
        reason: challenge.reason,
        screenshot: () => page.screenshot({ fullPage: false }),
      });
      return {
        ...unknownRead(`challenged: ${challenge.reason}`),
        challenged: true,
        challengeReason: challenge.reason,
        imageUrl: '',
        ms: Date.now() - started,
      };
    }

    const scraped = await scrape(page);
    const base = readFor(retailer, externalId, scraped, bodies);
    // A page that is not a known challenge and still has no product in it. On
    // Walmart that is what a waiting room looked like before tonight: the
    // detector missed it and the parser blamed itself. Capture decides it by
    // evidence rather than by the note's wording.
    if (worthCapturing(false, retailer, base.note)) {
      await captureOddPage({
        retailer,
        url: page.url(),
        title: read.title,
        text: read.text,
        html: read.html,
        reason: base.note,
        screenshot: () => page.screenshot({ fullPage: false }),
      });
    }
    // The best the race managed beats a last look that knows less — a body
    // that was captured and then a navigation that cleared the DOM would
    // otherwise turn "out of stock" back into "unknown".
    const answer = base.state === 'unknown' && race.read ? race.read : base;

    return {
      ...answer,
      challenged: false,
      challengeReason: '',
      // The reader's own answer wins. og:image is the fallback because it is
      // chosen for social previews — on a seasonal page it can be a banner
      // rather than the product, and that image then sticks forever, since the
      // Hub keeps the first one it is given.
      imageUrl: answer.imageUrl || scraped.ogImage || lastOgImage,
      ms: Date.now() - started,
      note: answer.note || `slow page: ${navMs}ms to first byte, ${race.polls} looks`,
    };
  } catch (err) {
    return fail(`could not read the page: ${(err as Error).message}`);
  } finally {
    page.off('response', onResponse);
  }
}

/** Dispatch. Pure, so the choice of reader is testable without a browser. */
export function readFor(
  retailer: string,
  externalId: string,
  scraped: Scraped,
  capturedBodies: unknown[],
): ProductRead {
  switch (retailer) {
    case 'Target':
      return readTargetBodies(capturedBodies, externalId);
    case 'Pokemon Center':
      return readPokemonCenterOffers(offersFromLd(scraped.ld), externalId);
    case 'Walmart':
      return readWalmartNextData(scraped.nextData, externalId);
    default:
      // Never guess. An unknown retailer has no reader, and inventing one from
      // whatever markup happens to be present is how a wrong price gets acted on.
      return unknownRead(`no reader for retailer "${retailer}"`);
  }
}
