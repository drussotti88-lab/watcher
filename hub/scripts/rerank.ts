/**
 * Rank every find again, and retire the ones nobody prints.
 *
 *   npm run rerank             rank, and retire the retired series
 *   npm run rerank -- --dry    say what it would do, change nothing
 *   npm run rerank -- --keep   rank only; retire nothing
 *
 * The bare `--` is not decoration: npm eats `--dry` as its own `--dry-run` and
 * the script never sees it, so `npm run rerank --dry` silently runs for real.
 * Found the way these things are found.
 *
 * ── Why this exists as a command ────────────────────────────────────────────
 *
 * The sweep does this on its own at the end of every run, which handles
 * everything from here on. This is for the backlog that was already there:
 * 8 Sep 2026, 136 Walmart finds, 76 of them never looked at, because the top
 * of the list was a 2016 Elite Trainer Box and the bottom was next week's
 * release.
 *
 * It is also the honest way to change the rules. `era` is derived from the
 * first-party catalogue and that catalogue moves — so if a set arrives at
 * Target tomorrow, running this is how Walmart's copies of it stop being
 * called old, without waiting for a sweep.
 *
 * `--dry` prints the verdict on every find and writes nothing, because a rule
 * that decides on your behalf should be readable before it runs.
 */
import postgres from 'postgres';

import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';
import { eraOf, namesRetiredSeries } from '../src/era.ts';
import * as store from '../src/store.ts';

const USER = Number(process.env.RERANK_USER_ID ?? 1);

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dry = args.has('--dry') || args.has('-n');
  const keep = args.has('--keep');

  let url: string;
  try {
    url = connectionStringFrom(process.env);
  } catch (err) {
    console.error(`\n  ${(err as Error).message}`);
    console.error('  Run this through npm — the npm script is what loads .env.local.\n');
    process.exit(1);
  }

  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
  const db = fromPostgres(client as unknown as PostgresLike);

  try {
    const catalogue = await store.firstPartyCatalogue(db);
    console.log(
      `\n  ${catalogue.length} first-party products at Target and Pokémon Center` +
        ' define what is current.',
    );
    if (catalogue.length === 0) {
      console.log('  With none, nothing can be called old — every find will read "unknown".');
    }

    if (dry) {
      const rows = await db.query<{ name: string; retailer: string; status: string }>(
        `SELECT name, retailer, status FROM discoveries WHERE status = 'new' ORDER BY retailer, name`,
      );
      let retiring = 0;
      const count: Record<string, number> = {};
      console.log(`\n  ${rows.length} finds waiting on a decision:\n`);
      for (const row of rows) {
        const verdict = eraOf(row.name, catalogue);
        const doomed = namesRetiredSeries(row.name);
        if (doomed) retiring += 1;
        count[verdict.era] = (count[verdict.era] ?? 0) + 1;
        console.log(
          `  ${(doomed ? 'RETIRE ' : '       ')}${verdict.era.padEnd(8)}` +
            `${String(row.retailer).padEnd(16)}${row.name.slice(0, 62)}`,
        );
      }
      console.log(
        `\n  ${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(', ')}` +
          ` · ${retiring} would be retired\n`,
      );
      return;
    }

    const out = await store.rerankDiscoveries(db, USER, { retire: !keep });
    console.log(`
  ${out.ranked} finds ranked.
  ${keep ? 'Nothing retired (--keep).' : `${out.retired} retired — the title names a series nobody prints any more.`}

  Retiring is not deleting: the row stays, which is what stops the next sweep
  offering the same thing again as news. Anything retired by mistake is in the
  Finds list under its shop, still keepable.
`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
