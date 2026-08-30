/**
 * Why is the review list empty — or full?
 *
 * Read-only, and prints counts and product names only, so the output is safe to
 * paste anywhere. Written because "the sweeps aren't finding anything" was
 * reported three times and guessed at twice; the database answered it in one
 * query. Reach for this before changing any code.
 *
 *   npm run doctor
 */
import postgres from 'postgres';
import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';

async function main(): Promise<void> {
  const client = postgres(connectionStringFrom(process.env), {
    prepare: false,
    max: 1,
    connect_timeout: 15,
  });
  const db = fromPostgres(client as unknown as PostgresLike);

  try {
    const status = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM discoveries WHERE user_id = 1
        GROUP BY status ORDER BY n DESC`,
    );
    console.log('\n  DISCOVERIES BY STATUS');
    if (status.length === 0) console.log('    (none at all)');
    for (const r of status) console.log(`    ${String(r.status).padEnd(12)} ${r.n}`);

    const sources = await db.query<{
      id: string;
      retailer: string;
      enabled: boolean;
      last: string;
      n: number;
    }>(
      `SELECT s.id, s.retailer, s.enabled,
              coalesce(s.last_swept_at::text, 'NEVER') AS last,
              (SELECT count(*)::int FROM discoveries d
                WHERE d.user_id = s.user_id AND d.source_id = s.id) AS n
         FROM sources s WHERE s.user_id = 1 ORDER BY s.id`,
    );
    console.log('\n  SOURCES');
    for (const r of sources) {
      console.log(
        `    ${r.id.padEnd(18)} ${String(r.retailer).padEnd(16)} ${r.enabled ? 'on ' : 'OFF'}  ` +
          `${String(r.n).padStart(4)} found   last swept ${r.last}`,
      );
    }

    const review = await db.query<{ name: string; source_id: string; found_by: string }>(
      `SELECT name, source_id, found_by FROM discoveries
        WHERE user_id = 1 AND status = 'new'
        ORDER BY first_seen_at DESC LIMIT 40`,
    );
    console.log(`\n  WAITING FOR YOU TO KEEP OR FORGET  (${review.length})`);
    if (review.length === 0) {
      console.log('    Nothing. Either the sweep found nothing new, or you have');
      console.log('    already decided on everything it has ever found.');
    }
    for (const r of review) {
      console.log(`    ${String(r.source_id).padEnd(16)} ${String(r.name).slice(0, 60)}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`\n  failed: ${(err as Error).message}\n`);
  process.exit(1);
});
