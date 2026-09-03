/**
 * A report a tester can send when something looks wrong.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * "It isn't working" is not debuggable, and asking somebody to find a log file
 * and paste the interesting part of it is asking them to do the diagnosis
 * before they can ask for help. So: one double-click gathers what a person
 * looking at the machine would look at, and posts it to the Hub, where the
 * owner reads it.
 *
 * ── What goes in ────────────────────────────────────────────────────────────
 *
 * The last stretch of console output, the config with its secrets replaced by
 * a shape, which Node and Chrome, which Phantom, whether it is running, what
 * is in the log folder, and the names of any captures. That is the set that
 * has actually answered every "why is it not doing anything" so far.
 *
 * ── What must not ───────────────────────────────────────────────────────────
 *
 * Everything here goes through the same scrubber the activity log uses, and
 * the config's own token is passed in as a known secret so that a line quoting
 * it back cannot survive. Captures are named but never uploaded: they are the
 * logged-in DOM of a retail page, and they stay on the machine that made them.
 * Nothing reads the browser profiles.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scrub } from './scrub.ts';

/** How much of the console to send. Enough for several passes, not a novel. */
export const TAIL_LINES = 400;
export const MAX_CHARS = 200_000;

export interface ReportInput {
  dir: string;
  version: string;
  note?: string;
  now?: Date;
  platform?: string;
  nodeVersion?: string;
}

export interface Report {
  at: string;
  version: string;
  /** The one line the owner's list shows. Filled in by buildReport. */
  summary: string;
  note: string;
  platform: string;
  node: string;
  running: boolean;
  /** Prose about the config's secrets — nothing here is redactable. */
  shape: string;
  config: string;
  console: string;
  files: string[];
  captures: string[];
}

/** The last N lines of a file, or a sentence saying why not. */
export function tail(path: string, lines = TAIL_LINES): string {
  if (!existsSync(path)) return `(no ${path})`;
  try {
    const all = readFileSync(path, 'utf8').split('\n');
    const kept = all.slice(Math.max(0, all.length - lines)).join('\n');
    return kept.length > MAX_CHARS ? kept.slice(kept.length - MAX_CHARS) : kept;
  } catch (err) {
    return `(could not read ${path}: ${(err as Error).message})`;
  }
}

/**
 * The config, with the token taken out before anything else looks at it.
 *
 * The scrubber redacts a `"token": …` value on its own — that rule is why
 * this cannot show a shape or a prefix, and it is the right rule, so this
 * does not try to smuggle one past it. The one useful fact about a token
 * you cannot see is how long it is, and that goes in `shape` below, as
 * prose, where there is nothing to redact.
 */
export function redactConfig(raw: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return '(watcher.config.json is not valid JSON — that is very likely the problem)';
  }
  const hub = (parsed.hub ?? {}) as { url?: string; token?: string };
  const token = String(hub.token ?? '');
  return JSON.stringify(
    {
      ...parsed,
      hub: {
        url: hub.url ?? '',
        token: token ? '(set)' : '(empty)',
      },
    },
    null,
    2,
  );
}

/** Names and sizes only — never the contents. */
function listing(dir: string, limit = 40): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .slice(0, limit)
      .map((name) => {
        try {
          const s = statSync(join(dir, name));
          const size = s.isDirectory() ? 'dir' : `${Math.round(s.size / 1024)}kb`;
          return `${name}  ${size}  ${s.mtime.toISOString()}`;
        } catch {
          return name;
        }
      });
  } catch {
    return [];
  }
}

export function buildReport(input: ReportInput): Report {
  const r = gather(input);
  // Computed here rather than by the caller, because the Hub stores it as a
  // column and the owner's list shows nothing else. It was left to the CLI
  // once, and the first real report arrived with a blank summary.
  return { ...r, summary: summarise(r) };
}

function gather(input: ReportInput): Report {
  const dir = resolve(input.dir);
  const configPath = join(dir, 'watcher.config.json');
  const rawConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  // The token is the one secret this process definitely holds, so it is named
  // to the scrubber rather than left to the general patterns.
  let secret = '';
  try {
    secret = String((JSON.parse(rawConfig) as { hub?: { token?: string } })?.hub?.token ?? '');
  } catch {
    /* an unparseable config has no token to protect */
  }
  const clean = (text: string): string => scrub(text, secret ? [secret] : []);

  return {
    at: (input.now ?? new Date()).toISOString(),
    version: input.version,
    summary: '',
    note: clean(String(input.note ?? '').slice(0, 2000)),
    platform: input.platform ?? `${process.platform} ${process.arch}`,
    node: input.nodeVersion ?? process.version,
    running: existsSync(join(dir, 'logs', '.running')),
    shape: rawConfig
      ? `the app address is ${/\"url\"\s*:\s*\"\s*\"/.test(rawConfig) ? 'EMPTY' : 'set'}, ` +
        `and the value it signs in with is ${secret.length} characters long`
      : 'there is no config file',
    config: rawConfig ? clean(redactConfig(rawConfig)) : '(no watcher.config.json — setup never finished)',
    console: clean(tail(join(dir, 'logs', 'console-run.log'))),
    files: listing(join(dir, 'logs')),
    // Named, never sent. See the note at the top.
    captures: listing(join(dir, 'logs', 'queue'), 10),
  };
}

/** What the owner reads first, before opening the console dump. */
export function summarise(r: Report): string {
  const lines = [
    `Phantom ${r.version} on ${r.platform}, Node ${r.node}`,
    r.running ? 'It believes it is running.' : 'It is NOT running (no lock file).',
  ];
  if (r.config.startsWith('(no ')) lines.push('Setup never finished — there is no config.');
  else if (/0 characters/.test(r.shape)) lines.push('There is no token in the config.');
  if (/is not valid JSON/.test(r.config)) lines.push('The config file is corrupt.');
  const walls = (r.console.match(/served a challenge/g) ?? []).length;
  if (walls) lines.push(`${walls} bot checks in the log tail.`);
  if (/Unknown file extension/.test(r.console)) lines.push('Node is too old.');
  if (/did not recognise the token/.test(r.console)) lines.push('The Hub refused its token.');
  if (/Could not reach/.test(r.console)) lines.push('It could not reach the Hub.');
  return lines.join(' ');
}
