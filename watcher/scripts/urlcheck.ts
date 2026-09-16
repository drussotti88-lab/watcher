/**
 * Where does a drawing's link actually LAND?
 *
 * The Hub's stored URL, Walmart's own canonicalUrl and the card's link are all
 * the same string and all agree with the item's id and slug - and clicking one
 * still arrives at a different product. So the fault is not in what we stored;
 * it is in what Walmart does with it. This opens each one and reports the URL
 * the browser ends up on, which is the only thing that settles it.
 *
 * Read-only. One load per link, nothing clicked. Same footprint as an ordinary
 * product read, on pages we are already telling a person to open.
 *
 *   npm run urlcheck
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { readWhenReady } from '../src/settle.ts';
import { detectChallenge } from '../src/challenge.ts';
import { scanDraws } from '../src/draws.ts';
import { scrub } from '../src/scrub.ts';

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-draw';
const browser = new Browser(config, 'watch');

const idOf = (u: string): string => (u.match(/\/(\d{6,})(?:\?|$)/) || [])[1] ?? '';

try {
  await browser.open();
  const scan = await scanDraws(browser);
  if (scan.challenged) {
    console.log(`  challenged: ${scan.challengeReason} — standing down\n`);
    process.exit(0);
  }
  console.log(`\n  ${scan.rows.length} drawing links to follow\n`);

  for (const row of scan.rows) {
    if (!row.url) continue;
    const page = await browser.page();
    try {
      await page.goto(row.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const read = await readWhenReady(page, { minText: 200, settleForMs: 1500, timeoutMs: 30_000 });
      const landed = page.url();
      const challenge = detectChallenge(read.title, read.text);

      const asked = row.usItemId;
      const got = idOf(landed);
      const verdict = challenge.challenged
        ? `WALL (${challenge.reason})`
        : got === asked
          ? 'lands on the right item'
          : got
            ? `*** LANDS ON ${got} INSTEAD ***`
            : '*** no item id in the landing URL ***';

      console.log(`  ${row.name.slice(0, 56)}`);
      console.log(`    asked for : ${asked}`);
      console.log(`    landed on : ${landed.slice(0, 110)}`);
      console.log(`    title     : ${scrub(read.title).slice(0, 90)}`);
      console.log(`    verdict   : ${verdict}\n`);
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}
