/**
 * Is the buy profile ready? Open it, look, close.
 *
 *   node --experimental-strip-types scripts/buy-check.ts
 *
 * Opens the signed-in profile on walmart.com, says whether it looks signed in
 * and whether a bot check is in the way, saves a screenshot next to the queue
 * captures, and closes. It clicks nothing and buys nothing. The point is to
 * answer "am I ready for Wednesday" on a Thursday, when there is time to fix
 * the answer.
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { detectChallenge } from '../src/challenge.ts';
import { looksSignedIn } from '../src/checkout/walmart.ts';
import { captureOddPage } from '../src/capture.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  config.browser.headed = true;
  const browser = new Browser(config, 'buy');
  const page = await browser.page();
  try {
    await page.goto('https://www.walmart.com/account', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3500);
    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const html = await page.content().catch(() => '');
    const { challenged, reason } = detectChallenge(title, text, html, page.url());
    const signedIn = challenged ? false : await looksSignedIn(page);

    const dir = await captureOddPage({
      retailer: 'Walmart',
      url: page.url(),
      title,
      text,
      html,
      reason: challenged ? `buy-check: ${reason}` : `buy-check: ${signedIn ? 'signed in' : 'signed out'}`,
      screenshot: () => page.screenshot({ fullPage: false }),
    });

    console.log(`\n  url:        ${page.url()}`);
    console.log(`  title:      ${title}`);
    console.log(`  challenge:  ${challenged ? reason : 'none'}`);
    console.log(`  signed in:  ${signedIn ? 'YES' : 'no'}`);
    console.log(`  saved:      ${dir}\n`);
    // The first few lines of what a person would see, for the log.
    console.log(text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).map((l) => '    ' + l.slice(0, 90)).join('\n'));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
