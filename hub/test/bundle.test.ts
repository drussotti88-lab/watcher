/**
 * Does the thing we actually deploy actually run?
 *
 * Every other test in this suite imports TypeScript directly and passes
 * regardless of how the code is packaged. The first deploy proved that is not
 * enough: 66 green tests, a successful build, and a function that died on
 * startup with
 *
 *   Cannot find module '/var/task/hub/src/app.ts'
 *
 * because Vercel compiled the entry file, left the `./app.ts` specifier as
 * written, and never compiled src/ at all.
 *
 * So this test builds the real bundle and serves it over real HTTP, which is
 * the only way to catch a packaging fault before it reaches production.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';

const root = resolve(import.meta.dirname, '..');
// Built inside the project, not in /tmp: the bundle leaves `postgres` external,
// so it has to sit somewhere Node can resolve node_modules from — exactly as it
// does on Vercel.
const outDir = resolve(root, '.tmp-bundle');
const out = resolve(outDir, 'index.js');

let server: Server;
let base = '';

before(async () => {
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'npx',
    [
      'esbuild', 'src/server.ts', '--bundle', '--platform=node', '--format=esm',
      '--target=node22', '--packages=external', `--outfile=${out}`,
    ],
    { cwd: root, stdio: 'pipe' },
  );

  process.env.DATABASE_URL =
    'postgresql://postgres.ref:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres';
  process.env.APP_PASSWORD = 'smoke-test-password';
  process.env.INGEST_TOKEN = 'smoke-test-token';

  const { default: handler } = await import(`file://${out}`);
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => {
  server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

test('the bundle carries no unresolved TypeScript imports', () => {
  const code = readFileSync(out, 'utf8');
  assert.ok(!/from\s+["'][^"']+\.ts["']/.test(code), 'a .ts specifier survived the bundle');
});

test('nothing but real dependencies is left external', () => {
  const code = readFileSync(out, 'utf8');
  const externals = [...code.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]!);
  const bare = externals.filter((e) => !e.startsWith('node:'));
  assert.deepEqual(bare, ['postgres'], `unexpected externals: ${bare.join(', ')}`);
});

test('the bundled function serves the login page over real HTTP', async () => {
  // This is the assertion the first deploy failed. It proves the module graph
  // resolves, the handler is exported in the shape Vercel calls, and the
  // Node request survives being turned into a web Request and back.
  const res = await fetch(`${base}/login`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /Sign in/);
});

test('an unauthenticated API call answers 401 rather than crashing', async () => {
  const res = await fetch(`${base}/api/dashboard`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorised');
});

test('a signed-out browser is redirected, through the real adapter', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
});

test('a bad password is refused by the deployed artifact too', async () => {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
    redirect: 'manual',
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});
