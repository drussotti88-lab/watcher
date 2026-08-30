/**
 * Accounts, from the terminal that has the database password.
 *
 * There is deliberately no "create a user" button in the app. Two reasons, and
 * the second is the real one:
 *
 *   · a dashboard that can mint accounts is a dashboard where one stolen
 *     session becomes permanent access, and
 *   · a password typed here is typed by Roberto, into his own terminal,
 *     against his own database. It does not pass through a chat window, a
 *     transcript, or me.
 *
 *   npm run user list
 *   npm run user add <name>
 *   npm run user passwd <name>
 *   npm run user disable <name>
 *   npm run user enable <name>
 */
import { createInterface } from 'node:readline';
import postgres from 'postgres';
import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';
import { hashPassword } from '../src/auth.ts';
import * as store from '../src/store.ts';

/**
 * Read a password without printing it.
 *
 * readline echoes by default, and a password in a terminal's scrollback is a
 * password in every screenshot taken afterwards. Muting the output stream is
 * the whole trick.
 */
function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const write = out.write.bind(out);
    process.stdout.write(prompt);
    out.muted = true;
    (out as unknown as { write: (c: string) => boolean }).write = (chunk: string): boolean =>
      out.muted ? true : write(chunk);
    rl.question('', (answer) => {
      (out as unknown as { write: typeof write }).write = write;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

/** Ask twice, because a typo in a write-only field is a locked-out person. */
async function newPassword(): Promise<string> {
  const first = await askSecret('  new password: ');
  if (first.length < 10) {
    console.error('\n  Too short. Ten characters minimum — this is the door to a card.\n');
    process.exit(1);
  }
  const again = await askSecret('  again:        ');
  if (first !== again) {
    console.error('\n  Those did not match. Nothing changed.\n');
    process.exit(1);
  }
  return first;
}

function usage(): never {
  console.error(`
  npm run user list
  npm run user add <name>
  npm run user passwd <name>
  npm run user disable <name>
  npm run user enable <name>
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [action, handle] = process.argv.slice(2);
  if (!action) usage();

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
    if (action === 'list') {
      const users = await store.listUsers(db);
      console.log('');
      for (const u of users) {
        const bits = [
          u.enabled ? 'enabled ' : 'DISABLED',
          u.hasPassword ? 'password' : 'no password',
          u.hasToken ? 'watcher token' : 'no watcher',
        ];
        console.log(`  ${String(u.id).padStart(3)}  ${u.handle.padEnd(16)}  ${bits.join('  ·  ')}`);
      }
      console.log(`\n  ${users.length} account${users.length === 1 ? '' : 's'}.\n`);
      return;
    }

    if (!handle) usage();

    if (action === 'add' || action === 'passwd') {
      const existing = await store.findUser(db, handle);
      if (action === 'add' && existing) {
        console.error(`\n  "${handle}" already exists. Use passwd to change it.\n`);
        process.exit(1);
      }
      if (action === 'passwd' && !existing) {
        console.error(`\n  There is no "${handle}". Use add to create one.\n`);
        process.exit(1);
      }

      console.log(`\n  ${action === 'add' ? 'Creating' : 'Changing the password for'} "${handle}".`);
      const password = await newPassword();
      const id = await store.upsertUser(db, handle, await hashPassword(password));

      if (action === 'add') {
        // A brand-new account with no sources has a dashboard that cannot
        // sweep and a Sweep button that answers "no enabled source". Copy the
        // owner's, so the first thing they see is a working app rather than a
        // support question.
        const copied = await db.query(
          `INSERT INTO sources (user_id, id, label, retailer, kind, url, via, config, enabled)
           SELECT $1, id, label, retailer, kind, url, via, config, enabled
             FROM sources WHERE user_id = 1
           ON CONFLICT (user_id, id) DO NOTHING
           RETURNING id`,
          [id],
        );
        console.log(`\n  Created user ${id} with ${copied.length} sources.`);
        console.log('  They see none of your products, missions or activity — only their own.');
        console.log('\n  They will need a Watcher of their own before anything appears.');
        console.log('  Nothing checks a listing except a Watcher, and yours only works');
        console.log('  your missions.\n');
      } else {
        console.log(`\n  Password changed for user ${id}.\n`);
      }
      return;
    }

    if (action === 'disable' || action === 'enable') {
      const ok = await store.setUserEnabled(db, handle, action === 'enable');
      console.log(ok ? `\n  "${handle}" is now ${action}d.\n` : `\n  There is no "${handle}".\n`);
      if (!ok) process.exitCode = 1;
      return;
    }

    usage();
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`\n  failed: ${(err as Error).message}\n`);
  process.exit(1);
});
