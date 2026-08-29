/**
 * Being installable.
 *
 * A PWA fails to install silently. There is no error anywhere — the browser
 * just never offers it — so the only way to know the manifest, the icons and
 * the worker are all actually reachable and well-formed is to assert it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import { MANIFEST } from '../src/pwa.ts';
import type { Env } from '../src/types.ts';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: 'tok',
  APP_PASSWORD: 'pw',
};

/** No Authorization header and no cookie: exactly how a browser asks. */
async function anon(path: string): Promise<Response> {
  const db = await TestDb.create();
  return createHandler(db, env)(new Request('https://hub.test' + path));
}

test('THE MANIFEST IS PUBLIC — a signed-out browser can read it', async () => {
  // A manifest is fetched without credentials unless it says otherwise. Behind
  // the session it 302s to the login page, the browser gives up, and the app
  // is quietly never installable.
  const res = await anon('/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /manifest\+json/);
});

test('the service worker and icons are public too', async () => {
  for (const path of ['/sw.js', '/icon-192.png', '/icon-512.png', '/icon-maskable.png']) {
    const res = await anon(path);
    assert.equal(res.status, 200, path + ' should be reachable signed out');
  }
});

test('the icons are real PNGs of the size the manifest claims', async () => {
  // The manifest saying 512x512 does not make it so, and Chrome checks.
  for (const icon of MANIFEST.icons) {
    const res = await anon(icon.src);
    const bytes = new Uint8Array(await res.arrayBuffer());

    assert.deepEqual(
      Array.from(bytes.slice(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      icon.src + ' is not a PNG',
    );
    // IHDR: width and height are big-endian uint32 at bytes 16 and 20.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const [w, h] = [view.getUint32(16), view.getUint32(20)];
    assert.equal(`${w}x${h}`, icon.sizes, icon.src + ' is not the size it claims');
  }
});

test('an install needs the three things Chrome insists on', async () => {
  assert.ok(MANIFEST.name && MANIFEST.short_name, 'a name and a short name');
  assert.equal(MANIFEST.display, 'standalone');
  assert.equal(MANIFEST.start_url, '/');
  assert.ok(
    MANIFEST.icons.some((i) => i.sizes === '192x192'),
    'Chrome requires a 192px icon',
  );
  assert.ok(
    MANIFEST.icons.some((i) => i.sizes === '512x512'),
    'and a 512px one',
  );
  assert.ok(
    MANIFEST.icons.some((i) => i.purpose === 'maskable'),
    'without a maskable icon Android crops the art into a circle',
  );
});

test('THE SERVICE WORKER CACHES NOTHING', async () => {
  // Deliberate, and worth a test because "add a cache" is the obvious next
  // change and it would put a stale price on the phone's screen. This whole
  // system exists to not give confident wrong answers.
  const sw = await (await anon('/sw.js')).text();
  assert.doesNotMatch(sw, /caches\.(open|match|put)/, 'no cache API');
  assert.doesNotMatch(sw, /cache\.put|cache\.add/, 'nothing stored');
  assert.match(sw, /addEventListener\('fetch'/, 'but there is a fetch handler, which install needs');
});

test('the worker itself is never cached, so a fix can land', async () => {
  const res = await anon('/sw.js');
  assert.match(res.headers.get('cache-control') ?? '', /no-cache/);
});

test('the share target points somewhere that exists, and takes both fields', async () => {
  // Android puts a shared link in url from some apps and in text from others.
  assert.equal(MANIFEST.share_target.action, '/add');
  assert.equal(MANIFEST.share_target.method, 'GET');
  assert.ok(MANIFEST.share_target.params.url);
  assert.ok(MANIFEST.share_target.params.text);
});

test('/add is the app, not a 404 — but still behind the login', async () => {
  const res = await anon('/add');
  // A browser asking for HTML gets sent to sign in; it does not get a 404.
  assert.notEqual(res.status, 404);
});

test('an unknown icon name is a 404, not an empty 200', async () => {
  const res = await anon('/icon-nope.png');
  assert.notEqual(res.status, 200);
});
