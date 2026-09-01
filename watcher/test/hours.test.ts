/**
 * When Phantom is allowed to look.
 *
 * The two things worth getting right: a window that crosses midnight — which
 * is the shape of every window anyone would actually set here — and the fact
 * that quiet hours must never swallow something you asked for by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAwake, localMinutes, overrides } from '../src/hours.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/hub.ts';

const window = (from: string, until: string, timezone = 'UTC'): Settings => ({
  ...DEFAULT_SETTINGS,
  activeFrom: from,
  activeUntil: until,
  timezone,
});

const at = (iso: string): Date => new Date(iso);

test('no window means always awake, which is the old behaviour', () => {
  const always = isAwake(DEFAULT_SETTINGS, at('2026-09-16T14:00:00Z'));
  assert.equal(always.awake, true);
  assert.equal(always.opensInMs, null);
});

test('a window that does not cross midnight behaves obviously', () => {
  const s = window('09:00', '17:00');
  assert.equal(isAwake(s, at('2026-09-16T12:00:00Z')).awake, true);
  assert.equal(isAwake(s, at('2026-09-16T08:59:00Z')).awake, false);
  assert.equal(isAwake(s, at('2026-09-16T17:00:00Z')).awake, false, 'the end is exclusive');
});

test('A WINDOW THAT CROSSES MIDNIGHT IS ONE WINDOW, NOT TWO', () => {
  // The case a naive `from <= now && now < until` gets exactly backwards, and
  // the shape of every window anyone would set for a 3am drop.
  const s = window('22:00', '06:00');
  assert.equal(isAwake(s, at('2026-09-16T23:30:00Z')).awake, true, 'before midnight');
  assert.equal(isAwake(s, at('2026-09-17T03:00:00Z')).awake, true, 'after midnight');
  assert.equal(isAwake(s, at('2026-09-17T12:00:00Z')).awake, false, 'the middle of the day');
});

test('THE WINDOW IS READ IN ITS OWN TIMEZONE', () => {
  // 3am Central is 08:00 or 09:00 UTC depending on the season. Getting this
  // wrong means sleeping through the drop for half the year, which is the kind
  // of bug that only shows up in November.
  const central = window('03:00', '05:00', 'America/Chicago');

  // 2026-09-16 is daylight time: CDT is UTC-5, so 03:30 CDT is 08:30 UTC.
  assert.equal(isAwake(central, at('2026-09-16T08:30:00Z')).awake, true);
  // 2026-12-16 is standard time: CST is UTC-6, so 03:30 CST is 09:30 UTC.
  assert.equal(isAwake(central, at('2026-12-16T09:30:00Z')).awake, true);
  // And the same wall-clock UTC instant is outside the window in December.
  assert.equal(isAwake(central, at('2026-12-16T08:30:00Z')).awake, false);
});

test('being asleep says when it wakes, in words and in milliseconds', () => {
  const s = window('03:00', '05:00');
  const verdict = isAwake(s, at('2026-09-16T00:00:00Z'));
  assert.equal(verdict.awake, false);
  assert.match(verdict.reason, /opens in 3h/);
  assert.equal(verdict.opensInMs, 180 * 60_000);
});

test('the wait is never zero, so a sleeping loop cannot spin', () => {
  const s = window('03:00', '05:00');
  // One minute before the window opens.
  const verdict = isAwake(s, at('2026-09-16T02:59:30Z'));
  assert.ok((verdict.opensInMs ?? 0) > 0);
});

test('paused stops everything and does not pretend to wake up later', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, paused: true };
  const verdict = isAwake(s, at('2026-09-16T03:00:00Z'));
  assert.equal(verdict.awake, false);
  assert.match(verdict.reason, /master switch/);
  assert.equal(verdict.opensInMs, null, 'nothing reopens a master switch but a person');
});

test('paused beats an open window', () => {
  const s: Settings = { ...window('00:00', '23:59'), paused: true };
  assert.equal(isAwake(s, at('2026-09-16T12:00:00Z')).awake, false);
});

test('a half-configured or nonsense window is treated as no window', () => {
  // Failing open on watching, as everywhere else. A malformed setting must not
  // silently switch the system off.
  assert.equal(isAwake({ ...DEFAULT_SETTINGS, activeFrom: '03:00' }, at('2026-09-16T12:00:00Z')).awake, true);
  assert.equal(isAwake(window('nonsense', '05:00'), at('2026-09-16T12:00:00Z')).awake, true);
  assert.equal(isAwake(window('03:00', '03:00'), at('2026-09-16T12:00:00Z')).awake, true);
});

test('midnight reads as 00:00, not 24:00', () => {
  // Some locales render midnight as hour 24, which would sort after every
  // window and mean it never opened.
  assert.equal(localMinutes(at('2026-09-16T00:10:00Z'), 'UTC'), 10);
});

// ── The overrides ────────────────────────────────────────────────────────────

test('A CHECK ASKED FOR BY HAND IS NEVER SWALLOWED BY QUIET HOURS', () => {
  // The button would otherwise be a liar: it says Phantom will look, and
  // at two in the afternoon it silently would not.
  assert.equal(overrides([{ checkNow: true }], '2026-09-16'), 'a check was asked for by hand');
});

test('a release day wakes it up', () => {
  // The one moment we know the page will change is the date Target published.
  assert.equal(
    overrides([{ releaseDate: '2026-09-16' }], '2026-09-16'),
    'something releases today',
  );
});

test('a release date that is not today is not a reason to wake', () => {
  assert.equal(overrides([{ releaseDate: '2026-09-16' }], '2026-09-15'), '');
  assert.equal(overrides([{ releaseDate: null }, {}], '2026-09-16'), '');
  assert.equal(overrides([], '2026-09-16'), '');
});

test('a full timestamp in the release date still matches the day', () => {
  assert.equal(
    overrides([{ releaseDate: '2026-09-16T00:00:00.000Z' }], '2026-09-16'),
    'something releases today',
  );
});
