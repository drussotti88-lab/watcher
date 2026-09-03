/**
 * A copy of Phantom fit to hand to somebody else.
 *
 * Built with `git archive`, which is the whole trick: it can only ever contain
 * *tracked* files. The browser profiles, the activity log and watcher.config.json
 * are all gitignored, so they cannot end up in the zip by accident — which is
 * not a theoretical worry. 534 files of Chrome profile state went into a public
 * repository once already because a glob said `chrome-profile/` and the
 * directory had been renamed.
 *
 * Then it checks the zip anyway. A rule enforced by a comment is a rule that
 * holds until someone `git add -f`s something at midnight.
 *
 *   npm run package
 */
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = 'Phantom-for-tester.zip';

/** Anything matching these must never reach another person's machine. */
const FORBIDDEN = [
  { pattern: /chrome-profile/i, why: 'a Chrome profile — browsing history and cookies' },
  { pattern: /watcher\.config\.json$/i, why: 'the config file, which holds a Hub token' },
  { pattern: /\/logs\//i, why: 'the activity log' },
  { pattern: /-(watcher-token|invite|password)\.txt$/i, why: 'a credential file the user CLI wrote' },
  { pattern: /probe-artifacts/i, why: 'captured pages, which embed a visitor id and postcode' },
  { pattern: /\.env/i, why: 'an environment file' },
];

/**
 * git, always from the repository root.
 *
 * The cwd matters more than it looks. `git archive HEAD:<dir>` run from
 * inside that directory resolves the path against the current prefix, finds
 * nothing, and cheerfully writes a 132-byte zip containing one empty directory
 * — no error, no warning, and a "packaged!" message. The check below caught it
 * only because it counts what it packed.
 *
 * And the directory is `watcher/`, whatever the program is called: the app was
 * renamed Phantom on 1 Sep 2026 and this script said `HEAD:Phantom` from then
 * until 3 Sep, when somebody tried to build a zip and git said "not a valid
 * object name". The tree does not know the product's name; the prefix below
 * is what the tester sees.
 */
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd });
}

/**
 * Every filename in a zip, read from its central directory.
 *
 * Done by hand rather than by shelling out to `unzip`, which does not exist on
 * Windows — and this script's whole job is to run on the machine that is
 * sending the zip, which is a Windows machine.
 */
function namesIn(path: string): string[] {
  const buf = readFileSync(path);

  // The end-of-central-directory record is last, but a zip comment can follow
  // it, so scan backwards for the signature rather than assuming an offset.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt central directory');
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    names.push(buf.toString('utf8', at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function main(): void {
  const root = git(['rev-parse', '--show-toplevel']).trim();

  // HEAD, not the working tree. Whatever is half-edited on this desk right now
  // is not what somebody else should be starting from.
  git(
    ['archive', '--format=zip', '--prefix=Phantom/', '-o', resolve(root, OUT), 'HEAD:watcher'],
    root,
  );

  const listing = namesIn(resolve(root, OUT));

  const bad: string[] = [];
  for (const name of listing) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(name)) bad.push(`    ${name}  — ${rule.why}`);
    }
  }
  if (bad.length) {
    console.error(`\n  REFUSING to ship this zip. It contains:\n\n${bad.join('\n')}\n`);
    process.exit(1);
  }

  const size = statSync(resolve(root, OUT)).size;
  const hasSetup = listing.includes('Phantom/SETUP.md');
  const launchers = listing.filter((n) => /\.(bat|command)$/i.test(n)).length;

  // An empty archive is a silent failure mode, not a hypothetical one — see
  // the note on git() above. Refuse rather than hand over a zip with nothing
  // in it and a message saying it worked.
  if (launchers < 10) {
    console.error(
      `\n  Only ${launchers} launchers in the zip, expected 10.` +
        `\n  A tester who has to type npm commands is one who does not finish.\n`,
    );
    process.exit(1);
  }

  if (listing.length < 10 || !hasSetup) {
    console.error(
      `\n  Only ${listing.length} entries and ${hasSetup ? 'SETUP.md present' : 'no SETUP.md'}.` +
        `\n  That is not a working copy of Phantom. Nothing was sent.\n`,
    );
    process.exit(1);
  }

  console.log(`
  ${OUT}  ·  ${listing.length} files  ·  ${(size / 1024).toFixed(0)}kb

  Built from HEAD, so it holds only tracked files: no profile, no log, no
  config, no token. ${launchers} double-click launchers included.

  Send it with the app's address and a token from:  npm run user token <name>
  (run in the hub folder). Their first step is "1 - Set up".
  If they are to BUY as well as watch:  npm run user arm <name>
`);
}

main();
