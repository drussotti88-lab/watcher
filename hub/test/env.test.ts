/**
 * Every setting the app declares must actually reach it.
 *
 * `env()` in server.ts builds the Env the handler sees, field by field, from
 * process.env. A field declared in types.ts but left out of that object is
 * silently undefined in production, however carefully it was typed into
 * Vercel — TypeScript cannot catch it, because every such field is optional.
 *
 * Found 19 Oct 2026: PHANTOM_SHARED_SECRET, VAULT_URL and VAULT_OWNER_USER_ID
 * were declared in Env and never passed through, so the vault link (SSO,
 * entitlement checks, sending acquisitions) could not switch on; and
 * SESSION_SECRET, declared only on auth.ts's AuthEnv, never reached the app
 * either, so every session cookie was signed with the owner's APP_PASSWORD.
 * On that main this file fails on all four (and on DISCORD_DRAWS_WEBHOOK_URL).
 *
 * Read as text, statically: no network, no process.env, nothing started.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name: string): Promise<string> =>
  readFile(new URL('../src/' + name, import.meta.url), 'utf8');

/** Comments out, so a field named in prose is not mistaken for code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The text between `opener` and the first line that is just `}` at column 0 —
 * which is how both an exported interface and a top-level function end here.
 */
function block(src: string, opener: string): string {
  const start = src.indexOf(opener);
  assert.ok(start >= 0, `could not find "${opener}" — was it renamed? Update this test with it`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `could not find the end of "${opener}"`);
  return src.slice(start + opener.length, end);
}

/** Field names of an interface: `  NAME?: type;` at two-space indent. */
function interfaceFields(src: string, name: string): string[] {
  const body = stripComments(block(src, `export interface ${name} {`));
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\??\s*:/gm)].map((m) => m[1]!);
}

/** Keys of the object env() returns: `NAME:` anywhere in its body. */
function passedThrough(serverSrc: string): Set<string> {
  const body = stripComments(block(serverSrc, 'function env(): Env {'));
  return new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:/g)].map((m) => m[1]!));
}

/** The rule itself, kept separate so it can be shown failing below. */
function missing(fields: readonly string[], passed: Set<string>): string[] {
  return fields.filter((f) => !passed.has(f));
}

test('EVERY FIELD OF Env IS PASSED THROUGH BY env() IN server.ts', async () => {
  const fields = interfaceFields(await read('types.ts'), 'Env');
  // Not an empty list passing for a guard: the parser has to have found the
  // fields we know are there.
  for (const known of ['DATABASE_URL', 'APP_PASSWORD', 'SESSION_SECRET', 'PHANTOM_SHARED_SECRET', 'VAULT_URL']) {
    assert.ok(fields.includes(known), `parser did not find ${known} in Env`);
  }
  const absent = missing(fields, passedThrough(await read('server.ts')));
  assert.deepEqual(
    absent,
    [],
    `declared in types.ts Env but not passed through env() in server.ts, so undefined in production: ${absent.join(', ')}`,
  );
});

test('EVERY SETTING AUTH READS IS DECLARED ON Env, SO THE RULE ABOVE COVERS IT', async () => {
  // SESSION_SECRET lived only on AuthEnv, which is how it slipped past both
  // the type checker and anybody reading Env.
  const authFields = interfaceFields(await read('auth.ts'), 'AuthEnv');
  assert.ok(authFields.includes('SESSION_SECRET'), 'parser did not find SESSION_SECRET in AuthEnv');
  const envFields = new Set(interfaceFields(await read('types.ts'), 'Env'));
  assert.deepEqual(authFields.filter((f) => !envFields.has(f)), []);
});

test('THE CHECK FAILS ON AN env() THAT DROPS A FIELD, LIKE MAIN DID BEFORE 19 OCT', () => {
  // The shape of the bug, in miniature: declared, read by the handler, and
  // left out of the object. If this stops reporting VAULT_URL, the guard
  // above has become a comment.
  const types = `export interface Env {\n  DATABASE_URL: string;\n  /** Where the vault lives. */\n  VAULT_URL?: string;\n}\n`;
  const server = `function env(): Env {\n  return {\n    DATABASE_URL: process.env.DATABASE_URL ?? '',\n    // VAULT_URL: forgotten\n  };\n}\n`;
  assert.deepEqual(missing(interfaceFields(types, 'Env'), passedThrough(server)), ['VAULT_URL']);
});
