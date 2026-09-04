/**
 * Does the cheap read actually SEE everything we watch?
 *
 * ── Why this is the question that decides it ────────────────────────────────
 *
 * onefetch.ts proved a search endpoint answers a direct replay: one request,
 * 355ms, data identical to a full page reading. That makes a cheap detector
 * possible. It does not make one CORRECT.
 *
 * A detector that covers nine of thirteen listings is not a detector — it is
 * four listings that silently stopped being watched, and the day you find out
 * is the day one of them dropped. So before any of this is built into the
 * watch loop, the question is coverage: for every listing on the watchlist,
 * is there a query whose one response contains it?
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Runs the sweep's own queries, ONE request each after the first page load,
 * and reports which watched tcins each one finds. Then the honest summary:
 * which listings no query reaches, and the smallest set of queries that
 * covers the ones that are reachable.
 *
 * A tcin nobody finds is not a failure of this script. It is the reason the
 * expensive path has to stay for those listings, and knowing WHICH ones is
 * the difference between a two-tier design and a gap.
 *
 *   npm run coverage <tcin> [tcin…]
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { searchUrl, readTargetSearch } from '../src/readers/target-search.ts';
import { scrub } from '../src/scrub.ts';

/** The sweep's queries, in its own order. Kept in step with index.ts by hand. */
const QUERIES = [
  'pokemon elite trainer box',
  'pokemon booster box',
  'pokemon booster bundle',
  'pokemon booster pack',
  'pokemon build and battle box',
  'pokemon ex box',
  'pokemon premium collection',
  'pokemon ultra premium collection',
  'pokemon upc',
  'pokemon spc',
  'pokemon tin',
  'pokemon blister pack',
  'pokemon trading card game',
];

const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (wanted.length === 0) {
  console.error('\n  npm run coverage 95267143 95280894 …\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-coverage';
const browser = new Browser(config, 'watch');

/** tcin → the queries that returned it. */
const found = new Map<string, string[]>();
for (const id of wanted) found.set(id, []);

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

  let requests = 0;
  context.on('request', () => {
    requests += 1;
  });

  console.log(`\n  Checking ${wanted.length} listings against ${QUERIES.length} queries.`);
  console.log('  One page load to start, then one request per query.\n');

  // The first query is a real navigation, because that is what puts a page on
  // target.com's origin and teaches us the endpoint. Every query after it is
  // the same URL with the search term swapped, asked directly.
  let template = '';
  let termParam = '';
  // Every query's result, so an unchanged answer across different terms is
  // caught rather than reported as coverage.
  const prints = new Map<string, string>();
  const startRequests = requests;

  for (const [i, query] of QUERIES.entries()) {
    let rows: ReturnType<typeof readTargetSearch> = [];
    let spent = 0;
    const before = requests;

    if (!template) {
      captured.length = 0;
      await page.goto(searchUrl(query), { waitUntil: 'commit' }).catch(() => {});
      await page.waitForTimeout(6000);
      const scored = captured
        .map((c) => ({ ...c, rows: readTargetSearch([c.body]) }))
        .filter((c) => c.rows.length > 0)
        .sort((a, b) => b.rows.length - a.rows.length);
      rows = scored[0]?.rows ?? [];
      // Remember the endpoint the PAGE used, so every query after this one
      // costs a single request. The search term is swapped inside a URL the
      // site built — this is a replay, not a construction.
      template = scored[0]?.url ?? '';
      if (!template) {
        console.log('\n  Nothing parsed into products on the first query. Stopping.\n');
        break;
      }

      // ── Which parameter carries the search term? ──
      //
      // DISCOVERED, not guessed. The first run of this guessed at
      // `searchTerm|keyword|q`, matched none of them, and so replayed the
      // FIRST query thirteen times — reporting thirteen identical rows of
      // "9 products, finds 9 of ours" as though it had tested anything.
      //
      // The reliable way is to look for the parameter whose value IS the
      // term we just searched for. That cannot be wrong about a URL we did
      // not build.
      const params = new URL(template).searchParams;
      for (const [k, v] of params) {
        if (v.toLowerCase() === query.toLowerCase()) termParam = k;
      }
      console.log(`      endpoint: ${scrub(template.split('?')[0]!)}`);
      console.log(`      parameters: ${[...params.keys()].join(', ')}`);
      console.log(
        termParam
          ? `      the search term rides in "${termParam}"\n`
          : `      NO PARAMETER HOLDS THE SEARCH TERM — cannot vary the query. Stopping.\n`,
      );
      if (!termParam) break;
    } else {
      const swapped = new URL(template);
      swapped.searchParams.set(termParam, query);
      const url = swapped.toString();
      const result = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          return { status: res.status, text: await res.text() };
        } catch (err) {
          return { status: 0, text: String(err) };
        }
      }, url);
      if (result.status === 200) {
        try {
          rows = readTargetSearch([JSON.parse(result.text)]);
        } catch {
          /* zero rows, reported below */
        }
      }
    }

    spent = requests - before;
    prints.set(query, rows.map((r) => `${r.tcin}:${r.state}:${r.price ?? '-'}`).sort().join('|'));
    const hits = rows.filter((r) => found.has(String(r.tcin)));
    for (const hit of hits) found.get(String(hit.tcin))!.push(query);

    console.log(
      `  ${String(i + 1).padStart(2)}. ${query.padEnd(34)} ${String(rows.length).padStart(3)} products  ` +
        `${String(spent).padStart(3)} req  ${hits.length ? `finds ${hits.length} of ours` : ''}`,
    );

    // Spacing between queries. The sweep already paces itself; a probe that
    // does not would measure a burst nobody intends to run.
    await page.waitForTimeout(2500);
  }

  // ── Did the queries actually differ? ──
  //
  // The guard this script earned the hard way. Thirteen different terms
  // returning byte-identical product lists does not mean Target sells nine
  // products; it means the term never changed, and every "finding" below
  // would be the first query counted thirteen times.
  const distinct = new Set([...prints.values()].filter(Boolean));
  if (prints.size > 1 && distinct.size === 1) {
    console.log(`
  ── NOT A RESULT ────────────────────────────────────────────────────────

    All ${prints.size} queries returned an identical product list, so the search
    term never actually varied. Nothing below would mean anything. Fix the
    substitution before trusting any coverage number.
`);
    process.exit(1);
  }

  const totalRequests = requests - startRequests;
  const covered = [...found.entries()].filter(([, qs]) => qs.length > 0);
  const missing = [...found.entries()].filter(([, qs]) => qs.length === 0);

  // The smallest set of queries covering everything reachable — greedy, which
  // is not provably minimal but is honest about the shape: if two queries do
  // the job, the detector is two requests, not thirteen.
  const need = new Set(covered.map(([id]) => id));
  const chosen: string[] = [];
  while (need.size > 0) {
    let best = '';
    let bestCount = 0;
    for (const query of QUERIES) {
      const n = [...need].filter((id) => found.get(id)!.includes(query)).length;
      if (n > bestCount) {
        best = query;
        bestCount = n;
      }
    }
    if (!best) break;
    chosen.push(best);
    for (const id of [...need]) if (found.get(id)!.includes(best)) need.delete(id);
  }

  console.log(`
  ── Coverage ────────────────────────────────────────────────────────────

    ${covered.length}/${wanted.length} listings appear in at least one query's response.
    ${totalRequests} requests for the whole sweep of ${QUERIES.length} queries.
`);

  if (missing.length) {
    console.log('    NOT FOUND by any query — these still need a page load each:');
    for (const [id] of missing) console.log(`      ${id}`);
    console.log('');
  }

  if (chosen.length) {
    console.log(`    ${chosen.length} quer${chosen.length === 1 ? 'y covers' : 'ies cover'} all ${covered.length} reachable listings:`);
    for (const q of chosen) console.log(`      "${q}"`);
    console.log(`
    So a detector pass is ${chosen.length} request${chosen.length === 1 ? '' : 's'}, not ${wanted.length} page loads.
    Once a minute: about ${(chosen.length * 60 * 24).toLocaleString()} requests a day, against 684,000.
`);
  }
} finally {
  await browser.close();
}
