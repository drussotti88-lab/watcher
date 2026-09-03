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
 *   npm run user token <name>
 *   npm run user invite <name>
 *   npm run user disable <name>
 *   npm run user enable <name>
 */
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';
import { hashPassword, hashToken, mintInvite, sessionSecret } from '../src/auth.ts';
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

/**
 * Ask twice, because a typo in a write-only field is a locked-out person.
 *
 * USER_PASSWORD short-circuits the prompt. That exists so a password can be
 * generated on this machine and handed straight to this script without ever
 * being typed, echoed, or read back — which is how an account gets created for
 * somebody else without its password passing through a conversation.
 */
async function newPassword(): Promise<string> {
  const supplied = process.env.USER_PASSWORD ?? '';
  if (supplied) {
    if (supplied.length < 10) {
      console.error('\n  USER_PASSWORD is too short. Ten characters minimum.\n');
      process.exit(1);
    }
    return supplied;
  }
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
  npm run user token <name>
  npm run user invite <name>     a link that signs them in once and asks for a password
  npm run user arm <name>        let them run a Phantom that BUYS, on their own card
  npm run user disarm <name>     back to watching only
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
          u.canArm ? 'MAY BUY' : 'watching only',
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

    if (action === 'token') {
      const existing = await store.findUser(db, handle);
      if (!existing) {
        console.error(`\n  There is no "${handle}". Create them first: npm run user add ${handle}\n`);
        process.exit(1);
      }

      // 32 bytes of randomness, base64url. Long enough that guessing is not a
      // strategy, and URL-safe so it survives being pasted into a JSON file.
      const token = randomBytes(32).toString('base64url');
      await store.setUserToken(db, existing.handle, await hashToken(token));

      // Written to a file rather than printed. A token in a terminal is a token
      // in the scrollback, in the screenshot of the scrollback, and in whatever
      // is reading that terminal's output.
      const file = `${existing.handle}-watcher-token.txt`;
      writeFileSync(file, token + '\n', { mode: 0o600 });

      console.log(`\n  A new Watcher token for "${existing.handle}" is in ${file}.`);
      console.log('  It is not printed here on purpose. Send it to them the way you');
      console.log('  would send a password, then delete the file.');
      console.log('\n  Any token they had before this has stopped working.\n');
      return;
    }

    /*
     * ── An invite link ──────────────────────────────────────────────────
     *
     * The easy way to hand somebody an account: a link they tap. It signs
     * them in once and the front door asks them to choose a password, at
     * which point the link stops working — the MAC covers the password
     * hash, so setting one changes it. Seven days if they never tap it.
     *
     * Create the account first (npm run user add) with any throwaway
     * password; the invite is what they actually use.
     */
    if (action === 'invite') {
      const existing = await store.findUser(db, handle);
      if (!existing) {
        console.error(`\n  There is no "${handle}". Create them first: npm run user add ${handle}\n`);
        process.exit(1);
      }
      const secret = sessionSecret({
        APP_PASSWORD: process.env.APP_PASSWORD,
        SESSION_SECRET: process.env.SESSION_SECRET,
      });
      if (!secret) {
        console.error('\n  SESSION_SECRET (or APP_PASSWORD) is not in .env.local, so the link cannot be signed.\n');
        process.exit(1);
      }
      const hash = await store.passwordHashById(db, existing.id);
      const token = await mintInvite(secret, existing.id, hash ?? '');
      const base = (process.env.HUB_URL || 'https://watcher-gold.vercel.app').replace(/\/$/, '');
      const link = `${base}/invite#t=${encodeURIComponent(token)}`;

      const file = `${existing.handle}-invite.txt`;
      writeFileSync(file, link + '\n', { mode: 0o600 });
      console.log(`\n  An invite link for "${existing.handle}" is in ${file}.`);
      console.log('  Send them that link. It signs them in once, asks them to choose a');
      console.log('  password, and then stops working. Unused, it expires in 7 days.');
      console.log('  Delete the file once it is sent.\n');
      return;
    }

    /*
     * ── Arming rights ─────────────────────────────────────────────────────
     *
     * The line between a member and a tester with a machine. Granting it
     * lets their missions be armed; nothing buys until a Phantom carrying
     * THEIR token is running on their computer, signed into their own
     * retailer account. Your Phantom never spends for anyone but you.
     */
    if (action === 'arm' || action === 'disarm') {
      const ok = await store.setUserCanArm(db, handle, action === 'arm');
      if (!ok) {
        console.error(`\n  There is no "${handle}".\n`);
        process.exit(1);
      }
      if (action === 'arm') {
        console.log(`\n  "${handle}" may now arm missions.`);
        console.log('  That only takes effect on a Phantom running with THEIR token, on');
        console.log('  their own computer, signed into their own Target account. Yours');
        console.log('  will never buy for them. Next:');
        console.log('  The app now hands them the rest: the front door (and Settings) shows');
        console.log('  a Download Phantom button and a Show my token button. Nothing more');
        console.log('  to send. (npm run user token still works if you would rather.)\n');
      } else {
        console.log(`\n  "${handle}" is back to watching only. Any armed mission of theirs`);
        console.log('  now just watches; their Phantom will not buy.\n');
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
