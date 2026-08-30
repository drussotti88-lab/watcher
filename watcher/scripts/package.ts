/**
 * A copy of the Watcher fit to hand to somebody else.
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
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = 'watcher-for-tester.zip';

/** Anything matching these must never reach another person's machine. */
const FORBIDDEN = [
  { pattern: /chrome-profile/i, why: 'a Chrome profile — browsing history and cookies' },
  { pattern: /watcher\.config\.json$/i, why: 'the config file, which holds a Hub token' },
  { pattern: /^watcher\/logs\//i, why: 'the activity log' },
  { pattern: /probe-artifacts/i, why: 'captured pages, which embed a visitor id and postcode' },
  { pattern: /\.env/i, why: 'an environment file' },
];

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(): void {
  const root = git(['rev-parse', '--show-toplevel']).trim();

  // HEAD, not the working tree. Whatever is half-edited on this desk right now
  // is not what somebody else should be starting from.
  git(['archive', '--format=zip', '--prefix=watcher/', '-o', resolve(root, OUT), 'HEAD:watcher']);

  const listing = execFileSync('unzip', ['-Z1', resolve(root, OUT)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

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
  const hasSetup = listing.includes('watcher/SETUP.md');

  console.log(`
  ${OUT}  ·  ${listing.length} files  ·  ${(size / 1024).toFixed(0)}kb

  Built from HEAD, so it holds only tracked files: no profile, no log, no
  config, no token.${hasSetup ? '' : '\n\n  WARNING: SETUP.md is not in it. Commit it first.'}

  Send it with the app's address and a token from:  npm run user token <name>
  Their first step is:  npm install && npm run setup
`);
}

main();
