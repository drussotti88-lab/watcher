/**
 * Watch the item, and the instant it moves, open it in YOUR browser.
 *
 *   node --experimental-strip-types scripts/hold-my-place.ts <usItemId> [minutes]
 *
 * ── What changed, and why ───────────────────────────────────────────────────
 *
 * The first version of this opened the signed-in buy profile and meant to
 * join the queue itself. On 3 Sep 2026 that profile was served Walmart's
 * "Robot or human? Activate and hold" on its first page, and the check FAILED
 * WITH A PERSON HOLDING THE BUTTON — the same way Target's had. The
 * press-and-hold does not test the finger; it scores the browser, and a
 * Playwright-launched Chrome announces that it is automated (we removed the
 * flag that hides that, deliberately, on 1 Sep). Both retailers fail it on
 * purpose. The only way through is to make the browser lie about itself, and
 * that is the line this project does not cross.
 *
 * So a Phantom-launched browser cannot get through Walmart's front door, and
 * no amount of selector work changes that. What CAN get through is the Chrome
 * you use every day: not automated, signed in, extensions and all. What it
 * lacks is eyes on the page at 8:00:00.
 *
 * This is the honest join of the two. It watches from the signed-out profile
 * — which reads product pages fine; the wall is on account and checkout
 * paths, not the PDP — and the moment the page turns into a queue or the cart
 * button lights up, it opens that URL in your default browser. Not driving
 * it: Playwright never touches that window. It is `start <url>`, the same as
 * you double-clicking a link, one second after Phantom saw it move.
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 *
 * It opens your browser ONCE per run and never again — a second pop while
 * you are mid-queue would steal focus at the worst possible moment. It never
 * answers a bot check. It never refreshes the window it opened, because it
 * cannot see it and does not try. Every unfamiliar page is captured.
 */
import { exec } from 'node:child_process';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { detectChallenge, isQueueUrl } from '../src/challenge.ts';
import { captureOddPage } from '../src/capture.ts';
import { readWalmartNextData } from '../src/readers/walmart.ts';

/** How often to look. Tight, because this only runs for the minutes that matter. */
const POLL_MS = 4_000;

const stamp = (): string => new Date().toLocaleTimeString('en-US');
const say = (msg: string): void => console.log(`  ${stamp()}  ${msg}`);

/**
 * Open a URL in the machine's default browser — the person's own Chrome.
 *
 * `start` on Windows, `open` on macOS, `xdg-open` elsewhere. None of these
 * hand us a handle to the window, which is the point: nothing here can drive
 * it, so nothing about it looks automated.
 */
function openInRealBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error(`  could not open your browser: ${err.message}`);
  });
}

async function main(): Promise<void> {
  const itemId = String(process.argv[2] ?? '').trim();
  const minutes = Number(process.argv[3] ?? 60);
  if (!/^\d+$/.test(itemId)) {
    console.error('\n  need a Walmart usItemId, e.g. 20243261734\n');
    process.exit(1);
  }
  const url = `https://www.walmart.com/ip/${itemId}`;
  const config = loadConfig();
  // Its own copy of the watch profile, so the running Phantom keeps its own.
  config.browser.watchProfileDir = './chrome-profile-queue';
  config.browser.headed = true;

  const browser = new Browser(config, 'watch');
  const page = await browser.page();
  const until = Date.now() + minutes * 60_000;
  let opened = false;
  let looks = 0;
  let lastState = '';

  console.log(`\n  Watching item ${itemId} for ${minutes} minutes.`);
  console.log('  The moment it turns into a queue or becomes addable, it opens in YOUR browser.');
  console.log('  Sign in there beforehand. This window does nothing but look.\n');

  while (Date.now() < until && !opened) {
    looks += 1;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1500);
      const here = page.url();
      const title = await page.title().catch(() => '');
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const html = await page.content().catch(() => '');
      const { challenged, reason } = detectChallenge(title, text, html, here);

      // ── The queue ────────────────────────────────────────────────────────
      if (isQueueUrl(here)) {
        await captureOddPage({ retailer: 'Walmart', url: here, title, text, html,
          reason: 'queue seen by hold-my-place', screenshot: () => page.screenshot() });
        say('QUEUE IS UP — opening it in your browser');
        openInRealBrowser(url);
        opened = true;
        break;
      }

      // ── A wall, on the watching profile ──────────────────────────────────
      // Does not stop the loop: this profile is only looking, and the wall
      // is on it, not on you. But it means we cannot see the page right now,
      // so the safe move is to hand over anyway rather than sit blind.
      if (challenged) {
        await captureOddPage({ retailer: 'Walmart', url: here, title, text, html,
          reason: `hold-my-place: ${reason}`, screenshot: () => page.screenshot() });
        say(`${reason} on the watching profile — cannot see the page, opening it for you anyway`);
        openInRealBrowser(url);
        opened = true;
        break;
      }

      // ── The product page ─────────────────────────────────────────────────
      const nextData = await page
        .evaluate(() => {
          const n = document.getElementById('__NEXT_DATA__');
          return n ? JSON.parse(n.textContent || 'null') : null;
        })
        .catch(() => null);
      const r = readWalmartNextData(nextData, itemId);
      const state = `${r.state}/${r.addToCart === null ? '?' : r.addToCart ? 'addable' : 'not-addable'}/${r.seller.kind}`;
      if (state !== lastState) {
        say(`${r.state}${r.price !== null ? ` at $${r.price.toFixed(2)}` : ''} · ${r.addToCart === true ? 'ADDABLE' : r.addToCart === false ? 'not addable' : 'addable: unknown'} · seller ${r.seller.kind}`);
        lastState = state;
      } else if (looks % 8 === 0) {
        say(`still ${r.state} (${looks} looks)`);
      }

      if (r.state === 'in' && r.addToCart === true && r.seller.kind === 'retailer') {
        say('IN STOCK AND ADDABLE FROM WALMART — opening it in your browser');
        openInRealBrowser(url);
        opened = true;
        break;
      }
    } catch (err) {
      say((err as Error).message.slice(0, 100));
    }
    await page.waitForTimeout(POLL_MS);
  }

  if (!opened) console.log('\n  Time is up and nothing moved.\n');
  else console.log('\n  Your browser has it. This window is done and will close.\n');
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
