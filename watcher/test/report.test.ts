/**
 * What a report says, and what it must never say.
 *
 * The report exists so a tester can ask for help without doing the diagnosis
 * first. It travels to somebody else's machine, so the interesting tests here
 * are the ones about what stays behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildReport, redactConfig, summarise, tail, TAIL_LINES } from '../src/report.ts';

const TOKEN = 'Vg7xK2pQnR4sT9wZ0aB3cD6eF1gH5jL8mN2pQ4rS7tU';

function machine(over: { config?: string; console?: string; running?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  mkdirSync(join(dir, 'logs'));
  mkdirSync(join(dir, 'logs', 'queue'));
  mkdirSync(join(dir, 'logs', 'queue', 'walmart_2026-09-03_22-25-13'));
  writeFileSync(
    join(dir, 'watcher.config.json'),
    over.config ??
      JSON.stringify({ hub: { url: 'https://hub.example', token: TOKEN }, live: false, intervalSec: 90 }),
  );
  writeFileSync(join(dir, 'logs', 'console-run.log'), over.console ?? 'a quiet afternoon\n');
  if (over.running !== false) writeFileSync(join(dir, 'logs', '.running'), '1234');
  return dir;
}

test('THE TOKEN NEVER TRAVELS, IN THE CONFIG OR ANYWHERE ELSE IN THE REPORT', () => {
  // The one secret this process certainly holds. It is named to the scrubber
  // rather than left to the general patterns, because a log line that quotes
  // an Authorization header back is exactly the shape that gets missed.
  const dir = machine({
    console: `starting up\nGET /api/missions → 401 with Bearer ${TOKEN}\ndone\n`,
  });
  const r = buildReport({ dir, version: '1fd5043' });

  assert.equal(JSON.stringify(r).includes(TOKEN), false, 'not one occurrence, anywhere');
  // The scrubber blanks a "token" value on sight, before this file gets an
  // opinion — which is why the length lives in `shape` and not in the config.
  assert.match(r.config, /"token": .*redacted/, 'blanked by the scrubber itself');
  assert.match(r.shape, /43 characters long/, 'and how long — which is what tells a wrong one apart');
  assert.match(r.config, /hub\.example/, 'the address is not a secret and is the usual fault');
});

test('what it gathers is what somebody debugging would ask for', () => {
  const dir = machine({ console: 'line one\nline two\n' });
  const r = buildReport({ dir, version: '1fd5043', note: 'chrome never opens', platform: 'win32 x64', nodeVersion: 'v22.9.0' });

  assert.equal(r.version, '1fd5043');
  assert.equal(r.note, 'chrome never opens');
  assert.equal(r.running, true);
  assert.match(r.console, /line two/);
  assert.ok(r.files.some((f) => f.startsWith('console-run.log')), 'the log folder, by name and size');
  assert.equal(r.captures.length, 1);
  assert.match(r.captures[0]!, /walmart_2026-09-03/);
  // Named, never sent: a capture is the logged-in DOM of a retail page.
  assert.equal(JSON.stringify(r).includes('<html'), false);
});

test('THE OBVIOUS FAULTS ARE NAMED IN ONE SENTENCE, BEFORE ANYONE OPENS THE DUMP', () => {
  const seen = (console_: string, extra: Parameters<typeof machine>[0] = {}) =>
    summarise(buildReport({ dir: machine({ console: console_, ...extra }), version: '1fd5043', platform: 'win32 x64', nodeVersion: 'v22.9.0' }));

  assert.match(seen('Unknown file extension ".ts"'), /Node is too old/);
  assert.match(seen('the Hub did not recognise the token'), /refused its token/);
  assert.match(seen('Could not reach https://hub.example'), /could not reach the Hub/);
  assert.match(seen('Walmart served a challenge\nTarget served a challenge\n'), /2 bot checks/);
  assert.match(seen('fine', { running: false }), /NOT running/);
  assert.match(seen('fine'), /Phantom 1fd5043 on win32 x64, Node v22\.9\.0/);
});

test('a machine where setup never finished still produces a report', () => {
  // The case this matters most for: nothing works, so nothing must be needed.
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  const r = buildReport({ dir, version: 'unknown' });
  assert.match(r.config, /setup never finished/);
  assert.match(r.console, /no .*console-run\.log/);
  assert.equal(r.running, false);
  assert.deepEqual(r.files, []);
  assert.match(summarise(r), /Setup never finished/);
});

test('a config with no token says so in one line', () => {
  const dir = machine({ config: JSON.stringify({ hub: { url: 'https://hub.example', token: '' } }) });
  assert.match(summarise(buildReport({ dir, version: 'x' })), /no token in the config/);
});

test('a corrupt config is called out rather than parsed', () => {
  assert.match(redactConfig('{ not json'), /not valid JSON/);
  assert.match(summarise(buildReport({ dir: machine({ config: '{ oops' }), version: 'x' })), /corrupt/);
});

test('the tail is a tail, and a missing file is a sentence', () => {
  const dir = machine({ console: Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n') });
  const t = tail(join(dir, 'logs', 'console-run.log'));
  assert.equal(t.split('\n').length, TAIL_LINES);
  assert.match(t, /line 899/);
  assert.equal(t.includes('line 400\n'), false, 'the beginning is dropped, not the end');
  assert.match(tail(join(dir, 'nope.log')), /^\(no /);
});
