/**
 * Writing down a page we could not read.
 *
 * The artifact these produce is the thing every piece of queue work has been
 * blocked on, and it exists only while a drop is running — so the failure mode
 * that matters is not "the capture is wrong", it is "the capture did not
 * happen, and the window has closed".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { captureName, captureOddPage, worthCapturing } from '../src/capture.ts';

test('a challenge is always worth writing down', () => {
  assert.equal(worthCapturing(true, 'Walmart', ''), true);
  assert.equal(worthCapturing(true, 'Target', 'anything'), true);
});

test('A WALMART PAGE WITH NO PRODUCT NODE IS WORTH WRITING DOWN', () => {
  // This exact note is what a waiting room looked like before the detector
  // knew Walmart's words: the parser blaming itself for a page that was never
  // a product page. If the detector misses again tonight, this is the net.
  assert.equal(
    worthCapturing(false, 'Walmart', 'no product node for usItemId 5689122334 in __NEXT_DATA__'),
    true,
  );
});

test('ordinary failures are not captured — the folder has to stay useful', () => {
  // "Capture everything" fills the disk with timeouts and makes the one
  // capture that matters impossible to find.
  assert.equal(worthCapturing(false, 'Walmart', 'could not read the page: timeout'), false);
  assert.equal(worthCapturing(false, 'Target', 'no product node in the response'), false);
  assert.equal(worthCapturing(false, 'Pokemon Center', 'no offers in the JSON-LD'), false);
});

test('the folder name sorts by time and survives a filesystem', () => {
  const n = captureName('Pokemon Center', new Date('2026-09-02T21:04:05.678Z'));
  assert.equal(n, 'pokemon-center_2026-09-02_21-04-05');
  assert.ok(!/[:.]/.test(n));
});

test('TEXT AND MARKUP BOTH LAND, AND A DEAD SCREENSHOT LOSES NEITHER', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cap-'));
  // CAPTURE_DIR resolves against the cwd at import time, so the module is
  // re-imported below with the cwd moved. Restored at the end: a leaked chdir
  // would send another test's temp files somewhere surprising.
  const wasIn = process.cwd();
  process.chdir(dir);
  const { captureOddPage: fresh } = await import(`../src/capture.ts?t=${Date.now()}`);
  const out = await fresh({
    retailer: 'Walmart',
    url: 'https://www.walmart.com/ip/1234',
    title: 'Walmart.com',
    text: "You're in line",
    html: '<html><body>queue</body></html>',
    reason: 'Walmart waiting room',
    // The likeliest thing to fail: the page went away mid-capture. The markup
    // was already written and must not be lost with it.
    screenshot: () => Promise.reject(new Error('page closed')),
  });
  assert.notEqual(out, '');
  const files = readdirSync(out).sort();
  assert.deepEqual(files, ['meta.json', 'page.html', 'text.txt']);
  assert.equal(readFileSync(resolve(out, 'text.txt'), 'utf8'), "You're in line");
  const meta = JSON.parse(readFileSync(resolve(out, 'meta.json'), 'utf8'));
  assert.equal(meta.reason, 'Walmart waiting room');
  assert.equal(meta.url, 'https://www.walmart.com/ip/1234');
  process.chdir(wasIn);
});

test('a capture that cannot be written never throws into the pass', async () => {
  // A crashed capture would trade a missing artifact for a missing check.
  const out = await captureOddPage({
    retailer: '\0bad',
    url: '',
    title: '',
    text: '',
    html: '',
    reason: '',
  });
  assert.equal(typeof out, 'string');
});
