/**
 * The guard on everything that leaves this machine.
 *
 * Written before anything could emit a line, and deliberately adversarial: the
 * corpus is not "here is a token, is it gone" but the actual shapes this system
 * produces — a Target URL with a visitor id in it, a Windows ENOENT with the
 * account name in the path, a 401 that quotes the bearer token back.
 *
 * The `clean` half matters just as much. A scrubber that redacts everything is
 * trivially safe and completely useless; those cases are the ones that would
 * make the log worth reading, and they have to come through untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scrub, looksSensitive } from '../src/scrub.ts';

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/scrub-corpus.json', import.meta.url), 'utf8'),
) as {
  dirty: { why: string; input: string; secrets?: string[]; mustNotContain: string[]; mustContain: string[] }[];
  clean: { why: string; input: string }[];
};

for (const c of corpus.dirty) {
  test(`scrub removes: ${c.why}`, () => {
    const out = scrub(c.input, c.secrets ?? []);
    for (const banned of c.mustNotContain) {
      assert.ok(
        !out.includes(banned),
        `"${banned}" survived scrubbing.\n  in:  ${c.input}\n  out: ${out}`,
      );
    }
    for (const kept of c.mustContain) {
      assert.ok(
        out.includes(kept),
        `"${kept}" was worth keeping and got eaten.\n  in:  ${c.input}\n  out: ${out}`,
      );
    }
  });
}

for (const c of corpus.clean) {
  test(`scrub leaves alone: ${c.why}`, () => {
    assert.equal(
      scrub(c.input),
      c.input,
      'a line with nothing sensitive in it must come through unchanged',
    );
  });
}

test('every scrubbed line passes an independent sensitivity check', () => {
  // Not the same question as "did scrub run". looksSensitive is written from
  // the reader's side — it asks whether anything in the output still looks
  // like it should not be there — so it can catch a rule that fired but left
  // the tail behind.
  for (const c of corpus.dirty) {
    const out = scrub(c.input, c.secrets ?? []);
    assert.deepEqual(
      looksSensitive(out),
      [],
      `still looks sensitive after scrubbing: ${out}`,
    );
  }
});

test('scrubbing twice changes nothing the second time', () => {
  // The Hub scrubs again on the way out. If that pass were not idempotent it
  // would slowly chew through its own redaction markers.
  for (const c of [...corpus.dirty, ...corpus.clean]) {
    const once = scrub(c.input, (c as { secrets?: string[] }).secrets ?? []);
    assert.equal(scrub(once), once, `not idempotent: ${c.input}`);
  }
});

test('a short secret is ignored rather than shredding the line', () => {
  // Someone sets a two-character token; redacting every "ab" in the file makes
  // it unreadable and hides real problems behind noise.
  assert.equal(scrub('a stable line about a tab', ['ab']), 'a stable line about a tab');
});

test('empty and non-string input do not throw', () => {
  assert.equal(scrub(''), '');
  assert.equal(scrub(undefined as unknown as string), '');
});

test('a token is removed even when it is the whole message', () => {
  const token = 'hub_9f2c8a1b7d4e6f3a2b5c8d9e';
  assert.ok(!scrub(token, [token]).includes(token));
});

// ── Nothing pretends to be something it is not ───────────────────────────────

test('NO ANTI-DETECTION FLAGS IN THE BROWSER LAUNCH', () => {
  // --disable-blink-features=AutomationControlled sat in the launch args from
  // the beginning. Its only function is to stop Chrome setting
  // navigator.webdriver — which is to say its only function is to make this
  // browser harder to recognise as automated. That is the one thing this
  // project said it would not do.
  //
  // Pinned as a test rather than a deleted line, because the reason it lasted
  // so long is that nobody was looking, and the day it stops working is the
  // day somebody is tempted to put it back.
  const src = readFileSync(new URL('../src/browser.ts', import.meta.url), 'utf8');
  const args = /args: \[([\s\S]*?)\n      \]/.exec(src)?.[1] ?? '';
  assert.ok(args, 'the launch args should be findable');

  const live = args
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  for (const banned of [
    'AutomationControlled',
    'disable-blink-features',
    '--disable-web-security',
    '--user-agent',
  ]) {
    assert.ok(!live.includes(banned), `${banned} is not ours to use`);
  }
});

// ── Extensions: on for the buy profile, off for the watch profile ────────────

test('THE BUY PROFILE RUNS EXTENSIONS AND THE WATCH PROFILE DOES NOT', () => {
  // Playwright passes --disable-extensions by default. The buy profile is the
  // one a person signs into and keeps a password manager in, so it drops that
  // flag; the watch profile, signed out at three retailers all day, keeps it.
  const src = readFileSync(resolve(import.meta.dirname, '../src/browser.ts'), 'utf8');
  assert.match(src, /this\.persona === 'buy' \? \{ ignoreDefaultArgs: \['--disable-extensions'\] \}/);
  // And nothing here reads, lists or judges what is installed.
  assert.doesNotMatch(src, /Extensions\/|manifest\.json|installedExtensions/);
});
