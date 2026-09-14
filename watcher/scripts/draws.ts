/**
 * What drawings is Walmart running, and when do they open?
 *
 *   npm run draws
 *
 * One page load, nothing touched. Entering is a separate act with a person
 * behind it: an entry commits a payment method to a charge that lands days
 * later, and no polling loop is going to authorise one.
 *
 * Worth remembering while reading the output: the draw is RANDOM. Being early
 * to the window buys nothing. The only thing this can save you is missing it.
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { scanDraws, drawInterval, DRAW_URL } from '../src/draws.ts';

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-draw';
const browser = new Browser(config, 'watch');

const when = (iso: string | null, now: number): string => {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const said =
    mins < 90 ? `${mins}m` : mins < 2880 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return ms >= 0 ? `in ${said}` : `${said} ago`;
};

try {
  const context = await browser.open();
  void context;
  const now = Date.now();
  console.log(`\n  ${DRAW_URL}\n`);
  const scan = await scanDraws(browser, now);

  if (scan.challenged) {
    console.log(`  Walmart served a challenge: ${scan.challengeReason}`);
    console.log('  Standing down. That is the answer for now.\n');
    process.exit(0);
  }
  if (scan.note) console.log(`  ${scan.note}`);
  if (scan.entryEnabled === false) {
    console.log('  enableDrawEntry is FALSE — Walmart has the mechanism switched off.');
  }

  if (scan.rows.length === 0) {
    console.log(`\n  Nothing advertised. Read in ${scan.ms}ms.\n`);
    process.exit(0);
  }

  console.log('  phase      opens/opened          price    limit  item');
  console.log('  ' + '─'.repeat(88));
  for (const r of scan.rows) {
    const clock = r.windowText ? `${r.windowText} (${when(r.windowAt, now)})` : '—';
    console.log(
      `  ${r.phase.padEnd(10)} ${clock.padEnd(21)} ` +
        `${(r.price === null ? '—' : '$' + r.price.toFixed(2)).padStart(8)}  ` +
        `${String(r.orderLimit ?? '—').padStart(5)}  ${r.name.slice(0, 40)}`,
    );
    if (r.url) console.log(`  ${' '.repeat(10)} ${r.url}`);
  }

  const open = scan.rows.filter((r) => r.phase === 'open');
  console.log(`
  ── ${open.length > 0 ? 'OPEN NOW' : 'Nothing open yet'} ────────────────────────────────────────────────

    ${open.length > 0
      ? `${open.length} drawing${open.length === 1 ? '' : 's'} taking entries. Enter by hand — free,
    one per account, and you commit an address, a card and a quantity that
    cannot be changed afterwards. Being first buys nothing; being entered does.`
      : `Next look would be in ${Math.round(drawInterval(scan.rows, now) / 60)} minutes on the watcher's own clock.`}

    Read in ${scan.ms}ms.
`);
} finally {
  await browser.close();
}
