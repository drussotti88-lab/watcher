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
        const text = await res.text().catch(() => '');
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
      await Promise.all(pending);
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
    await Promise.all(pending);

    const challenge = detectChallenge(read.title, read.text, read.html);
    if (challenge.challenged) {
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
