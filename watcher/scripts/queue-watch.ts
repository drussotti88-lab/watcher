/**
 * Sit on Walmart during a drop and write down anything that is not a shop.
 *
 * ── Why this exists, and why it is a script rather than a feature ────────────
 *
 * A waiting room exists for the length of one drop and not one minute longer.
 * Every piece of queue work we have wanted to build — joining a line, holding
 * a place, knowing what "you are through" looks like — has been blocked on
 * never having seen one, and it will stay blocked until somebody is pointed at
 * the right page at the right minute.
 *
 * The watcher captures queues now too, but only for listings with a live
 * mission at a shop that is switched on. This script needs neither: it is a
 * person's eyes, pointed by hand, and it runs when the Hub says nothing is
 * being watched at all.
 *
 * ── What it does, and what it refuses to do ─────────────────────────────────
 *
 * Polls a handful of Walmart URLs at a polite interval and writes any page
 * that is not an ordinary product or browse page into logs/queue/. That is
 * all. It does not click, join, hold, refresh aggressively, or answer
 * anything. A queue is joined by a person; a bot check is answered by a
 * person. This only makes sure that when either appears, we have the page.
 *
 *   node --experimental-strip-types scripts/queue-watch.ts [minutes]
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { detectChallenge, isQueue } from '../src/challenge.ts';
import { captureOddPage } from '../src/capture.ts';

/**
 * A queue is site-wide, so the cheapest page that can show one is the best
 * page to watch. The category is included because a drop's new listings appear
 * there before anybody has a direct link to them.
 */
const URLS = [
  'https://www.walmart.com/',
  'https://www.walmart.com/browse/toys/pokemon-trading-cards/4171_4187_1229464_9634758',
];

/** Polite, and deliberately not tuned for speed: we are watching, not racing. */
const EVERY_MS = 25_000;

async function main(): Promise<void> {
  const minutes = Number(process.argv[2] ?? 90);
  const config = loadConfig();
  // Never the watch profile: Phantom owns it, and two Chromes on one profile
  // directory is how you lose both. This one keeps its history between runs —
  // a profile with no past is the thing the bot checks are looking for.
  config.browser.watchProfileDir = './chrome-profile-queue';
  config.browser.headed = true;

  const browser = new Browser(config, 'watch');
  const page = await browser.page();
  const until = Date.now() + minutes * 60_000;
  let captures = 0;
  let pass = 0;

  console.log(`watching Walmart for ${minutes} minutes — Ctrl+C to stop`);
  console.log('captures land in logs/queue/. Nothing is sent anywhere.\n');

  while (Date.now() < until) {
    pass += 1;
    for (const url of URLS) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(2500);

        const title = await page.title().catch(() => '');
        const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        const html = await page.content().catch(() => '');
        const { challenged, reason } = detectChallenge(title, text, html);

        // Two ways to be interesting. The detector firing is the good case.
        // The other is the case that has bitten us before: a page nobody
        // recognises, which is exactly what a waiting room looked like for
        // months. When in doubt during a drop, keep the page.
        const looksThin = text.trim().length < 1200;
        if (challenged || looksThin) {
          const dir = await captureOddPage({
            retailer: 'Walmart',
            url: page.url(),
            title,
            text,
            html,
            reason: challenged ? reason : `unrecognised page, ${text.trim().length} chars of text`,
            screenshot: () => page.screenshot({ fullPage: false }),
          });
          captures += 1;
          const label = challenged ? reason : 'thin page';
          console.log(`  ${new Date().toLocaleTimeString()}  CAPTURED ${label} -> ${dir}`);
          if (challenged && isQueue(reason)) {
            console.log('  *** WAITING ROOM. GO GET IN LINE YOURSELF, NOW. ***');
          }
        } else {
          console.log(
            `  ${new Date().toLocaleTimeString()}  pass ${pass}: ordinary page (${text.trim().length} chars) ${url.slice(24, 60)}`,
          );
        }
      } catch (err) {
        console.log(`  ${new Date().toLocaleTimeString()}  ${(err as Error).message.slice(0, 90)}`);
      }
    }
    await page.waitForTimeout(EVERY_MS);
  }

  console.log(`\ndone. ${captures} captures written to logs/queue/`);
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
