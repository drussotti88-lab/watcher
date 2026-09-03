/**
 * Which Phantom this is.
 *
 * The `VERSION` file at the root holds `$Format:%h$`, and `.gitattributes`
 * marks it `export-subst`, so `git archive` — which is what builds the tester
 * zip — writes the short commit hash into it. In a checkout it stays as the
 * literal placeholder, which is the honest answer there: a development copy
 * has no single version, and must never be overwritten by an update meant
 * for a zip.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What a checkout reports. Nothing updates a checkout. */
export const DEV = 'dev';

export function parseVersion(text: string | null | undefined): string {
  const t = String(text ?? '').trim();
  if (!t) return 'unknown';
  if (t.includes('$Format')) return DEV;
  return /^[0-9a-f]{7,40}$/i.test(t) ? t.toLowerCase() : 'unknown';
}

export function readVersion(dir: string = process.cwd()): string {
  const path = resolve(dir, 'VERSION');
  if (!existsSync(path)) return 'unknown';
  try {
    return parseVersion(readFileSync(path, 'utf8'));
  } catch {
    return 'unknown';
  }
}
