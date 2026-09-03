/**
 * Reading what a tester's machine sent.
 *
 *   npm run reports          the last twenty, one line each
 *   npm run reports 7        report 7, in full
 *   npm run reports 7 --log  just the console dump, for piping
 *
 * The list is the important half. A report is filed at the moment somebody is
 * frustrated, and the first question is always the same — is it running, does
 * it have a token, is Node too old — which is what `summary` answers without
 * opening anything.
 */
import postgres from 'postgres';

import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';
import * as store from '../src/store.ts';

function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function full(r: store.ReportRow, logOnly: boolean): void {
  const b = r.body as Record<string, unknown>;
  if (logOnly) {
    console.log(String(b.console ?? ''));
    return;
  }
  console.log(`
  ── Report #${r.id} ─────────────────────────────────────────────────────

  From      ${r.handle} (user ${r.userId})
  When      ${when(r.at)}  (${r.at})
  Phantom   ${r.version || 'unknown'}
  Machine   ${String(b.platform ?? '?')}, Node ${String(b.node ?? '?')}
  Running   ${b.running === true ? 'yes' : 'NO'}
  Config    ${String(b.shape ?? '?')}

  They said:
    ${r.note || '(nothing)'}

  In one line:
    ${r.summary || '(no summary)'}

  Their config:
${String(b.config ?? '(none)').split('\n').map((l) => '    ' + l).join('\n')}

  In their logs folder:
${(Array.isArray(b.files) ? (b.files as string[]) : []).map((f) => '    ' + f).join('\n') || '    (empty)'}

  Captures on their machine (names only — these are never uploaded):
${(Array.isArray(b.captures) ? (b.captures as string[]) : []).map((f) => '    ' + f).join('\n') || '    (none)'}

  ── The last of their console ─────────────────────────────────────────
`);
  console.log(String(b.console ?? '(none)'));
  console.log(`
  ── end of report #${r.id} ────────────────────────────────────────────
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logOnly = args.includes('--log');
  const id = Number(args.find((a) => /^\d+$/.test(a)) ?? 0);

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
    if (id) {
      const report = await store.getReport(db, id);
      if (!report) {
        console.error(`\n  There is no report #${id}.\n`);
        process.exit(1);
      }
      full(report, logOnly);
      return;
    }

    const rows = await store.listReports(db, 20);
    if (rows.length === 0) {
      console.log('\n  No reports. Testers send them with "10 - Send a report".\n');
      return;
    }
    console.log('');
    for (const r of rows) {
      console.log(`  #${String(r.id).padStart(3)}  ${when(r.at).padStart(8)}  ${r.handle.padEnd(14)}  ${r.summary}`);
      if (r.note) console.log(`        “${r.note.split('\n')[0]!.slice(0, 90)}”`);
    }
    console.log(`\n  ${rows.length} report${rows.length === 1 ? '' : 's'}. Read one: npm run reports <id>\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});
