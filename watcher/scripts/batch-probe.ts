/**
 * Can one request answer for every listing we watch?
 *
 * ── The question ────────────────────────────────────────────────────────────
 *
 * A reading costs 214 requests and 2.7mb, measured. Thirteen Target listings
 * on a sixty-second cadence is therefore about 684,000 requests a day from one
 * house, which is what got that house's ordinary browsing challenged by two
 * retailers at once.
 *
 * The page's own JavaScript, meanwhile, gets its answer from ONE call to its
 * own API. If that call takes a list of product ids instead of one, then
 * everything we watch at a retailer costs a single request rather than
 * thirteen page loads — a ~2,800× cut — and it is the same source, so it
 * cannot be less accurate.
 *
 * ── How it asks ─────────────────────────────────────────────────────────────
 *
 * Nothing here is guessed or hand-written. It:
 *
 *   1. Opens ONE product page and records the API calls the page makes.
 *   2. Picks the ones that mention our product id, so we have the real
 *      endpoint with the real parameters — including whatever key the site
 *      puts on its own requests.
 *   3. From INSIDE that page, asks the same endpoint for ALL the ids, with a
 *      same-origin fetch. That is the site's own page calling the site's own
 *      public API with the session it already has, which is what its own
 *      JavaScript does on every navigation. Asking from outside a browser gets
 *      a flat 403 — atp-probe.ts established that — and the answer to a 403 is
 *      not to look more like a browser but to BE one, which we already are.
 *   4. Reports what came back, and whether the state and price agree with a
 *      full page reading of one of them.
 *
 * Nothing spoofs, hides or bypasses anything. If the endpoint refuses a list,
 * that is the answer.
 *
 *   npm run batch-probe <tcin> [tcin…]
 *
 * One page load and one fetch.
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { readListing } from '../src/read.ts';
import { scrub } from '../src/scrub.ts';

const ids = process.argv.slice(2).filter((a) => /^\w+$/.test(a));
if (ids.length < 2) {
  console.error('\n  Give me at least two Target tcins.\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-batch';
const browser = new Browser(config, 'watch');

interface Seen {
  url: string;
  status: number;
  ms: number;
  mentionsId: boolean;
  bytes: number;
}

const seen: Seen[] = [];

try {
  const context = await browser.open();
  const page = await context.newPage();

  const started = new Map<string, number>();
  context.on('request', (r) => started.set(r.url(), Date.now()));
  context.on('response', async (res) => {
    const url = res.url();
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    if (!/api|redsky|graphql|\/v\d\//i.test(url)) return;
    let body = '';
    try {
      body = (await res.text()).slice(0, 200_000);
    } catch {
      return;
    }
    seen.push({
      url,
      status: res.status(),
      ms: Date.now() - (started.get(url) ?? Date.now()),
      mentionsId: body.includes(ids[0]!),
      bytes: body.length,
    });
  });

  console.log(`\n  Opening one page for ${ids[0]} and recording what it asks for…\n`);
  await page.goto(`https://www.target.com/p/-/A-${ids[0]}`, { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(6000);

  const useful = seen.filter((s) => s.mentionsId && s.status === 200);
  console.log(`  ${seen.length} API calls seen, ${useful.length} of them mention ${ids[0]}:\n`);
  for (const s of useful.slice(0, 12)) {
    console.log(`    ${String(s.status)}  ${String(s.ms).padStart(5)}ms  ${String(Math.round(s.bytes / 1000)).padStart(4)}kb`);
    // Scrubbed. Target puts the visitor id, the home store and the postcode
    // in every query string, and the first run of this script printed all
    // three into a chat window — the project has had a scrubber for exactly
    // this since the beginning, and a diagnostic written in a hurry walked
    // straight past it. Diagnostics print through the scrubber too.
    console.log(`        ${scrub(s.url).slice(0, 200)}`);
  }

  // The one that looks like fulfillment, else the smallest that named our id:
  // a small body that mentions the product is a targeted answer, where a large
  // one is usually the recommendations carousel wearing a similar shape.
  // Prefer an endpoint that already takes a product id in its QUERY STRING —
  // that is the shape that might take a list. The first run of this picked a
  // POST-only orchestration endpoint on size alone and got a 405, which is
  // how we learned to look at the parameters rather than the body.
  const takesIdInQuery = (s: Seen): boolean => /[?&]tcins?=/i.test(s.url);
  const chosen =
    useful.find((s) => /redsky/i.test(s.url) && takesIdInQuery(s)) ??
    useful.find((s) => takesIdInQuery(s)) ??
    useful.find((s) => /fulfillment|summary/i.test(s.url));

  if (!chosen) {
    console.log('\n  No endpoint takes the product id as a query parameter.');
    console.log('  Nothing here can be turned into a list without guessing, so it stops.\n');
    process.exit(0);
  }

  console.log(`\n  Trying: ${scrub(chosen.url.split('?')[0]!)}`);

  // Swap the single id for the list. Both spellings, because the parameter is
  // `tcin` on some of these endpoints and `tcins` on others, and which one
  // this is depends on which we caught.
  const attempts: { label: string; url: string }[] = [];
  const single = chosen.url;
  attempts.push({
    label: 'tcins= (plural)',
    url: single.replace(/([?&])tcins?=[^&]*/i, `$1tcins=${ids.join('%2C')}`),
  });
  attempts.push({
    label: 'tcin= comma list',
    url: single.replace(/([?&])tcins?=[^&]*/i, `$1tcin=${ids.join('%2C')}`),
  });

  for (const attempt of attempts) {
    if (attempt.url === single) continue;
    const result = await page.evaluate(async (u) => {
      const t0 = performance.now();
      try {
        const res = await fetch(u, { credentials: 'include' });
        const text = await res.text();
        return { status: res.status, ms: Math.round(performance.now() - t0), text: text.slice(0, 400_000) };
      } catch (err) {
        return { status: 0, ms: Math.round(performance.now() - t0), text: String(err) };
      }
    }, attempt.url);

    // The ids appear in the URL we just sent, and an error page that echoes
    // the request back would score 13/13 without answering anything. So the
    // body is checked with the request's own query string removed first —
    // the first run reported "13/13 ids present" on a 2kb 405, which is how
    // this check earned its existence.
    const query = attempt.url.split('?')[1] ?? '';
    const body = [query, decodeURIComponent(query), attempt.url, encodeURI(attempt.url)].reduce(
      (t, echo) => (echo ? t.split(echo).join('') : t),
      result.text,
    );
    const found = ids.filter((id) => body.includes(id));
    console.log(
      `\n    ${attempt.label}: ${result.status} in ${result.ms}ms, ` +
        `${Math.round(result.text.length / 1000)}kb, ` +
        `${found.length}/${ids.length} ids present`,
    );

    if (result.status === 200 && found.length > 1) {
      // What it actually says about each one. Printed shallowly rather than
      // parsed, because the shape is what we are here to learn.
      try {
        const data = JSON.parse(result.text);
        const flat = JSON.stringify(data);
        for (const id of found) {
          const at = flat.indexOf(id);
          console.log(`      ${id}: …${flat.slice(at, at + 220).replace(/\s+/g, ' ')}…`);
        }
      } catch {
        console.log('      (not JSON)');
      }
      console.log(`\n  ONE REQUEST ANSWERED FOR ${found.length} PRODUCTS.`);
      console.log(`  Today that is ${found.length} page loads — about ${found.length * 214} requests.\n`);
      break;
    }
  }

  // And the truth to check it against: one full reading, the way Phantom does
  // it today. A batch answer nobody verified is a faster way to be wrong.
  console.log('\n  Reading one of them the slow way, to compare…');
  const reading = await readListing(browser, 'Target', ids[0]!, `https://www.target.com/p/-/A-${ids[0]}`);
  console.log(
    `    PDP says: ${(reading as any).state} · ${
      (reading as any).price === null ? 'no price' : '$' + (reading as any).price
    } · ${(reading as any).confidence}\n`,
  );
} finally {
  await browser.close();
}
