/**
 * What does Target actually serve for a tcin that has no product node?
 *
 * staged-probe.ts came back "no product node in 36 responses" for two tcins a
 * tracker says have stock loaded. That is either the answer (an unlaunched SKU
 * has no public PDP, which is exactly why a page reader cannot see what a
 * backend reader can) or a shape mismatch in our node finder. This tells the
 * two apart by reporting what came back rather than what did not.
 *
 * Read only. One navigation.
 *
 *   node --experimental-strip-types scripts/tcin-peek.ts <tcin>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Response } from 'playwright';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';

const tcin = (process.argv[2] ?? '').trim();
if (!/^\d+$/.test(tcin)) {
  console.error('give me a tcin');
  process.exit(1);
}
const url = `https://www.target.com/p/-/A-${tcin}`;

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-staged';
const browser = new Browser(config, 'watch');

const bodies: { url: string; body: unknown }[] = [];
const statuses: { url: string; status: number }[] = [];

const page = await browser.page();
const onResponse = (res: Response): void => {
  const u = res.url();
  if (/redsky|api\.target\.com/i.test(u)) {
    statuses.push({ url: u.slice(0, 140), status: res.status() });
    void res
      .text()
      .then((t) => {
        if (!t || t.length > 6_000_000) return;
        try {
          bodies.push({ url: u, body: JSON.parse(t) });
        } catch {
          /* not JSON */
        }
      })
      .catch(() => {});
  }
};
page.on('response', onResponse);

// ── Arrive the way a person arrives ────────────────────────────────────────
//
// The first run of this script got 403 on store_location_v1 and nearby_stores_v1
// and a redsky /captcha response: a brand-new profile with no cookies, landing
// cold on a deep product URL, looks exactly like what Akamai is there to stop.
// It is not that we need to look less like a bot — it is that we were not
// behaving like a visitor. A visitor lands on the shop first.
console.log('  warming the profile on the homepage first...');
await page.goto('https://www.target.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);

const nav = await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
page.off('response', onResponse);

console.log('\n  asked for  ', url);
console.log('  http status', nav ? nav.status() : '(none)');
console.log('  landed on  ', page.url());
console.log('  title      ', await page.title().catch(() => '(none)'));

const heading = await page
  .locator('h1')
  .first()
  .innerText()
  .catch(() => '');
console.log('  first h1   ', heading.slice(0, 120) || '(none)');

console.log('\n  redsky responses:', statuses.length);
for (const s of statuses.slice(0, 25)) {
  const name = /\/(v\d\/[a-z]+\/[a-z0-9_]+)/i.exec(s.url);
  console.log('   ', s.status, name ? name[1] : s.url.slice(0, 90));
}

// Does the tcin appear ANYWHERE in what came back?
let hits = 0;
for (const b of bodies) {
  const text = JSON.stringify(b.body);
  if (!text.includes(tcin)) continue;
  hits++;
  const name = /\/(v\d\/[a-z]+\/[a-z0-9_]+)/i.exec(b.url);
  console.log(`\n  tcin found in ${name ? name[1] : b.url.slice(0, 80)} (${text.length} bytes)`);
  // Walk to the object that carries it, and show what it holds.
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (String(obj.tcin ?? '') === tcin) {
      console.log(`    at ${path || '(root)'} keys: ${Object.keys(obj).join(', ').slice(0, 300)}`);
    }
    for (const [k, v] of Object.entries(obj)) visit(v, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(b.body, '', 0);
}
if (hits === 0) console.log('\n  the tcin appears in NONE of the captured responses');

mkdirSync(resolve('logs/staged'), { recursive: true });
const out = resolve('logs/staged', `peek-${tcin}.json`);
writeFileSync(out, JSON.stringify({ url, landed: page.url(), statuses, bodies }, null, 1));
console.log('\n  everything written to', out);

await browser.close().catch(() => {});
