/**
 * What actually decides what comes back — the words, or the facet?
 *
 * ── How we got here ─────────────────────────────────────────────────────────
 *
 * coverage.ts asked thirteen different questions and got thirteen identical
 * answers. The first version of it reported that as "9 of 13 covered"; the
 * guard added afterwards refused to. Both runs were the same underneath: the
 * search term genuinely did not change what came back, even once the term was
 * being substituted correctly into the parameter the site itself uses.
 *
 * The parameter list says why. Beside `keyword` sit `applied_facets`, `count`
 * and `offset` — and the sweep's own `searchUrl` pins a category facet. So the
 * likely shape is: the facet decides the SET, the keyword barely matters, and
 * `count`/`offset` decide how much of the set you are shown. Nine products was
 * never "everything Target sells"; it was one page.
 *
 * That would be better news than per-keyword coverage. One facet, paged, is a
 * complete list of what a retailer stocks in a category — which is exactly
 * what a detector wants, and it is the same thing the storefront shows a
 * person scrolling.
 *
 * ── What this establishes ───────────────────────────────────────────────────
 *
 *   1. Does the keyword matter at all? Ask for nonsense and see.
 *   2. Does `count` give more per request?
 *   3. Paged to the end, how many products are in the facet, and do all our
 *      watched listings appear in it?
 *
 * Every request is a replay of a URL the site built, from its own page.
 *
 *   npm run facet <tcin> [tcin…]
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';
import { searchUrl, readTargetSearch, type ScanRow } from '../src/readers/target-search.ts';

const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (wanted.length === 0) {
  console.error('\n  npm run facet 95267143 95280894 …\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-facet';
const browser = new Browser(config, 'watch');

const print = (rows: ScanRow[]): string =>
  rows.map((r) => r.tcin).sort().join(',');

try {
  const context = await browser.open();
  const page = await context.newPage();

  const captured: { url: string; body: unknown }[] = [];
  context.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const text = await res.text();
      if (!text || text.length > 4_000_000) return;
      captured.push({ url: res.url(), body: JSON.parse(text) });
    } catch {
      /* not JSON */
    }
  });

  console.log('\n  One page load to learn the endpoint…');
  await page.goto(searchUrl('pokemon elite trainer box'), { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(6000);

  const best = captured
    .map((c) => ({ ...c, rows: readTargetSearch([c.body]) }))
    .filter((c) => c.rows.length > 0)
    .sort((a, b) => b.rows.length - a.rows.length)[0];

  if (!best) {
    console.log('\n  Nothing parsed. Stopping.\n');
    process.exit(0);
  }

  const template = new URL(best.url);
  console.log(`  ${best.rows.length} products on the first page.`);
  console.log(`  facet: ${scrub(template.searchParams.get('applied_facets') ?? '(none)')}`);
  console.log(`  count: ${template.searchParams.get('count') ?? '(unset)'}, offset: ${template.searchParams.get('offset') ?? '(unset)'}\n`);

  const ask = async (u: URL): Promise<ScanRow[]> => {
    const result = await page.evaluate(async (s) => {
      try {
        const res = await fetch(s, { credentials: 'include' });
        return { status: res.status, text: await res.text() };
      } catch (err) {
        return { status: 0, text: String(err) };
      }
    }, u.toString());
    if (result.status !== 200) {
      console.log(`      HTTP ${result.status}`);
      return [];
    }
    try {
      return readTargetSearch([JSON.parse(result.text)]);
    } catch {
      return [];
    }
  };

  // ── 1. Does the keyword decide anything? ──
  const control = new URL(template.toString());
  control.searchParams.set('keyword', 'zzzz-not-a-real-product');
  const controlRows = await ask(control);
  const keywordMatters = print(controlRows) !== print(best.rows);
  console.log(
    `  1. keyword "zzzz-not-a-real-product" → ${controlRows.length} products, ` +
      `${keywordMatters ? 'DIFFERENT — the words matter' : 'identical — the FACET decides, not the words'}`,
  );
  await page.waitForTimeout(3000);

  // ── 2. Does count give more per request? ──
  const bigger = new URL(template.toString());
  bigger.searchParams.set('count', '48');
  bigger.searchParams.set('offset', '0');
  const biggerRows = await ask(bigger);
  console.log(
    `  2. count=48 → ${biggerRows.length} products` +
      (biggerRows.length > best.rows.length ? '  — more per request' : '  — no more than before'),
  );
  await page.waitForTimeout(3000);

  // ── 3. Page to the end ──
  console.log('\n  3. Paging the whole facet…');
  const step = Math.max(biggerRows.length, best.rows.length) || 24;
  const all = new Map<string, ScanRow>();
  for (const r of biggerRows.length ? biggerRows : best.rows) all.set(String(r.tcin), r);

  let requests = biggerRows.length ? 1 : 0;
  for (let offset = step; offset < step * 12; offset += step) {
    const nextUrl = new URL(template.toString());
    nextUrl.searchParams.set('count', String(step));
    nextUrl.searchParams.set('offset', String(offset));
    const rows = await ask(nextUrl);
    requests += 1;
    const fresh = rows.filter((r) => !all.has(String(r.tcin))).length;
    console.log(`     offset ${String(offset).padStart(3)}: ${String(rows.length).padStart(3)} products, ${fresh} new`);
    for (const r of rows) all.set(String(r.tcin), r);
    if (rows.length === 0 || fresh === 0) break;
    await page.waitForTimeout(2500);
  }

  // ── 4. If the facet misses some of ours, try the facet OFF ──
  //
  // The facet is narrow: it held nine products in total. A detector has to
  // see everything on the watchlist, so the question becomes whether a
  // broader ask — no category facet, one plain keyword, paged — reaches the
  // rest. If it does, the detector is a handful of requests. If it does not,
  // the stragglers keep the expensive path and we will know exactly which.
  let broad = new Map<string, ScanRow>();
  let broadRequests = 0;
  if (wanted.some((id) => !all.has(id))) {
    console.log('\n  4. Some of ours are not in that facet. Trying it with no facet at all…');
    const step2 = 24;
    for (let offset = 0; offset < step2 * 8; offset += step2) {
      const u = new URL(template.toString());
      u.searchParams.delete('applied_facets');
      u.searchParams.set('keyword', 'pokemon');
      u.searchParams.set('count', String(step2));
      u.searchParams.set('offset', String(offset));
      const rows = await ask(u);
      broadRequests += 1;
      const fresh = rows.filter((r) => !broad.has(String(r.tcin))).length;
      const oursHere = rows.filter((r) => wanted.includes(String(r.tcin))).length;
      console.log(
        `     offset ${String(offset).padStart(3)}: ${String(rows.length).padStart(3)} products, ` +
          `${fresh} new, ${oursHere} of ours`,
      );
      for (const r of rows) broad.set(String(r.tcin), r);
      if (rows.length === 0 || fresh === 0) break;
      await page.waitForTimeout(2500);
    }
    const stillMissing = wanted.filter((id) => !broad.has(id) && !all.has(id));
    console.log(
      `\n     unfaceted "pokemon": ${broad.size} products in ${broadRequests} requests, ` +
        `${wanted.length - stillMissing.length}/${wanted.length} of ours covered`,
    );
  }

  // Everything either route reached.
  for (const [id, row] of broad) if (!all.has(id)) all.set(id, row);
  const missing = wanted.filter((id) => !all.has(id));
  const inStock = [...all.values()].filter((r) => r.state === 'in').length;

  console.log(`
  ── What the facet holds ────────────────────────────────────────────────

    ${all.size} distinct products, ${inStock} of them in stock.
    ${requests + 1} requests to walk the whole thing.

    ${wanted.length - missing.length}/${wanted.length} of the listings we watch are in it.`);

  if (missing.length) {
    console.log(`
    Not in the facet — these still need their own read:`);
    for (const id of missing) console.log(`      ${id}`);
  }

  console.log(`
    A detector pass costs ${requests + 1 + broadRequests} request${requests + 1 + broadRequests === 1 ? '' : 's'} as measured here.
    Once a minute: about ${((requests + 1 + broadRequests) * 60 * 24).toLocaleString()} a day, against 684,000 today.
    Plus ${missing.length} listing${missing.length === 1 ? '' : 's'} that still need a page load each.
`);
} finally {
  await browser.close();
}
