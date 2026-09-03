/**
 * Keeping a tester's Phantom current.
 *
 * ── The shape of it ──────────────────────────────────────────────────────────
 *
 * The Hub carries the tester zip inside its own bundle and says which commit
 * it was built from. A running Phantom asks, compares to its own VERSION,
 * and when the Hub's is different: downloads the zip, unpacks it over this
 * folder, runs `npm install`, and exits without writing the stop marker —
 * which the launcher reads as a crash and restarts, into the new code. No
 * second process, no installer, no "please download the new version".
 *
 * ── When it will NOT ────────────────────────────────────────────────────────
 *
 *   · a development checkout (VERSION is the unsubstituted placeholder):
 *     unpacking a zip over somebody's working tree is how work gets lost
 *   · autoUpdate is false in the config
 *   · a `once` run — that is a diagnostic, not a service
 *   · a drop is close. Restarting Phantom inside the run-up cost a Walmart
 *     read on 3 Sep (the first read after a fresh launch passes, the second
 *     is walled). Ninety minutes is the readiness banner's own horizon.
 *   · the Hub's version is the one already running
 *
 * ── What it never touches ────────────────────────────────────────────────────
 *
 * The zip holds tracked files only, so watcher.config.json, the profiles,
 * the logs and the captures are not in it and cannot be overwritten. That is
 * true today by construction; `PROTECTED` makes it true by rule as well,
 * because "not in the zip" is a property of somebody else's script.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DEV } from './version.ts';

export const UPDATE_EVERY_MS = 6 * 60 * 60_000;

/** Paths, relative to the folder, that an update may not write. */
export const PROTECTED: RegExp[] = [
  /^watcher\.config\.json$/i,
  /^chrome-profile/i,
  /^logs(\/|$)/i,
  /^probe-artifacts(\/|$)/i,
  /^node_modules(\/|$)/i,
  /\.env/i,
];

export interface UpdateDecision {
  update: boolean;
  why: string;
}

/** Whether to update now. Pure, so every branch is a one-line test. */
export function planUpdate(input: {
  own: string;
  hub: string | null | undefined;
  enabled: boolean;
  once: boolean;
  minutesToDrop: number | null;
  horizonMinutes?: number;
}): UpdateDecision {
  const horizon = input.horizonMinutes ?? 90;
  if (input.own === DEV) return { update: false, why: 'a development checkout is never updated' };
  if (!input.enabled) return { update: false, why: 'autoUpdate is off' };
  if (input.once) return { update: false, why: 'a once run does not update' };
  if (!input.hub) return { update: false, why: 'the Hub has no zip built in' };
  if (input.hub === input.own) return { update: false, why: `already on ${input.own}` };
  if (input.minutesToDrop !== null && input.minutesToDrop <= horizon) {
    return { update: false, why: `a drop is ${input.minutesToDrop}m away — after it` };
  }
  return { update: true, why: `${input.own} → ${input.hub}` };
}

// ── A zip reader that is exactly as big as it needs to be ───────────────────
//
// Node ships zlib and not zip. The format is small: a central directory at
// the end lists every entry with its offset; each entry has a local header,
// then the bytes, stored (0) or deflated (8). Anything else — encryption,
// zip64, bzip — is not something `git archive --format=zip` produces, and is
// refused rather than guessed at.

export interface ZipEntry {
  name: string;
  bytes: Buffer;
}

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // a directory entry; made on demand below
    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) out.push({ name, bytes: Buffer.from(raw) });
    else if (method === 8) out.push({ name, bytes: inflateRawSync(raw) });
    else throw new Error(`${name}: compression method ${method} is not supported`);
  }
  return out;
}

/**
 * Where an entry lands, or null if it must not.
 *
 * Strips the zip's single top-level folder, refuses anything that would
 * climb out of the destination, and refuses the protected paths.
 */
export function targetFor(name: string, dest: string): { rel: string; path: string } | null {
  const parts = name.split('/').filter(Boolean);
  if (parts.length < 2) return null; // the folder itself, or a file outside it
  const rel = parts.slice(1).join('/');
  if (parts.some((p) => p === '..' || p === '.')) return null;
  if (PROTECTED.some((re) => re.test(rel))) return null;
  const path = resolve(dest, ...rel.split('/'));
  const root = resolve(dest);
  if (path !== root && !path.startsWith(root + sep)) return null;
  return { rel, path };
}

/** Unpack a tester zip over `dest`. Returns what was written. */
export function unpackOver(zip: Buffer, dest: string): string[] {
  const written: string[] = [];
  for (const entry of readZip(zip)) {
    const target = targetFor(entry.name, dest);
    if (!target) continue;
    const dir = dirname(target.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(target.path, entry.bytes);
    written.push(target.rel);
  }
  if (!written.some((w) => w === 'package.json')) {
    throw new Error('that zip has no package.json in it — refusing to call it Phantom');
  }
  return written;
}
