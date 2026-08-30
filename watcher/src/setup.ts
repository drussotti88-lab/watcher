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
  console.log(`
  Setting up this Watcher.

  Two things, both from whoever runs the Hub: the web address of the app, and
  a token of your own. The token is yours — it is what tells the Hub which
  watchlist is yours and keeps it separate from everyone else's.
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
`);
  } finally {
    rl.close();
  }
}
