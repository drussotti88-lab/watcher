/**
 * Does ONE search request say the same thing as thirteen page loads?
 *
 * ── Why this is the real question ───────────────────────────────────────────
 *
 * Measured on 3 Sep 2026: one reading is 214 requests and 2.7mb. Thirteen
 * listings a minute apart is about 684,000 requests a day from one house,
 * which is what got that house's ordinary browsing challenged by Walmart and
 * Target at once.
 *
 * The obvious fix — ask the product API for a list of ids instead of one —
 * does not work at Target: the endpoint the PDP uses is a POST orchestration
 * call built around a single tcin (batch-probe.ts got a 405 trying).
 *
 * But we already own a batch reader. The catalogue SWEEP reads a whole search
 * page in one request and parses state, price and quantity for every product
 * on it — `readTargetSearch` has been doing that for weeks. Nobody has ever
 * checked whether the numbers it returns agree with a full page reading of
 * the same item.
 *
 * If they agree, the shape of the whole system changes: search reads become
 * the cheap DETECTOR, running often, and a page load becomes the expensive
 * CONFIRMER that runs only when the detector says something moved, or when
 * we are about to spend money. If they disagree, we have learned that for a
 * few requests instead of finding out during a drop.
 *
 *   npm run search-vs-pdp "<search term>" <tcin> [tcin…]
 *
 * One search request, then one page load per tcin given. Keep the list short.
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { readListing } from '../src/read.ts';
import { searchUrl, readTargetSearch, type ScanRow } from '../src/readers/target-search.ts';

const term = process.argv[2] ?? '';
const ids = process.argv.slice(3).filter((a) => /^\d+$/.test(a));
if (!term || ids.length === 0) {
  console.error('\n  npm run search-vs-pdp "pokemon elite trainer box" 95267143 95280894\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-svp';
const browser = new Browser(config, 'watch');

function money(n: number | null): string {
  return n === null || n === undefined ? '—' : '$' + n.toFixed(2);
}

try {
  const context = await browser.open();
  const page = await context.newPage();

  // ── One request, many products ──
  const bodies: unknown[] = [];
  context.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const text = await res.text();
      if (text.length > 4_000_000) return;
      bodies.push(JSON.parse(text));
    } catch {
      /* not JSON */
    }
  });

  let requests = 0;
  context.on('request', () => {
    requests += 1;
  });

  console.log(`\n  One search for "${term}"…`);
  const t0 = Date.now();
  await page.goto(searchUrl(term), { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(6000);
  const searchMs = Date.now() - t0;
  const searchRequests = requests;

  const rows: ScanRow[] = readTargetSearch(bodies);
  const byId = new Map(rows.map((r) => [String(r.tcin), r]));
  console.log(`  ${rows.length} products parsed from it, in ${searchMs}ms and ${searchRequests} requests.\n`);

  // ── The same items, the slow way ──
  const results: { id: string; search: ScanRow | undefined; pdp: any }[] = [];
  for (const id of ids) {
    const pdp = await readListing(browser, 'Target', id, `https://www.target.com/p/-/A-${id}`);
    results.push({ id, search: byId.get(id), pdp });
  }

  console.log('  id           search says            page says              agree?');
  console.log('  ' + '─'.repeat(70));
  let agreed = 0;
  let present = 0;
  for (const r of results) {
    const s = r.search;
    const sTxt = s ? `${s.state.padEnd(8)} ${money(s.price)}`.padEnd(22) : 'not on this page'.padEnd(22);
    const pTxt = `${String(r.pdp.state).padEnd(8)} ${money(r.pdp.price)}`.padEnd(22);
    // Only a state-and-price match counts. A search row that knows the state
    // but not the price is not a substitute for a reading that knows both.
    const same = Boolean(s) && s!.state === r.pdp.state && s!.price === r.pdp.price;
    if (s) present += 1;
    if (same) agreed += 1;
    console.log(`  ${r.id.padEnd(12)} ${sTxt} ${pTxt} ${s ? (same ? 'YES' : 'NO') : '—'}`);
  }

  console.log(`
  ── What this means ─────────────────────────────────────────────────────

    ${present}/${ids.length} of the items were on the search page at all.
    ${agreed}/${present} of those agreed with the page reading, exactly.

    One search: ${searchRequests} requests.
    ${ids.length} page loads: about ${ids.length * 214} requests.

    ${
      present > 0 && agreed === present
        ? 'The cheap read agrees. It can be the detector; keep the page load for\n    confirming and for buying.'
        : 'They disagree, or the search page does not carry everything we watch.\n    Look at the rows above before trusting a search read.'
    }
`);
} finally {
  await browser.close();
}
