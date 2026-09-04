/**
 * Does the keyword work if you set the parameter we ignored?
 *
 * ── Why ask again ───────────────────────────────────────────────────────────
 *
 * facet.ts concluded "the FACET decides, not the words", because a nonsense
 * keyword returned the same nine products. That conclusion has a hole in it:
 * the endpoint carries BOTH `keyword` and `query_string`, and only one of them
 * was being changed. A search engine handed a contradictory pair may well
 * prefer the one that was left alone.
 *
 * It matters because everything else depends on it. If the words never work,
 * the cheap detector can only ever see products inside a facet somebody has
 * already found, and four listings on the current watchlist are outside it. If
 * the words DO work, any product can be reached by asking for it by name, and
 * the whole watchlist is coverable.
 *
 * ── The four asks ───────────────────────────────────────────────────────────
 *
 *   1. keyword only            (what facet.ts tried)
 *   2. keyword + query_string  (both, agreeing)
 *   3. both, with the category facet removed
 *   4. both, facet removed, the product's exact name
 *
 * Each is one request, replayed from the page that made the original.
 *
 *   npm run keyword <tcin> "<phrase to search for>"
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { searchUrl, readTargetSearch, type ScanRow } from '../src/readers/target-search.ts';

const tcin = (process.argv[2] ?? '').trim();
const phrase = (process.argv[3] ?? '').trim();
if (!/^\d+$/.test(tcin) || !phrase) {
  console.error('\n  npm run keyword 1011209279 "first partner illustration collection"\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-keyword';
const browser = new Browser(config, 'watch');

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
  console.log(`  baseline: ${best.rows.length} products, ours present: ${best.rows.some((r) => String(r.tcin) === tcin)}\n`);

  const ask = async (label: string, build: (u: URL) => void): Promise<void> => {
    const u = new URL(template.toString());
    build(u);
    const result = await page.evaluate(async (s) => {
      try {
        const res = await fetch(s, { credentials: 'include' });
        return { status: res.status, text: await res.text() };
      } catch (err) {
        return { status: 0, text: String(err) };
      }
    }, u.toString());

    let rows: ScanRow[] = [];
    try {
      rows = readTargetSearch([JSON.parse(result.text)]);
    } catch {
      /* zero */
    }
    const mine = rows.find((r) => String(r.tcin) === tcin);
    console.log(
      `  ${label.padEnd(38)} HTTP ${result.status}  ${String(rows.length).padStart(3)} products  ` +
        (mine
          ? `FOUND OURS — ${mine.state} ${mine.price === null ? 'no price' : '$' + mine.price}`
          : 'ours not here'),
    );
    await page.waitForTimeout(3000);
  };

  await ask('1. keyword only', (u) => {
    u.searchParams.set('keyword', phrase);
  });

  await ask('2. keyword + query_string', (u) => {
    u.searchParams.set('keyword', phrase);
    u.searchParams.set('query_string', phrase);
  });

  await ask('3. both, no category facet', (u) => {
    u.searchParams.set('keyword', phrase);
    u.searchParams.set('query_string', phrase);
    u.searchParams.delete('applied_facets');
  });

  await ask('4. both, no facet, exact tcin', (u) => {
    u.searchParams.set('keyword', tcin);
    u.searchParams.set('query_string', tcin);
    u.searchParams.delete('applied_facets');
  });

  // ── 5. Page the unfaceted search ──
  //
  // Ask 3 returned a full page of 24 — the count, not the total — so "not in
  // the first 24" is not the same as "not findable". This walks four pages,
  // which is the most a detector would ever be willing to spend on one
  // listing, and reports where it turns up if it does.
  console.log('\n  5. Paging the unfaceted search for the phrase…');
  let foundAt = -1;
  let pages = 0;
  const seen = new Set<string>();
  for (let offset = 0; offset < 96; offset += 24) {
    const u = new URL(template.toString());
    u.searchParams.set('keyword', phrase);
    u.searchParams.set('query_string', phrase);
    u.searchParams.delete('applied_facets');
    u.searchParams.set('count', '24');
    u.searchParams.set('offset', String(offset));

    const result = await page.evaluate(async (s) => {
      try {
        const res = await fetch(s, { credentials: 'include' });
        return { status: res.status, text: await res.text() };
      } catch (err) {
        return { status: 0, text: String(err) };
      }
    }, u.toString());

    let rows: ScanRow[] = [];
    try {
      rows = readTargetSearch([JSON.parse(result.text)]);
    } catch {
      /* zero */
    }
    pages += 1;
    const fresh = rows.filter((r) => !seen.has(String(r.tcin))).length;
    for (const r of rows) seen.add(String(r.tcin));
    const mine = rows.find((r) => String(r.tcin) === tcin);
    if (mine && foundAt < 0) foundAt = offset;

    console.log(
      `     offset ${String(offset).padStart(3)}: HTTP ${result.status}  ${String(rows.length).padStart(3)} products, ` +
        `${fresh} new${mine ? `  ← OURS: ${mine.state} ${mine.price === null ? 'no price' : '$' + mine.price}` : ''}`,
    );
    if (rows.length === 0 || fresh === 0) break;
    await page.waitForTimeout(2500);
  }

  console.log(`
  ── Verdict ─────────────────────────────────────────────────────────────

    Unfaceted keyword search reached ${seen.size} distinct products in ${pages} requests.
    ${
      foundAt >= 0
        ? `Ours appeared at offset ${foundAt}, so ${Math.floor(foundAt / 24) + 1} request${foundAt >= 24 ? 's are' : ' is'} enough to watch it.
    Every listing is reachable cheaply: search by its own name, page if needed.`
        : `Ours did NOT appear in ${seen.size} results. Either the phrase is wrong, or
    this product is not returned by search at all — in which case it keeps
    the expensive path and we now know exactly why.`
    }
`);
} finally {
  await browser.close();
}
