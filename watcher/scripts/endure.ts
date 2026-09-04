/**
 * Does the cheap read still work in an hour? In three?
 *
 * ── Why this is the test that decides ───────────────────────────────────────
 *
 * onefetch.ts proved a same-origin replay answers: one request, 355ms, data
 * identical to a full page load. It proved it three times over about fifteen
 * seconds, which proves nothing about a system that has to run all day.
 *
 * The three ways this could quietly die:
 *
 *   1. The session rolls. Cookies expire, the `key` in the URL rotates, and
 *      one morning every reply is a 403.
 *   2. The page goes stale. A tab open for six hours is not a tab a person
 *      keeps open; the site may reload it, redirect it, or challenge it.
 *   3. The pattern gets scored. A request a minute from one session, forever,
 *      looks different from a person paging through results.
 *
 * All three show up here as a status code, an empty parse, or a reply that
 * stopped matching. None of them show up in a fifteen-second test.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not retry, re-navigate, or refresh the page to keep the replay
 * alive. The moment it starts nursing the session it stops measuring how long
 * the session lasts unattended, which is the only number worth having.
 *
 *   npm run endure [minutes] [seconds-between]
 *
 * Writes one JSON line per reply to logs/endure.ndjson, so it can be read
 * while it runs and survives whatever happens to the window.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scrub } from '../src/scrub.ts';
import { searchUrl, readTargetSearch, type ScanRow } from '../src/readers/target-search.ts';

const minutes = Number(process.argv[2] ?? 120);
const gapSec = Number(process.argv[3] ?? 60);
const LOG = 'logs/endure.ndjson';

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-endure';
const browser = new Browser(config, 'watch');

mkdirSync('logs', { recursive: true });

const fingerprint = (rows: ScanRow[]): string =>
  rows.map((r) => `${r.tcin}:${r.state}:${r.price ?? '-'}`).sort().join('|');

function note(line: Record<string, unknown>): void {
  const row = { at: new Date().toISOString(), ...line };
  appendFileSync(LOG, JSON.stringify(row) + '\n');
  console.log(`  ${JSON.stringify(row)}`);
}

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

  console.log(`\n  Holding one page open and replaying once every ${gapSec}s for ${minutes} minutes.`);
  console.log(`  Every reply goes to ${LOG}.\n`);

  await page.goto(searchUrl('pokemon elite trainer box'), { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(6000);

  const best = captured
    .map((c) => ({ ...c, rows: readTargetSearch([c.body]) }))
    .filter((c) => c.rows.length > 0)
    .sort((a, b) => b.rows.length - a.rows.length)[0];

  if (!best) {
    note({ event: 'no-endpoint', detail: 'nothing parsed on the first load' });
    process.exit(1);
  }

  const endpoint = best.url;
  const baseline = fingerprint(best.rows);
  note({
    event: 'start',
    endpoint: scrub(endpoint.split('?')[0]!),
    products: best.rows.length,
    minutes,
    gapSec,
  });

  const until = Date.now() + minutes * 60_000;
  let n = 0;
  let ok = 0;
  let firstFailureAt = '';

  while (Date.now() < until) {
    await page.waitForTimeout(gapSec * 1000);
    n += 1;

    const result = await page.evaluate(async (u) => {
      const started = performance.now();
      try {
        const res = await fetch(u, { credentials: 'include' });
        const text = await res.text();
        return {
          status: res.status,
          ms: Math.round(performance.now() - started),
          text: text.slice(0, 2_000_000),
          type: res.headers.get('content-type') ?? '',
        };
      } catch (err) {
        return { status: 0, ms: Math.round(performance.now() - started), text: String(err), type: '' };
      }
    }, endpoint);

    let rows: ScanRow[] = [];
    try {
      rows = readTargetSearch([JSON.parse(result.text)]);
    } catch {
      /* left empty — the line below says so */
    }

    const fp = fingerprint(rows);
    const healthy = result.status === 200 && rows.length > 0;
    if (healthy) ok += 1;
    else if (!firstFailureAt) firstFailureAt = new Date().toISOString();

    note({
      n,
      minute: Math.round((n * gapSec) / 60),
      status: result.status,
      ms: result.ms,
      products: rows.length,
      // Not an error: stock genuinely changes, and a detector that never sees
      // a change is a detector nobody needs. Recorded so the difference
      // between "changed" and "broke" stays visible.
      same: fp === baseline,
      // A challenge arrives as HTML where JSON was expected. Worth naming
      // rather than filing under "zero products".
      html: result.type.includes('html'),
    });
  }

  note({
    event: 'end',
    replies: n,
    healthy: ok,
    uptime: n ? Math.round((ok / n) * 100) + '%' : 'n/a',
    firstFailureAt: firstFailureAt || 'none',
  });
} finally {
  await browser.close();
}
