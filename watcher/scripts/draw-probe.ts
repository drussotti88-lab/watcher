/**
 * What does Walmart's collectibles drawing page actually say?
 *
 * ── Why a probe before a feature ────────────────────────────────────────────
 *
 * Roberto asked for an auto-join for Walmart's new drawings on 14 Sep 2026.
 * Everything published about them is journalism and a help article — useful
 * for the RULES, useless for the shape of the data. Every reader in this
 * project that works was built from a real capture, and every wrong conclusion
 * in it came from reasoning about a page instead of reading one. Twice.
 *
 * So this asks the page, prints what is there, and concludes nothing.
 *
 * ── What we already know, from Walmart's own rules ──────────────────────────
 *
 *   - Entry is FREE and there is ONE entry per drawing, per account.
 *   - You commit a shipping address, a payment method and a quantity at entry
 *     time and cannot change them afterwards.
 *   - If you are drawn, Walmart PLACES THE ORDER AUTOMATICALLY and charges you.
 *   - Winners are picked at random after the window closes.
 *
 * The last two are why this probe does not touch a single control. An entry is
 * a purchase authorised days in advance, and nothing here is going to
 * authorise one by accident while finding out what a button is called.
 *
 * ── The thing that changes the whole design ─────────────────────────────────
 *
 * The draw is RANDOM. Speed buys nothing: an entry in the first second is
 * worth exactly what an entry an hour before close is worth. Every other part
 * of this system exists to win a race, and this one cannot be raced. The only
 * failure mode is not knowing the window opened — which makes DETECTION the
 * whole job, and makes entering a thing that can happen at a human pace.
 *
 * ── What it reads, and what it will not ─────────────────────────────────────
 *
 * Read-only, one page load, no clicks, no form fields, no navigation into an
 * entry flow. It prints structure and counts. Everything goes through scrub(),
 * because a Walmart page carries the account's own identifiers and a probe is
 * not exempt from the rule it was written to investigate — that lesson cost us
 * once already, on 4 Sep.
 *
 *   npm run draw-probe
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';
import { nextData } from '../src/readers/walmart-search.ts';
import { readWhenReady } from '../src/settle.ts';
import { detectChallenge } from '../src/challenge.ts';

/** Walmart's own page for this, named in their launch coverage. */
const DRAW_URL = 'https://www.walmart.com/shop/collectibles/draw';

/**
 * Every path through a JSON tree whose key or value smells like a drawing.
 *
 * Deliberately a search rather than a fixed path. We do not know the shape,
 * and the point of the exercise is to find it — `readWalmartSearch` had to
 * learn `itemStacks[].items[]` the same way.
 */
function paths(node: unknown, want: RegExp, at = '$', out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 400) return out;
  if (node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = Array.isArray(node) ? `${at}[${k}]` : `${at}.${k}`;
    if (want.test(k)) {
      const kind = Array.isArray(v)
        ? `array(${v.length})`
        : v === null
          ? 'null'
          : typeof v === 'object'
            ? `object{${Object.keys(v as object).slice(0, 8).join(',')}}`
            : `${typeof v} ${scrub(String(v)).slice(0, 60)}`;
      out.push(`${here}  ${kind}`);
    }
    paths(v, want, here, out, depth + 1);
  }
  return out;
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-draw';
const browser = new Browser(config, 'watch');

try {
  const context = await browser.open();
  const page = await context.newPage();

  console.log(`\n  Opening ${DRAW_URL}\n`);
  await page.goto(DRAW_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const read = await readWhenReady(page, { minText: 400, settleForMs: 2500, timeoutMs: 40_000 });

  const challenge = detectChallenge(read.title, read.text);
  if (challenge.challenged) {
    console.log(`  Walmart served a challenge: ${challenge.reason}`);
    console.log('  Nothing else to learn today. That IS the answer for now.\n');
    process.exit(0);
  }

  const html = await page.content();
  const data = nextData(html);

  console.log(`  title   ${scrub(read.title).slice(0, 90)}`);
  console.log(`  text    ${read.text.length} characters`);
  console.log(`  __NEXT_DATA__ ${data === null ? 'ABSENT — this page is built some other way' : 'present'}`);

  // ── What the page says in words ──
  //
  // Before any JSON archaeology: a drawing page that says "no drawings are
  // open" in plain English is a complete answer, and a parser hunting for a
  // structure that is not there would report it as a broken reader.
  const words = read.text.replace(/\s+/g, ' ');
  const interesting = [
    /drawing/i, /enter/i, /entry/i, /closes?/i, /opens?/i,
    /winner/i, /selected/i, /eligib/i, /no .{0,20}available/i,
  ];
  console.log('\n  ── Phrases on the page ─────────────────────────────────');
  for (const re of interesting) {
    const m = new RegExp(`.{0,70}${re.source}.{0,70}`, 'i').exec(words);
    if (m) console.log(`   ${re.source.padEnd(22)} …${scrub(m[0]).trim()}…`);
  }

  if (data !== null) {
    console.log('\n  ── Keys that look like a drawing ───────────────────────');
    const hits = paths(data, /draw|raffle|lottery|sweep|entry|entries|window|deadline|opens?At|closes?At/i);
    for (const line of hits.slice(0, 60)) console.log(`   ${line}`);
    if (hits.length === 0) console.log('   (none — the drawings are not in __NEXT_DATA__)');

    console.log('\n  ── Keys that look like a product ───────────────────────');
    const items = paths(data, /^(usItemId|itemId|productId|name|title|canonicalUrl|price)$/);
    for (const line of items.slice(0, 25)) console.log(`   ${line}`);
  }

  // ── The whole body, kept locally, for building the reader against ──
  //
  // Written to probe-artifacts/, which is gitignored for exactly this reason:
  // a Walmart page carries the account's own identifiers and this file is
  // evidence, not source. It stays on this machine.
  const dir = resolve(process.cwd(), 'probe-artifacts');
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(resolve(dir, `draw-${at}.html`), html, 'utf8');
  if (data !== null) {
    writeFileSync(resolve(dir, `draw-${at}.json`), JSON.stringify(data, null, 1), 'utf8');
  }

  console.log(`
  ── Saved ───────────────────────────────────────────────────────────────

    probe-artifacts/draw-${at}.html${data === null ? '' : `
    probe-artifacts/draw-${at}.json`}

    Local only, and gitignored. Tell me what the sections above printed and
    the reader gets built from the real shape rather than from a guess.
`);
} finally {
  await browser.close();
}
