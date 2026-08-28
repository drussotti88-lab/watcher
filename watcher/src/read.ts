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

/** Everything the readers need, pulled out of the page in one pass. */
interface Scraped {
  ld: unknown[];
  nextData: unknown;
  ogImage: string;
}

async function scrape(page: Page): Promise<Scraped> {
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
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Settle rather than stop at a character count: the price is one of the
    // last things to land, so "enough text" is not the same as "finished".
    const read = await readWhenReady(page, { minText: 800, settleForMs: 2000, timeoutMs: 30_000 });
    await Promise.all(pending);

    const challenge = detectChallenge(read.title, read.text);
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

    return {
      ...base,
      challenged: false,
      challengeReason: '',
      imageUrl: scraped.ogImage,
      ms: Date.now() - started,
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
