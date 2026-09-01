/**
 * The Hub's copy of the scrubber.
 *
 * Scrubbing happens on Phantom's machine, before a line is written to disk
 * or posted here. So why a second pass on the way out?
 *
 * Because the first one is a promise about code running somewhere else. A
 * Phantom on an old version, a line posted by hand with curl, a future ingest
 * path nobody has written yet — the Hub cannot verify any of that, and "the
 * client said it was clean" is not a property, it is a hope. The export is the
 * moment data leaves for a third party, and that is the right place to check
 * rather than to trust.
 *
 * The two copies are deliberately identical files. This suite runs the same
 * corpus as Phantom's, and additionally fails if they have drifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { scrub, looksSensitive } from '../src/scrub.ts';

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/scrub-corpus.json', import.meta.url), 'utf8'),
) as {
  dirty: { why: string; input: string; secrets?: string[]; mustNotContain: string[]; mustContain: string[] }[];
  clean: { why: string; input: string }[];
};

for (const c of corpus.dirty) {
  test(`the Hub's copy removes: ${c.why}`, () => {
    const out = scrub(c.input, c.secrets ?? []);
    for (const banned of c.mustNotContain) assert.ok(!out.includes(banned), `"${banned}" survived`);
    for (const kept of c.mustContain) assert.ok(out.includes(kept), `"${kept}" was eaten`);
    assert.deepEqual(looksSensitive(out), []);
  });
}

for (const c of corpus.clean) {
  test(`the Hub's copy leaves alone: ${c.why}`, () => {
    assert.equal(scrub(c.input), c.input);
  });
}

test('THE TWO COPIES OF THE SCRUBBER HAVE NOT DRIFTED', () => {
  // Two packages, no shared module between them, so the only thing keeping
  // these honest is this assertion. A rule tightened on one side and not the
  // other means Phantom stops sending something the Hub still expects to
  // strip, or worse, the reverse.
  const theirs = resolve(import.meta.dirname, '..', '..', 'watcher', 'src', 'scrub.ts');
  if (!existsSync(theirs)) {
    // The Hub deploys on its own. Nothing to compare against is not a failure.
    return;
  }
  assert.equal(
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'scrub.ts'), 'utf8'),
    readFileSync(theirs, 'utf8'),
    'hub/src/scrub.ts and watcher/src/scrub.ts must stay byte-identical — copy one over the other',
  );
});

test('the environment secrets are removed by value, whatever they look like', () => {
  // The case the patterns cannot catch: APP_PASSWORD might be an ordinary
  // word. Nothing about "correct-horse-battery" looks like a credential.
  const password = 'correct-horse-battery';
  const out = scrub(`login failed for ${password}`, [password]);
  assert.ok(!out.includes(password));
});
