/**
 * Where did Target put the product?
 *
 *   npm run tgtshape [tcin]
 *
 * From 29 Sep 2026 ~10am CT, every Target read began failing with "no product
 * node for tcin N in 17 captured responses", reaching 100% by 2pm and staying
 * there. The reader searches every captured JSON body for any object whose
 * tcin matches and which carries a price, fulfillment or item - deliberately
 * shape-agnostic - so finding nothing in seventeen bodies means the data is no
 * longer in them in any form that reader recognises.
 *
 * This loads one product page in its OWN profile (Phantom keeps running) and
 * reports, for every JSON response and for the HTML itself: does the tcin
 * appear at all, and at which key paths. That is the whole question - the
 * answer says whether the key was renamed, the type changed, or the data moved
 * out of XHR into the page.
 *
 * Read-only: one page load, nothing clicked. Raw bodies go to probe-artifacts/
 * (gitignored) and never leave this machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';

const tcin = (process.argv[2] ?? '1010892076').replace(/\D/g, '');
const url = `https://www.target.com/p/-/A-${tcin}`;

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-onefetch';
const browser = new Browser(config, 'watch');

/** Every key path whose value is this tcin, or whose key names a tcin. */
function paths(node: unknown, at = '$', out: string[] = [], depth = 0): string[] {
  if (depth > 16 || out.length > 40 || node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = Array.isArray(node) ? `${at}[${k}]` : `${at}.${k}`;
    if (String(v) === tcin && (typeof v === 'string' || typeof v === 'number')) {
      out.push(`${here} = ${typeof v === 'number' ? v : JSON.stringify(v)}`);
    }
    paths(v, here, out, depth + 1);
  }
  return out;
}

/** Sibling keys of the first object holding the tcin - shows what it now sits next to. */
function neighbours(node: unknown, depth = 0): string[] | null {
  if (depth > 16 || node === null || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (String(v) === tcin && (typeof v === 'string' || typeof v === 'number')) {
        return Object.keys(obj).slice(0, 30).map((key) => key === k ? `*${key}*` : key);
      }
    }
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const n = neighbours(v, depth + 1);
    if (n) return n;
  }
  return null;
}

const dir = resolve(process.cwd(), 'probe-artifacts', `tgtshape-${tcin}-${Date.now()}`);
mkdirSync(dir, { recursive: true });

try {
  const context = await browser.open();
  const page = await context.newPage();
  const bodies: { url: string; text: string }[] = [];

  context.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const text = await res.text();
      if (text && text.length < 6_000_000) bodies.push({ url: res.url(), text });
    } catch { /* gone */ }
  });

  console.log(`\n  ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(9000);
  const html = await page.content();
  const title = await page.title();
  console.log(`  title: ${scrub(title).slice(0, 90)}`);
  console.log(`  ${bodies.length} xhr/fetch responses, html ${html.length} chars\n`);

  let n = 0;
  for (const b of bodies) {
    n += 1;
    const has = b.text.includes(tcin);
    let json: unknown = null;
    try { json = JSON.parse(b.text); } catch { /* not json */ }
    const u = new URL(b.url);
    const short = `${u.host}${u.pathname}`.slice(0, 90);
    writeFileSync(resolve(dir, `r${String(n).padStart(2, '0')}.txt`), `${b.url}\n\n${b.text}`);
    if (!has) { console.log(`  r${n}  ${json ? 'json' : 'text'}  -   ${short}`); continue; }
    console.log(`  r${n}  ${json ? 'json' : 'text'}  TCIN ${short}`);
    if (json) {
      for (const p of paths(json).slice(0, 6)) console.log(`         ${p}`);
      const nb = neighbours(json);
      if (nb) console.log(`         beside: ${nb.join(', ')}`);
    }
  }

  // The page itself: embedded JSON a server-rendered app would carry.
  writeFileSync(resolve(dir, 'page.html'), html);
  console.log(`\n  html mentions tcin ${html.split(tcin).length - 1} times`);
  for (const m of html.matchAll(/<script[^>]*id="([^"]+)"[^>]*>/g)) console.log(`    script#${m[1]}`);
  for (const k of ['__NEXT_DATA__', '__TGT_DATA__', '__PRELOADED_QUERIES__', 'apolloState', 'window.__']) {
    if (html.includes(k)) console.log(`    contains ${k}`);
  }
  console.log(`\n  saved: ${dir}\n`);
} finally {
  await browser.close();
}
