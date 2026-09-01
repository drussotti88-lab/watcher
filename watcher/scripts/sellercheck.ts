/**
 * What does the product page say the seller is, for finds the sweep recorded
 * as sold by Walmart?
 *
 * The sweep reads a search result; a mission reads the product page. If those
 * two disagree about who is selling, the review list is proposing resellers.
 */
import { loadConfig } from '../src/config.ts';
import { Browser } from '../src/browser.ts';
import { readListing } from '../src/read.ts';

const urls = process.argv.slice(2);
const config = loadConfig();
const browser = new Browser(config, 'watch');

try {
  for (const url of urls) {
    const id = (/\/(\d+)(?:\?|$)/.exec(url) ?? [])[1] ?? '';
    const r = await readListing(browser, 'Walmart', id, url);
    console.log(
      `\n  ${url.split('/ip/')[1]?.slice(0, 52)}\n` +
        `    seller   ${String(r.seller.kind).padEnd(12)} ${r.seller.name}\n` +
        `    price    ${r.price ?? '-'}    state ${r.state}    ${r.challenged ? 'CHALLENGED' : ''}\n` +
        `    note     ${r.note || '-'}`,
    );
    await new Promise((r) => setTimeout(r, 6000));
  }
} finally {
  await browser.close();
}
