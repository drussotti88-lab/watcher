/**
 * What does a Walmart drawing's ENTRY form look like while the window is open?
 *
 *   npm run draw-entry
 *   npm run draw-entry -- 21009455186        (one item, by Walmart's id)
 *
 * ── Why this could not be written before Tuesday ────────────────────────────
 *
 * The entry control does not exist on an announced drawing. `showDrawCTA` was
 * false on all four rows in the 14 Sep capture, and a button that is not in
 * the DOM cannot be described by reasoning about it. Every reader in this
 * project that works was built from a real capture, and every wrong conclusion
 * in it came from reasoning about a page instead of reading one.
 *
 * So this exists to be run ONCE, during a live window, and to make that run a
 * single command rather than twenty minutes of improvisation while the clock
 * is going.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * No clicks. No typing. No navigation into an entry flow. An entry commits a
 * shipping address, a payment method and a quantity to a charge that lands
 * days later, cannot be changed afterwards, and is limited to one per account
 * — so an accidental one is not a mistake you get to take back, and it burns
 * the only entry that account will ever have for that drawing.
 *
 * It also never prints a field's VALUE. A logged-in Walmart page has the
 * account's address and the last four of a card sitting in the DOM, and the
 * point of this run is the SHAPE of the form. Names, types and labels are the
 * shape; values are somebody's data. Everything goes through scrub() besides,
 * because a diagnostic is not exempt from the rule it was written to enforce.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';
import { nextData } from '../src/readers/walmart-search.ts';
import { readWhenReady } from '../src/settle.ts';
import { detectChallenge } from '../src/challenge.ts';
import { scanDraws } from '../src/draws.ts';

/** Everything on the page that could plausibly start an entry. */
const CONTROLS = `(() => {
  const seen = [];
  const say = (el, kind) => {
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    seen.push({
      kind,
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 80),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      testid: el.getAttribute('data-testid') || el.getAttribute('data-automation-id') || '',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').split('?')[0] : '',
    });
  };
  for (const el of document.querySelectorAll('button, a[href], [role=button]')) say(el, 'control');
  for (const el of document.querySelectorAll('form')) say(el, 'form');
  for (const el of document.querySelectorAll('input, select, textarea')) say(el, 'field');
  return seen;
})()`;

interface Seen {
  kind: string; tag: string; text: string; type: string; name: string;
  id: string; testid: string; disabled: boolean; href: string;
}

/** A control worth reporting: one whose words are about entering a drawing. */
const RELEVANT = /draw|enter|entry|entr|join|quantity|qty|address|payment|submit|confirm/i;

function paths(node: unknown, want: RegExp, at = '$', out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 300) return out;
  if (node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = Array.isArray(node) ? `${at}[${k}]` : `${at}.${k}`;
    if (want.test(k)) {
      const kind = Array.isArray(v) ? `array(${v.length})`
        : v === null ? 'null'
        : typeof v === 'object' ? `object{${Object.keys(v as object).slice(0, 8).join(',')}}`
        : `${typeof v} ${scrub(String(v)).slice(0, 60)}`;
      out.push(`${here}  ${kind}`);
    }
    paths(v, want, here, out, depth + 1);
  }
  return out;
}

const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a));

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-draw';
const browser = new Browser(config, 'watch');

try {
  await browser.open();

  // Ask the drawings page which items exist rather than being told. The ids
  // move between drawings and a hardcoded list is a list that is wrong in a
  // month.
  console.log('\n  Reading the drawings page for live items...');
  const scan = await scanDraws(browser);
  if (scan.challenged) {
    console.log(`  Walmart served a challenge: ${scan.challengeReason}`);
    console.log('  Standing down. Do not retry in a loop.\n');
    process.exit(0);
  }

  const rows = scan.rows.filter((r) => (wanted.length ? wanted.includes(r.usItemId) : true));
  if (rows.length === 0) {
    console.log(`  Nothing to probe${wanted.length ? ' matching ' + wanted.join(', ') : ''}.\n`);
    process.exit(0);
  }
  const open = rows.filter((r) => r.phase === 'open');
  console.log(
    `  ${rows.length} item${rows.length === 1 ? '' : 's'}, ` +
    `${open.length} showing a live CTA.` +
    (open.length === 0
      ? ' Probing anyway — an announced page is still worth a before-picture.'
      : ''),
  );

  const dir = resolve(process.cwd(), 'probe-artifacts');
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString().replace(/[:.]/g, '-');

  for (const row of rows) {
    if (!row.url) continue;
    console.log(`\n  ── ${row.name.slice(0, 58)} ──`);
    console.log(`     ${row.url}  (${row.phase}, showDrawCTA=${row.showDrawCTA})`);

    const page = await browser.page();
    try {
      await page.goto(row.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const read = await readWhenReady(page, { minText: 400, settleForMs: 2500, timeoutMs: 40_000 });

      const challenge = detectChallenge(read.title, read.text);
      if (challenge.challenged) {
        console.log(`     challenged: ${challenge.reason} — skipping the rest`);
        break;
      }

      const html = await page.content();
      const data = nextData(html);
      const controls = (await page.evaluate(CONTROLS)) as Seen[];
      const hits = controls.filter((c) => RELEVANT.test(`${c.text} ${c.name} ${c.id} ${c.testid}`));

      console.log(`     ${controls.length} controls on the page, ${hits.length} that mention entry`);
      for (const c of hits.slice(0, 40)) {
        console.log(
          `       ${c.kind.padEnd(7)} ${c.tag.padEnd(8)}` +
          `${c.disabled ? 'DISABLED ' : '         '}` +
          `${scrub(c.text).padEnd(34).slice(0, 34)} ` +
          `testid=${c.testid || '-'} name=${c.name || '-'}${c.href ? ' -> ' + c.href : ''}`,
        );
      }
      if (hits.length === 0) console.log('       (nothing — no entry control in the DOM yet)');

      if (data !== null) {
        console.log('     ── __NEXT_DATA__ keys about entry ──');
        const found = paths(data, /draw|entry|entries|enterDraw|eligib|window|closes?At|opens?At|orderLimit|quantity/i);
        for (const line of found.slice(0, 40)) console.log(`       ${line}`);
        if (found.length === 0) console.log('       (none)');
      }

      const stem = `entry-${row.usItemId}-${at}`;
      writeFileSync(resolve(dir, `${stem}.html`), html, 'utf8');
      writeFileSync(resolve(dir, `${stem}.controls.json`), JSON.stringify(controls, null, 1), 'utf8');
      if (data !== null) {
        writeFileSync(resolve(dir, `${stem}.json`), JSON.stringify(data, null, 1), 'utf8');
      }
      console.log(`     saved probe-artifacts/${stem}.*`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  console.log(`
  ── Done ────────────────────────────────────────────────────────────────

    Nothing was clicked and no field was filled. The captures are local and
    gitignored: they are a logged-in Walmart page and they stay on this
    machine.

    Paste me the control lines above and the auto-entry gets built from the
    real form. Entering THIS drawing is still a person's job today, and
    entering at 4:05pm is worth exactly what entering at 7pm is worth.
`);
} finally {
  await browser.close();
}
