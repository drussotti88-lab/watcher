/**
 * Drops that happen on a clock.
 *
 * Every test here is written against the one drop we have actually measured:
 * Walmart, Wednesdays, 20:00 America/Chicago. The 2 Sep 2026 event opened at
 * 20:00:00, produced its first alert at 20:00:34, and was over by 20:43.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_DROPS,
  LEAD_MINUTES,
  TAIL_MINUTES,
  WARN_MINUTES,
  minutesUntil,
  upcomingDrop,
  zonedWeekMinutes,
} from '../src/schedule.ts';

const WALMART = KNOWN_DROPS[0]!;

/** 2 Sep 2026 was a Wednesday. 20:00 CDT is 01:00 UTC on the 3rd. */
const at = (utc: string): Date => new Date(utc);

test('the schedule says what we measured', () => {
  assert.equal(WALMART.retailer, 'Walmart');
  assert.equal(WALMART.at, '20:00');
  assert.equal(WALMART.weekday, 3);
  assert.equal(WALMART.timezone, 'America/Chicago');
});

test('20:00 Chicago on a Wednesday is the moment itself', () => {
  assert.equal(minutesUntil(WALMART, at('2026-09-03T01:00:00Z')), 0);
});

test('DAYLIGHT SAVING DOES NOT MOVE THE DROP', () => {
  // 8pm Chicago is 01:00 UTC in summer and 02:00 UTC in winter. A schedule
  // built on a fixed offset would be an hour wrong on exactly the two nights
  // nobody expected it to be.
  assert.equal(minutesUntil(WALMART, at('2026-09-03T01:00:00Z')), 0); // CDT
  assert.equal(minutesUntil(WALMART, at('2026-12-10T02:00:00Z')), 0); // CST
});

test('an hour before is an hour before', () => {
  assert.equal(minutesUntil(WALMART, at('2026-09-03T00:00:00Z')), 60);
});

test('THE WINDOW OPENS BEFORE THE HOUR AND SHUTS BY ITSELF', () => {
  const running = (utc: string): boolean =>
    upcomingDrop(at(utc), LEAD_MINUTES)?.running === true;

  assert.equal(running('2026-09-03T00:50:00Z'), false, '10m before: not yet');
  assert.equal(running('2026-09-03T00:56:00Z'), true, '4m before: open');
  assert.equal(running('2026-09-03T01:00:00Z'), true, 'on the hour');
  assert.equal(running('2026-09-03T01:34:00Z'), true, '34m in — the drop was still live');
  assert.equal(running('2026-09-03T01:44:00Z'), true, '44m in, just inside the tail');
  assert.equal(running('2026-09-03T01:50:00Z'), false, '50m in: shut, and shut itself');
  assert.equal(running('2026-09-04T01:00:00Z'), false, 'Thursday is not Wednesday');
});

test('the tail covers the drop we actually measured', () => {
  // In stock at 20:00, gone by 20:43. A tail shorter than that would stop
  // pacing while the thing was still buyable.
  assert.ok(TAIL_MINUTES >= 43);
});

test('the warning looks further ahead than the pacing does', () => {
  // Ninety minutes is time to notice a switch and fix it; five is not.
  assert.ok(WARN_MINUTES > LEAD_MINUTES);
  const soon = upcomingDrop(at('2026-09-03T00:00:00Z'), WARN_MINUTES);
  assert.equal(soon?.minutesUntil, 60);
  assert.equal(soon?.running, false, 'an hour out is worth warning about, not bursting for');
  assert.equal(upcomingDrop(at('2026-09-03T00:00:00Z'), LEAD_MINUTES), null);
});

test('a quiet Monday has nothing to say', () => {
  assert.equal(upcomingDrop(at('2026-08-31T15:00:00Z'), WARN_MINUTES), null);
});

test('the week wraps rather than going negative', () => {
  // Thursday morning is six-and-a-bit days from the next Wednesday, not minus
  // half a day. Callers should never have to think about a sign.
  const m = minutesUntil(WALMART, at('2026-09-03T13:00:00Z'));
  assert.ok(m !== null && m > 0 && m < 7 * 24 * 60);
});

test('zonedWeekMinutes reads the zone, not the machine', () => {
  // 01:00 UTC Thursday is still Wednesday evening in Chicago.
  const chicago = zonedWeekMinutes(at('2026-09-03T01:00:00Z'), 'America/Chicago');
  assert.equal(chicago, 3 * 1440 + 20 * 60, 'Wednesday 20:00');
  const utc = zonedWeekMinutes(at('2026-09-03T01:00:00Z'), 'UTC');
  assert.equal(utc, 4 * 1440 + 60, 'Thursday 01:00');
});
