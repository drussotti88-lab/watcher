/**
 * Getting a second person running.
 *
 * Everything else in this repo was written for the machine it grew up on. This
 * file exists because handing somebody a folder and saying "copy the example
 * config and fill it in" is how you spend an evening on a video call reading
 * JSON to each other.
 *
 * It asks two questions, writes one file, and then — the part that matters —
 * actually calls the Hub with the token it just wrote. A setup step that says
 * "done!" without proving anything is worse than no setup step, because the
 * failure then arrives an hour later disguised as something else.
 */
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, platform } from 'node:os';

// ── Before anything else, is this machine able to run it? ────────────────────

export interface Check {
  name: string;
  ok: boolean;
  /** What to do about it, in words a person can act on. Empty when fine. */
  fix: string;
  detail: string;
}

/**
 * Node has to be new enough to run TypeScript without a build step.
 *
 * The whole repo is .ts files run directly. On an older Node the failure is
 * `Unknown file extension ".ts"`, which tells a person nothing about what to
 * install — so it is worth catching here and saying the version out loud.
 */
export function checkNode(version = process.versions.node): Check {
  const parts = String(version).split('.').map((n) => Number(n));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const ok = major > 22 || (major === 22 && minor >= 6);
  return {
    name: 'Node',
    ok,
    detail: `v${version}`,
    fix: ok
      ? ''
      : 'This needs Node 22.6 or newer — it runs TypeScript directly, with no ' +
        'build step.\n     Get the LTS installer from nodejs.org, then close this ' +
        'window and open a new one.',
  };
}

/** Where Chrome lives on each platform, so a missing one is named early. */
export function chromePaths(os = platform(), home = homedir()): string[] {
  if (os === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${home}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  if (os === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

/**
 * Is Chrome installed?
 *
 * Real Chrome, not a bundled Chromium: the retailers answer a browser somebody
 * actually uses and challenge one that looks automated. Checked by looking for
 * the file rather than by launching it, because launching takes six seconds and
 * this runs before anything else.
 */
export function checkChrome(exists: (p: string) => boolean = existsSync, os = platform()): Check {
  const found = chromePaths(os).find((p) => exists(p));
  return {
    name: 'Google Chrome',
    ok: Boolean(found),
    detail: found ? 'installed' : 'not found in the usual places',
    fix: found
      ? ''
      : 'Install Google Chrome from google.com/chrome. Phantom drives a real\n' +
        '     Chrome on your own connection — that is the part that makes the shops\n' +
        '     answer at all.',
  };
}

/** Everything to check before asking for an address and a token. */
export function preflight(): Check[] {
  return [checkNode(), checkChrome()];
}

/** The preflight as something to read. Empty when everything passed. */
export function renderPreflight(checks: Check[]): string {
  const lines: string[] = [''];
  for (const c of checks) {
    lines.push(`  ${c.ok ? '  ok' : 'NEED'}  ${c.name.padEnd(16)} ${c.detail}`);
  }
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) return `${lines.join('\n')}\n`;
  lines.push('');
  for (const c of bad) lines.push(`  ${c.name}\n     ${c.fix}\n`);
  return lines.join('\n');
}

export interface SetupAnswers {
  url: string;
  token: string;
}

/** Tidy up what a person pastes. Trailing slashes and stray quotes, mostly. */
export function cleanUrl(raw: string): string {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '');
  if (!trimmed) return '';
  // Somebody pasting a hostname without a scheme means https. Nobody has ever
  // meant http here, and defaulting to it would send the token in clear text.
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function cleanToken(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

/** What the config file should say, given the example and the two answers. */
export function configFrom(example: string, answers: SetupAnswers): string {
  const parsed = JSON.parse(example) as Record<string, unknown>;
  parsed.hub = { url: answers.url, token: answers.token };
  return JSON.stringify(parsed, null, 2) + '\n';
}

export interface CheckResult {
  ok: boolean;
  /** Said in words a person can act on, not a status code. */
  message: string;
}

/**
 * Prove the token works, and say something useful when it doesn't.
 *
 * The three failures worth telling apart are a wrong URL, a wrong token, and a
 * Hub that is simply asleep — they feel identical from the outside and have
 * completely different fixes.
 */
export async function checkHub(
  answers: SetupAnswers,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${answers.url}/api/missions/active`, {
      headers: { Authorization: `Bearer ${answers.token}` },
    });
  } catch (err) {
    return {
      ok: false,
      message:
        `Could not reach ${answers.url} at all (${(err as Error).message}).\n` +
        `  Check the address is right and that you are online.`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        'The Hub answered, but it did not recognise the token.\n' +
        '  Ask for a fresh one — a token is replaced every time a new one is issued,\n' +
        '  so an older one stops working.',
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      message:
        `${answers.url} answered, but not as a Hub.\n` +
        '  That is usually the wrong address rather than the wrong token.',
    };
  }
  if (!res.ok) {
    return { ok: false, message: `The Hub answered ${res.status}. It may be starting up.` };
  }

  const body = (await res.json().catch(() => null)) as { missions?: unknown[] } | null;
  const n = Array.isArray(body?.missions) ? body.missions.length : 0;
  return {
    ok: true,
    message:
      n === 0
        ? 'Connected. You have no missions yet — add a product in the app and it will appear here.'
        : `Connected. ${n} mission${n === 1 ? '' : 's'} waiting.`,
  };
}

const EXAMPLE_PATH = resolve(process.cwd(), 'watcher.config.example.json');
const CONFIG_PATH = resolve(process.cwd(), 'watcher.config.json');

/** The interactive half. Kept thin: everything worth testing is above. */
export async function runSetup(): Promise<void> {
  console.log('\n  Setting up this Phantom.\n');

  // The machine first. An address and a token are no use on a computer that
  // cannot run the thing, and the failures that follow are unreadable.
  const checks = preflight();
  console.log(renderPreflight(checks));
  if (checks.some((c) => !c.ok)) {
    console.error('  Fix the above, then run this again. Nothing was written.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`  Two things now, both from whoever runs the Hub: the web address of the
  app, and a token of your own. The token is yours — it is what tells the Hub
  which watchlist is yours and keeps it separate from everyone else's.
`);

  if (existsSync(CONFIG_PATH)) {
    console.log('  There is already a watcher.config.json here.');
    console.log('  Carrying on will overwrite it.\n');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const url = cleanUrl(await rl.question('  Hub address: '));
    const token = cleanToken(await rl.question('  Your token:  '));

    if (!url || !token) {
      console.error('\n  Both are needed. Nothing was written.\n');
      process.exitCode = 1;
      return;
    }

    console.log('\n  Checking…');
    const check = await checkHub({ url, token });
    if (!check.ok) {
      // Deliberately not written. A config that does not work is worse than no
      // config, because `npm run watch` then fails somewhere further in.
      console.error(`\n  ${check.message}\n\n  Nothing was written. Run this again when you have it.\n`);
      process.exitCode = 1;
      return;
    }

    const example = readFileSync(EXAMPLE_PATH, 'utf8');
    writeFileSync(CONFIG_PATH, configFrom(example, { url, token }), { mode: 0o600 });

    console.log(`
  ${check.message}

  Written to watcher.config.json. Treat that file the way you would treat a
  saved password.

  Start it with:  npm run watch

  It opens a Chrome window and leaves it open. That window is signed out on
  purpose — it does the looking and nothing else, and it never touches an
  account with a card in it.

  Optional: "4 - Start automatically" makes it start when you log in, so a
  restart does not quietly leave you watching nothing. It explains exactly what
  it changes before it changes anything, and "5" undoes it.
`);
  } finally {
    rl.close();
  }
}
