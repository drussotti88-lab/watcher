/**
 * The blocking list is resource TYPES, and only ever resource types.
 *
 * This is the same kind of test as the one in scrub.test.ts that pins
 * `--disable-blink-features=AutomationControlled` as removed: it exists to
 * make a principle expensive to break by accident.
 *
 * Refusing to download images is asking the retailer for LESS. Refusing to run
 * a named vendor's bot check is defeating a security control. Both are one
 * call to `route.abort()`, and the only thing separating them is what goes in
 * the list — so the list is what gets guarded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BLOCKED_TYPES, shouldBlock } from '../src/lighten.ts';

/** Playwright's own vocabulary. Anything outside it is not a resource type. */
const PLAYWRIGHT_RESOURCE_TYPES = [
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack',
  'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other',
];

test('THE LIST HOLDS RESOURCE TYPES AND NOTHING ELSE', () => {
  for (const entry of BLOCKED_TYPES) {
    assert.ok(
      PLAYWRIGHT_RESOURCE_TYPES.includes(entry),
      `"${entry}" is not a resource type. If it is a hostname, a script name or ` +
        `a vendor, it does not belong here: blocking by WHO is being asked is ` +
        `defeating a control, not asking for less.`,
    );
  }
});

test('what a reading needs is never blocked', () => {
  // Target's price is not in the HTML — their own flag says so — it arrives
  // from their API, fetched by their own script. Block either and there is no
  // reading at all, at which point the saving is total and so is the loss.
  for (const needed of ['document', 'script', 'xhr', 'fetch', 'websocket']) {
    assert.equal(shouldBlock(needed), false, `${needed} is load-bearing`);
  }
});

test('the heavy types a reader has never consulted are blocked', () => {
  for (const heavy of ['image', 'media', 'font', 'stylesheet']) {
    assert.equal(shouldBlock(heavy), true);
  }
  assert.equal(shouldBlock(''), false);
  assert.equal(shouldBlock('IMAGE'), false, 'exact match only — no case games');
});

test('NO HOSTNAME, VENDOR OR SCRIPT NAME APPEARS IN THE MODULE', () => {
  // Belt as well as braces. The list is checked above; this checks that the
  // file has not grown a second, sneakier path — a URL match, a regex on a
  // vendor's name — beside it.
  const src = readFileSync(resolve(import.meta.dirname, '../src/lighten.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  for (const vendor of [
    'perimeterx', 'px-cloud', 'akamai', 'imperva', 'datadome', 'incapsula',
    'recaptcha', 'hcaptcha', 'cloudflare', 'fingerprint',
  ]) {
    assert.equal(
      code.toLowerCase().includes(vendor),
      false,
      `"${vendor}" appears in lighten.ts — that is blocking by who, not by what`,
    );
  }

  // No URL matching at all: the router's predicate takes a resource type.
  assert.equal(/https?:\/\//.test(code), false, 'no URLs in the blocking path');
});
