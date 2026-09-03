/**
 * Take a place in Walmart's line, and hold it.
 *
 *   node --experimental-strip-types scripts/hold-my-place.ts <usItemId> [minutes]
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * Walmart's queue drops are at 8pm America/Chicago. Opening the item at 8:00:00
 * redirects to a waiting room, and a place in that line is the scarce thing —
 * scarce from the second it opens, and gone while you are finding the tab.
 *
 * This opens the item on the BUY profile, joins the line if there is one, and
 * then waits. That is the whole job. It is the front door used as designed, at
 * the speed a machine can use it.
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 *
 * It never signs in. The buy profile is signed in by a person running
 * `npm run signin`, and this refuses to start if that has not happened —
 * loudly, rather than sitting on a sign-in page until the drop is over.
 *
 * It never answers a bot check. PerimeterX's "Robot or human? Activate and
 * hold" is a person's job. When it appears this captures the page, shouts, and
 * stops with Chrome open so you can finish by hand.
 *
 * It never refreshes while queued. Every guide to this queue says the same
 * thing, and it is the one way to throw away a place you already have.
 *
 * It does not click anything unverified. Every Walmart selector is
 * `verified: false` until a person has matched it against a real page — the
 * same discipline Target's place-order button went through. So on the FIRST
 * real run this reaches the queue, holds the line, captures what it sees, and
 * hands over. That capture is what promotes the selectors, and the run after
 * it can go further.
 *
 * ── Headed, always ──────────────────────────────────────────────────────────
 *
 * Chrome stays visible. If this hands back at any point, the window it hands
 * back is one you can take over mid-queue without losing the place.
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { detectChallenge } from '../src/challenge.ts';
import { captureOddPage } from '../src/capture.ts';
import { findControl, looksSignedIn, queueStateFrom } from '../src/checkout/walmart.ts';

/** How often to look while holding a place. Gentle: this is waiting, not racing. */
const POLL_MS = 5_000;

const stamp = (): string => new Date().toLocaleTimeString('en-US');
const say = (msg: string): void => console.log(`  ${stamp()}  ${msg}`);

async function main(): Promise<void> {
  const itemId = String(process.argv[2] ?? '').trim();
  const minutes = Number(process.argv[3] ?? 60);
  if (!/^\d+$/.test(itemId)) {
    console.error('\n  need a Walmart usItemId, e.g. 20243261734\n');
    process.exit(1);
  }
  const url = `https://www.walmart.com/ip/${itemId}`;
  const config = loadConfig();
  config.browser.headed = true;

  // The BUY profile: signed in, opened rarely, kept away from the watching.
  const browser = new Browser(config, 'buy');
  const page = await browser.page();

  console.log(`\n  Holding a place for item ${itemId}`);
  console.log('  Chrome stays open. Nothing is bought without the gates passing.\n');

  // ── Prove the sign-in before the drop, not during it ──────────────────────
  await page.goto('https://www.walmart.com/account', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (!(await looksSignedIn(page))) {
    console.error(
      '\n  NOT SIGNED IN on the buy profile.\n' +
        '  Stop, run `npm run signin`, log in to Walmart by hand, then start this again.\n' +
        '  A signed-out browser cannot take a place in line at all.\n',
    );
    return;
  }
  say('buy profile is signed in');

  const until = Date.now() + minutes * 60_000;
  let joined = false;
  let looks = 0;

  while (Date.now() < until) {
    looks += 1;
    // The ONLY navigation, and only while not yet holding a place. Once queued
    // this loop reads the open page and never reloads it.
    if (!joined) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);

    const here = page.url();
    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const html = await page.content().catch(() => '');
    const { challenged, reason } = detectChallenge(title, text, html, here);
    const state = queueStateFrom(here, text, challenged);

    if (state === 'challenged') {
      await captureOddPage({
        retailer: 'Walmart', url: here, title, text, html,
        reason: `bot check while holding a place: ${reason}`,
        screenshot: () => page.screenshot({ fullPage: false }),
      });
      console.log(`\n  *** ${reason.toUpperCase()} ***`);
      console.log('  This one is yours. Finish it in the open Chrome window —');
      console.log('  the place in line survives if you do it there.\n');
      return;
    }

    if (state === 'needs-signin') {
      console.error('\n  The queue is asking for a sign-in. Sign in in the open window.\n');
      return;
    }

    if (state === 'queued') {
      if (!joined) {
        await captureOddPage({
          retailer: 'Walmart', url: here, title, text, html,
          reason: 'THE SIGNED-IN QUEUE PAGE — first ever capture',
          screenshot: () => page.screenshot({ fullPage: false }),
        });
        say('QUEUE IS UP — page captured');
      }
      // Look for the join control. Reading is always allowed; clicking is not,
      // until a person has promoted the selector from a capture like the one
      // just written.
      const join = await findControl(page, 'joinLine', 'read');
      if (join.found && !joined) {
        try {
          const clickable = await findControl(page, 'joinLine', 'click');
          await page.locator(clickable.selector).first().click();
          joined = true;
          say('joined the line');
        } catch {
          console.log(`\n  Found a join control (${join.selector}) and will not click it:`);
          console.log('  it has never been verified against a real page.');
          console.log('  Click it yourself in the open window — the place is then held,');
          console.log('  and this capture is what promotes the selector for next week.\n');
          joined = true;
        }
      } else if (!join.found && !joined) {
        console.log('\n  Queue is up and no join control matched any known wording.');
        console.log('  Take the place by hand in the open window. The page is captured.\n');
        joined = true;
      }
      const pos = await findControl(page, 'queuePosition', 'read');
      if (pos.found) {
        const t = await page.locator(pos.selector).first().innerText().catch(() => '');
        if (t) say(`holding: ${t.replace(/\s+/g, ' ').slice(0, 70)}`);
      } else if (looks % 6 === 0) {
        say('still holding — not refreshing');
      }
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    if (state === 'product') {
      if (joined) {
        console.log('\n  *** THROUGH THE QUEUE — the product page is open. ***');
        console.log('  Chrome is yours. Buy it in that window.\n');
        await captureOddPage({
          retailer: 'Walmart', url: here, title, text, html,
          reason: 'through the queue — the page after a held place',
          screenshot: () => page.screenshot({ fullPage: false }),
        });
        return;
      }
      say(`no queue yet (${looks}) — ordinary product page`);
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    await captureOddPage({
      retailer: 'Walmart', url: here, title, text, html,
      reason: 'unrecognised page while holding a place',
      screenshot: () => page.screenshot({ fullPage: false }),
    });
    say('unrecognised page — captured, still looking');
    await page.waitForTimeout(POLL_MS);
  }

  console.log('\n  Time is up. Chrome stays open.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
