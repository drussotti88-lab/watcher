/**
 * When somebody pastes a URL, which facet will find it again?
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * The cheap detector asks a category endpoint, not a product one: one request
 * returns every product in a facet, with state and price, identical to a full
 * page reading. Proven 4 Sep 2026 (`93b43ce`).
 *
 * But a facet only answers for products inside it, and four of the thirteen
 * listings on the watchlist were not in the sweep's category — they were added
 * by pasting a link, and nothing ever asked which shelf they sit on. A
 * detector that covers nine of thirteen is four listings that quietly stopped
 * being watched.
 *
 * So the missing step happens once, when a listing is ADDED: find the facet
 * that contains this product, remember it, and let the detector group its
 * requests by facet. One extra page load at add time buys a listing that
 * costs a fraction of a request a minute forever after.
 *
 * ── How it finds one ────────────────────────────────────────────────────────
 *
 *   1. Open the product page and record the JSON it fetches.
 *   2. Find the category the product itself claims — Target's own breadcrumbs
 *      carry a category id, in the shape `N-<id>`.
 *   3. Open that category page and capture the `applied_facets` its own slp
 *      call uses.
 *   4. PROVE it: replay that endpoint and check the product is in the reply.
 *
 * Step 4 is the point. A facet that looks right and does not contain the
 * product is exactly the failure this exists to prevent, and it is one
 * request to rule out.
 *
 *   npm run find-facet <tcin>
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';
import { readTargetSearch } from '../src/readers/target-search.ts';

const tcin = (process.argv[2] ?? '').trim();
if (!/^\d+$/.test(tcin)) {
  console.error('\n  npm run find-facet 1011209279\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-findfacet';
const browser = new Browser(config, 'watch');

/**
 * Every category link in a blob of JSON.
 *
 * Target writes category pages as `/c/<slug>/-/N-<id>`, and the id is what a
 * category page is. Pulled by pattern from the whole body rather than from a
 * named field, because the field's path differs between the several
 * orchestration responses a PDP makes and the pattern does not.
 */
function categoryLinks(json: string): { url: string; id: string }[] {
  const out = new Map<string, string>();

  // A full category path, which is what a breadcrumb link looks like.
  for (const m of json.matchAll(/(\/c\/[A-Za-z0-9\-_%/]*?\/-\/(N-[A-Za-z0-9]+))/g)) {
    out.set(m[2]!, m[1]!);
  }

  // And a bare category id on its own. The first run of this found nothing on
  // a product page because it only looked inside XHR bodies for a full path —
  // Target puts the breadcrumbs in the document, and some responses carry the
  // id without the slug. A bare id still addresses a category page.
  if (out.size === 0) {
    for (const m of json.matchAll(/"(N-[A-Za-z0-9]{4,})"/g)) {
      out.set(m[1]!, `/c/-/${m[1]!}`);
    }
  }

  return [...out.entries()].map(([id, url]) => ({ id, url }));
}

try {
  const context = await browser.open();
  const page = await context.newPage();

  const captured: { url: string; body: unknown; text: string }[] = [];
  context.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const text = await res.text();
      if (!text || text.length > 4_000_000) return;
      captured.push({ url: res.url(), body: JSON.parse(text), text });
    } catch {
      /* not JSON */
    }
  });

  // ── 1. The product page ──
  console.log(`\n  Opening the product page for ${tcin}…`);
  await page
    .goto(`https://www.target.com/p/-/A-${tcin}`, { waitUntil: 'commit' })
    .catch(() => {});
  await page.waitForTimeout(6000);

  // ── 2. What category does the product claim? ──
  //
  // The document as well as the API responses. Target renders breadcrumbs
  // into the page, and the first version of this looked only at XHR bodies
  // and concluded — wrongly — that the product named no category at all.
  const html = await page.content().catch(() => '');
  const links = categoryLinks([...captured.map((c) => c.text), html].join('\n'));
  if (links.length === 0) {
    console.log('\n  The product page names no category. This one keeps the expensive path.\n');
    process.exit(0);
  }

  console.log(`  ${links.length} categor${links.length === 1 ? 'y' : 'ies'} named on that page:`);
  for (const l of links.slice(0, 8)) console.log(`    ${l.id}  ${l.url}`);

  // ── 3. Each category's own facet, breadcrumbs first ──
  //
  // In DOCUMENT ORDER. The first version reversed this on a guess that the
  // narrowest shelf comes last; what actually comes last is the footer —
  // terms, privacy policy, interest-based advertising — so it spent three
  // page loads on legal boilerplate and concluded the product was not
  // merchandised anywhere. The breadcrumbs are at the top, where breadcrumbs
  // go.
  //
  // Pages that are obviously not shelves are skipped by name rather than by
  // loading them: it costs a page load to learn that a privacy policy sells
  // no trading cards.
  const NOT_A_SHELF = /privacy|terms|policy|advertis|accessib|recall|careers/i;
  const ordered = links.filter((l) => !NOT_A_SHELF.test(l.url));

  console.log(`\n  ${ordered.length} of them look like shelves rather than footer links.`);

  for (const link of ordered.slice(0, 5)) {
    console.log(`\n  Trying ${link.id}…`);
    captured.length = 0;
    await page
      .goto(`https://www.target.com${link.url}`, { waitUntil: 'commit' })
      .catch(() => {});
    await page.waitForTimeout(6000);

    const best = captured
      .map((c) => ({ ...c, rows: readTargetSearch([c.body]) }))
      .filter((c) => c.rows.length > 0)
      .sort((a, b) => b.rows.length - a.rows.length)[0];

    if (!best) {
      console.log('    nothing parsed from that category page.');
      continue;
    }

    const url = new URL(best.url);
    const facet = url.searchParams.get('applied_facets') ?? '';
    const here = best.rows.some((r) => String(r.tcin) === tcin);
    console.log(
      `    ${best.rows.length} products, facet "${facet || '(none)'}", ` +
        `${here ? 'CONTAINS our product' : 'does not contain it on page one'}`,
    );

    // ── 4. Prove it by replay, which is how the detector will ask ──
    if (here) {
      const replay = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          return { status: res.status, text: await res.text() };
        } catch (err) {
          return { status: 0, text: String(err) };
        }
      }, best.url);

      let rows: ReturnType<typeof readTargetSearch> = [];
      try {
        rows = readTargetSearch([JSON.parse(replay.text)]);
      } catch {
        /* zero */
      }
      const found = rows.find((r) => String(r.tcin) === tcin);

      console.log(`
  ── Found it ────────────────────────────────────────────────────────────

    facet     ${facet}
    endpoint  ${scrub(best.url.split('?')[0]!)}
    replay    HTTP ${replay.status}, ${rows.length} products, ${found ? 'ours included' : 'OURS MISSING'}
    reads as  ${found ? `${found.state} ${found.price === null ? 'no price' : '$' + found.price}` : '—'}

    Store this facet against the listing when it is added, and this product
    costs a share of one request a minute instead of a page load each time.
`);
      process.exit(0);
    }

    await page.waitForTimeout(3000);
  }

  console.log(`
  No category page carried ${tcin} on its first page. Either it sits deeper
  than one page, or it is not merchandised into a browsable shelf at all.
  Either way this listing keeps the expensive path, and now we know which.
`);
} finally {
  await browser.close();
}
