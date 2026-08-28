/**
 * Apply a SQL file to the database named by DATABASE_URL.
 *
 * Replaces `wrangler d1 execute`. Deliberately dumb: it reads a file and runs
 * it. The schema is written with `IF NOT EXISTS` throughout so running it twice
 * is safe, which is the property that lets this be the only migration tool
 * until the Hub is big enough to deserve a real one.
 *
 *   node --experimental-strip-types scripts/migrate.ts schema.sql
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { connectionStringFrom } from '../src/db.ts';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('\n  usage: migrate.ts <file.sql>\n');
    process.exit(1);
  }

  let url: string;
  try {
    url = connectionStringFrom(process.env);
  } catch (err) {
    console.error(`\n  ${(err as Error).message}\n`);
    process.exit(1);
  }

  const path = resolve(process.cwd(), file);
  const sql = readFileSync(path, 'utf8');
  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });

  // Redact the credentials before printing: this line gets pasted into chat.
  const shown = url.replace(/\/\/[^@]+@/, '//<user>:<password>@');
  console.log(`\n  applying ${file}`);
  console.log(`  to ${shown}\n`);

  try {
    await client.unsafe(sql);
    console.log('  done.\n');
  } catch (err) {
    console.error(`  failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n  unexpected failure:', err);
  process.exit(1);
});
