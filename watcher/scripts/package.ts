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
import { statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readZip } from '../src/update.ts';
import { parseVersion, DEV } from '../src/version.ts';
import { renderGuide } from '../src/guide.ts';
import { resolve, dirname } from 'node:path';

const OUT = 'Phantom-for-tester.zip';

/**
 * The first thing a tester sees in the unzipped folder.
 *
 * Named to sort above every numbered launcher and to say what to do with it.
 * HTML because .md does not open on a double-click on Windows, which is what
 * a tester has.
 */
const GUIDE = 'START HERE.html';

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
 * The cwd matters more than it looks, and so does passing a COMMIT.
 *
 * `git archive HEAD:<dir>` — a tree — cannot substitute `$Format:%h$` into
 * VERSION, because a tree has no commit to name. It does not fail; it writes
 * the placeholder, and every tester's Phantom then believes it is a
 * development checkout and never updates itself. Caught on 3 Sep by opening
 * the zip and reading the file.
 *
 * Run from inside watcher/ with a commit and a `.` pathspec, git resolves
 * the pathspec against the current prefix and writes paths relative to it —
 * so the archive is rooted at the folder, the prefix below is what the tester
 * sees, and export-subst has the commit it needs.
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
  const here = resolve(root, 'watcher');

  // ── The instructions, in a format Windows will open ────────────────────
  //
  // Rendered from SETUP.md rather than written twice, and COMMITTED, because
  // the zip comes from `git archive HEAD` and would otherwise ship whatever
  // was committed last time. Same discipline as the Hub's api/index.js: a
  // generated file in the tree, and a loud failure when it is stale.
  const guide = renderGuide(readFileSync(resolve(here, 'SETUP.md'), 'utf8'), '$Format:%h$');
  const guidePath = resolve(here, GUIDE);
  writeFileSync(guidePath, guide);

  let committed = '';
  try {
    // "HEAD:./name" resolves from the CWD; "HEAD:name" resolves from the
    // repository root, which is one directory up from here and does not
    // have it. git says "exists, but not" and means exactly that.
    committed = git(['show', `HEAD:./${GUIDE}`], here);
  } catch {
    /* not committed yet — reported below as a difference */
  }
  if (committed !== guide) {
    console.error(
      `\n  "${GUIDE}" has been rebuilt from SETUP.md and does not match HEAD.` +
        `\n  The zip is built from HEAD, so it would ship the old one.` +
        `\n\n  Commit it, then run this again:` +
        `\n      git add watcher/"${GUIDE}" && git commit\n`,
    );
    process.exit(1);
  }

  git(
    ['archive', '--format=zip', '--prefix=Phantom/', '-o', resolve(root, OUT), 'HEAD', '.'],
    here,
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

  // Prove the substitution happened rather than trusting it. A zip whose
  // VERSION still holds the placeholder is a fleet of Phantoms that will
  // never update again, and it looks exactly like a working zip.
  // Read it out properly rather than searching the zip's bytes: a small file
  // is deflated, so the placeholder is not there as text even when it IS
  // there. update.ts already has the reader, and using the same one means the
  // check runs the code the tester's machine will run.
  const versionEntry = readZip(readFileSync(resolve(root, OUT))).find(
    (e) => e.name === 'Phantom/VERSION',
  );
  const version = parseVersion(versionEntry?.bytes.toString('utf8'));
  if (version === DEV || version === 'unknown') {
    console.error(
      `\n  The zip's VERSION reads "${version}", not a commit.` +
        `\n  Every Phantom from this zip would think it was a checkout and never` +
        `\n  update itself. Nothing was sent.\n`,
    );
    process.exit(1);
  }

  const size = statSync(resolve(root, OUT)).size;
  const hasSetup = listing.includes('Phantom/SETUP.md');
  if (!listing.includes(`Phantom/${GUIDE}`)) {
    console.error(`\n  The zip has no "${GUIDE}". A tester would open the folder to nothing readable.\n`);
    process.exit(1);
  }

  // The guide carries the build it came from, by the same export-subst trick
  // VERSION uses — and it silently did not, first time out, because a
  // .gitattributes pattern is whitespace-separated: `START HERE.html
  // export-subst` parses as the pattern "START" with the attributes
  // "HERE.html" and "export-subst", so nothing was ever marked. It has to be
  // quoted. Checked here rather than trusted, because the failure looks
  // exactly like success from the outside: a perfectly good zip, with
  // "version $Format:%h$" printed at the top of the first page a tester
  // reads.
  const shipped = readZip(readFileSync(resolve(root, OUT))).find(
    (e) => e.name === `Phantom/${GUIDE}`,
  );
  if (!shipped || shipped.bytes.toString('utf8').includes('$Format')) {
    console.error(
      `\n  "${GUIDE}" in the zip still holds the placeholder instead of a version.` +
        `\n  Check that .gitattributes has:  "${GUIDE}" export-subst   — with the quotes.\n`,
    );
    process.exit(1);
  }
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

  // ── Hand it to the Hub ─────────────────────────────────────────────────
  //
  // The front door offers a Download button, and the Hub is one serverless
  // function with no static files, so the zip travels INSIDE the bundle as
  // base64 in a generated module. That module is committed, like api/index.js
  // is; this is the only thing that writes it. 320kb of zip is 430kb of text,
  // which is fine, and the sha it records is what the door shows a tester so
  // that "which version do you have" has an answer.
  const generated = resolve(root, 'hub', 'src', 'generated', 'phantom-zip.ts');
  let handed = '';
  if (existsSync(resolve(root, 'hub', 'src'))) {
    const sha = version;
    const b64 = readFileSync(resolve(root, OUT)).toString('base64');
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(
      generated,
      [
        '// Generated by `npm run package` in watcher/. Do not edit.',
        '//',
        '// The tester zip, carried inside the Hub bundle so the front door can',
        '// offer it as a download. Rebuild it whenever watcher/ changes:',
        '//   cd watcher && npm run package && cd ../hub && npm run bundle',
        `export const PHANTOM_ZIP_META = ${JSON.stringify({ sha, builtAt: new Date().toISOString(), files: listing.length, bytes: size, launchers })};`,
        `export const PHANTOM_ZIP_BASE64 = '${b64}';`,
        '',
      ].join('\n'),
    );
    handed = `\n  Also written: hub/src/generated/phantom-zip.ts (sha ${sha}).\n  Now:  cd ../hub && npm run bundle   and commit both.\n`;
  }

  console.log(`
  ${OUT}  ·  ${listing.length} files  ·  ${(size / 1024).toFixed(0)}kb
${handed}
  Built from HEAD, so it holds only tracked files: no profile, no log, no
  config, no token. ${launchers} double-click launchers included.

  Send it with the app's address and a token from:  npm run user token <name>
  (run in the hub folder). Their first step is "1 - Set up".
  If they are to BUY as well as watch:  npm run user arm <name>
`);
}

main();
