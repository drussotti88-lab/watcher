/**
 * Can one request — not one page load — answer for everything we watch?
 *
 * ── The theory being tested ─────────────────────────────────────────────────
 *
 * Measured 3 Sep 2026: a product reading is 214 requests and 2.7mb, and a
 * search results page is 396. The search page's DATA, though, arrives in a
 * single API response, and `readTargetSearch` already parses state and price
 * for every product in it — proven identical to a full page reading, three
 * for three, by search-vs-pdp.ts.
 *
 * So the 396 requests are the page, not the answer. If the same endpoint can
 * be asked directly — from a page already open on the retailer's own origin —
 * then a refresh costs ONE request instead of 396, and the arithmetic for the
 * house goes from ~684,000 requests a day to something near 1,500.
 *
 * ── Why this is a fair request, and not a trick ─────────────────────────────
 *
 * The URL is not constructed here. It is the exact URL the site's own
 * JavaScript asked for, captured on the way past, replayed by the same page
 * with the same session. That is what a storefront does every time somebody
 * pages through results — atp-probe.ts established both halves: asking from
 * outside a browser is a flat 403, and asking from inside the page is
 * ordinary.
 *
 * Nothing here spoofs, hides or bypasses anything. If the endpoint refuses a
 * replay, that is the answer, and we will have learned it for four requests
 * instead of during a drop.
 *
 * ── What would make it fail, and how we would know ──────────────────────────
 *
 * A one-time token in the URL, a nonce bound to the document, an edge that
 * scores replays differently. All of those show up as a non-200 or an empty
 * parse, both of which this reports plainly rather than papering over.
 *
 *   npm run onefetch ["search term"]
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';
import { searchUrl, readTargetSearch, type ScanRow } from '../src/readers/target-search.ts';

const term = process.argv[2] ?? 'pokemon trading card game';

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-onefetch';
const browser = new Browser(config, 'watch');

/** A row reduced to what a detector actually needs to compare. */
function fingerprint(rows: ScanRow[]): string {
  return rows
    .map((r) => `${r.tcin}:${r.state}:${r.price ?? '-'}:${r.availableQuantity ?? '-'}`)
    .sort()
    .join('|');
}

function summarise(rows: ScanRow[]): string {
  const inStock = rows.filter((r) => r.state === 'in').length;
  return `${rows.length} products, ${inStock} in stock`;
}

try {
  const context = await browser.open();
  const page = await context.newPage();

  // Every API body the search page receives, with the URL that fetched it.
  const captured: { url: string; body: unknown }[] = [];
  let requests = 0;
  context.on('request', () => {
    requests += 1;
  });
  context.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const text = await res.text();
      if (!text || text.length > 4_000_000) return;
      captured.push({ url: res.url(), body: JSON.parse(text) });
    } catch {
      /* not JSON, or gone */
    }
  });

  // ── 1. The expensive way, once, to learn the endpoint ──
  console.log(`\n  Loading the search page for "${term}" — the expensive way, once.`);
  const t0 = Date.now();
  await page.goto(searchUrl(term), { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(6000);
  const pageMs = Date.now() - t0;
  const pageRequests = requests;

  // Which response actually carried the products? Ask the real parser rather
  // than guessing from the URL: the endpoint that yields rows IS the one.
  const scored = captured
    .map((c) => ({ ...c, rows: readTargetSearch([c.body]) }))
    .filter((c) => c.rows.length > 0)
    .sort((a, b) => b.rows.length - a.rows.length);

  const source = scored[0];
  if (!source) {
    console.log('\n  No captured response parsed into products. Nothing to replay.\n');
    process.exit(0);
  }

  console.log(`  ${pageRequests} requests, ${pageMs}ms → ${summarise(source.rows)}`);
  console.log(`  The data came from:\n    ${scrub(source.url).slice(0, 180)}\n`);

  const before = fingerprint(source.rows);

  // ── 2. The cheap way: the same URL, asked by the same page ──
  console.log('  Now asking that same endpoint directly, three times.\n');
  const runs: { n: number; status: number; ms: number; rows: ScanRow[]; same: boolean }[] = [];

  for (let i = 1; i <= 3; i += 1) {
    const at = requests;
    const result = await page.evaluate(async (u) => {
      const started = performance.now();
      try {
        const res = await fetch(u, { credentials: 'include' });
        const text = await res.text();
        return { status: res.status, ms: Math.round(performance.now() - started), text };
      } catch (err) {
        return { status: 0, ms: Math.round(performance.now() - started), text: String(err) };
      }
    }, source.url);

    let rows: ScanRow[] = [];
    try {
      rows = readTargetSearch([JSON.parse(result.text)]);
    } catch {
      /* reported as zero rows below */
    }

    const spent = requests - at;
    runs.push({
      n: spent,
      status: result.status,
      ms: result.ms,
      rows,
      same: fingerprint(rows) === before,
    });

    console.log(
      `    ${i}.  HTTP ${result.status}  ${String(result.ms).padStart(4)}ms  ` +
        `${String(spent).padStart(2)} request${spent === 1 ? ' ' : 's'}  ` +
        `${summarise(rows).padEnd(26)} ${
          rows.length === 0 ? '' : fingerprint(rows) === before ? 'identical to the page' : 'DIFFERS from the page'
        }`,
    );

    // A pause between replays. Three requests in a burst is not the pattern
    // this would run at, and measuring it that way would tell us about a
    // pattern we do not intend to use.
    if (i < 3) await page.waitForTimeout(4000);
  }

  const worked = runs.filter((r) => r.status === 200 && r.rows.length > 0);
  const agreed = worked.filter((r) => r.same);
  const perRefresh = worked.length ? Math.round(worked.reduce((s, r) => s + r.n, 0) / worked.length) : 0;

  console.log(`
  ── The verdict ─────────────────────────────────────────────────────────
`);

  if (worked.length === 0) {
    console.log(`    The endpoint will not answer a replay (${runs.map((r) => r.status).join(', ')}).
    The theory is dead in this form, and the search PAGE at 396 requests
    stays the cheapest batch read we have — still 5x better per product
    than a page load each.\n`);
  } else if (agreed.length !== worked.length) {
    console.log(`    It answers, but ${worked.length - agreed.length} of ${worked.length} replies differed from the page.
    A detector that drifts is worse than none. Look at the rows before
    building on this.\n`);
  } else {
    const daily = perRefresh * 60 * 24;
    console.log(`    It answers, in about ${Math.round(worked.reduce((s, r) => s + r.ms, 0) / worked.length)}ms, with ${perRefresh} request per refresh,
    and every reply was identical to what the full page said.

    That is ${summarise(source.rows)} for ${perRefresh} request instead of ${pageRequests}.

    Once a minute, all day:  about ${daily.toLocaleString()} requests
    Today's equivalent:      about 684,000

    Next: the page has to stay open on the retailer's origin for this to be
    a same-origin request, and nothing here proves it still answers after an
    hour, or after the session cookie rolls. That is the following test.\n`);
  }
} finally {
  await browser.close();
}
