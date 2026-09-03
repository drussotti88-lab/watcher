/**
 * Asking for less when there is nothing to see.
 *
 * The number that made this necessary: 3,194 page reads in twenty-four hours
 * from one house — thirteen Target listings and two Walmart ones at sixty
 * seconds each, around the clock — after which both retailers began putting a
 * press-and-hold in front of the household's ORDINARY browsing. Nothing was
 * wrong with any single read. There were simply far more of them than could
 * possibly tell us anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quietInterval, quietLabel, alwaysFast, MAX_INTERVAL_S } from '../src/quiet.ts';

const NOW = Date.parse('2026-09-03T22:00:00.000Z');
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

const listing = (over: Record<string, unknown> = {}) => ({
  checkEverySeconds: 60,
  state: 'out',
  lastChangedAt: hoursAgo(0.1),
  ...over,
});

test('A SHELF THAT IS NOT MOVING IS READ LESS OFTEN, IN STEPS', () => {
  const at = (h: number) => quietInterval(listing({ lastChangedAt: hoursAgo(h) }), NOW);

  assert.equal(at(0.1), 60, 'it moved six minutes ago — read it as asked');
  assert.equal(at(0.9), 60, 'still inside the first hour');
  assert.equal(at(2), 180, 'quiet for two hours: every three minutes');
  assert.equal(at(8), 480, 'quiet since this morning: every eight');
  assert.equal(at(30), 900, 'quiet for a day: every fifteen');
  assert.equal(at(24 * 10), MAX_INTERVAL_S, 'quiet for a week and a half: the ceiling');

  // The ceiling binds regardless of what the mission asked for, so a mission
  // set to ten minutes cannot become a five-hour one.
  assert.equal(
    quietInterval(listing({ checkEverySeconds: 600, lastChangedAt: hoursAgo(24 * 10) }), NOW),
    MAX_INTERVAL_S,
  );
});

test('NOTHING RESTS WHEN IT MIGHT MATTER', () => {
  const stale = { lastChangedAt: hoursAgo(24 * 30) };

  // In stock is the thing the whole system exists for.
  assert.equal(quietInterval(listing({ ...stale, state: 'in' }), NOW), 60);
  assert.equal(quietInterval(listing({ ...stale, state: 'in_stock' }), NOW), 60);
  // Stock sitting in a store before the site admits it — the earliest signal.
  assert.equal(quietInterval(listing({ ...stale, state: 'staged' }), NOW), 60);
  // Money is committed to this one.
  assert.equal(quietInterval(listing({ ...stale, armed: true }), NOW), 60);
  // Somebody is watching the screen.
  assert.equal(quietInterval(listing({ ...stale, checkNow: true }), NOW), 60);
  // A drop window is open: the whole point of one is that everything is live.
  assert.equal(quietInterval(listing(stale), NOW, true), 60);

  // A street date inside the week, where a stock load appears — and the day
  // after, because a release does not stop mattering at midnight.
  const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
  assert.equal(quietInterval(listing({ ...stale, releaseDate: inDays(5) }), NOW), 60);
  assert.equal(quietInterval(listing({ ...stale, releaseDate: inDays(-0.5) }), NOW), 60);
  assert.equal(quietInterval(listing({ ...stale, releaseDate: inDays(30) }), NOW), MAX_INTERVAL_S,
    'a release next month is not a reason to hammer it now');
  assert.equal(quietInterval(listing({ ...stale, releaseDate: 'not a date' }), NOW), MAX_INTERVAL_S);
});

test('a listing with no history is treated as busy, not as quiet', () => {
  // Added a minute ago, never seen to change. We have no evidence it is
  // sitting still, and starting it on a half-hour cadence would make a new
  // mission look broken to the person who just made it.
  assert.equal(quietInterval(listing({ lastChangedAt: undefined }), NOW), 60);
  assert.equal(quietInterval(listing({ lastChangedAt: '' }), NOW), 60);
  assert.equal(quietInterval(listing({ lastChangedAt: 'nonsense' }), NOW), 60);
});

test('alwaysFast is the whole exemption list, and says so', () => {
  assert.equal(alwaysFast({ checkEverySeconds: 60, state: 'out' }, NOW), false);
  assert.equal(alwaysFast({ checkEverySeconds: 60, state: 'in' }, NOW), true);
  assert.equal(alwaysFast({ checkEverySeconds: 60, armed: true }, NOW), true);
  assert.equal(alwaysFast({ checkEverySeconds: 60, checkNow: true }, NOW), true);
});

test('the log says why a listing is being read rarely', () => {
  assert.equal(quietLabel(listing(), NOW), '', 'ordinary cadence says nothing');
  const label = quietLabel(listing({ lastChangedAt: hoursAgo(30) }), NOW);
  assert.match(label, /resting \(every 15m — unchanged for 30h\)/);
});

test('WHAT IT WOULD HAVE SAVED ON 3 SEP', () => {
  // The real shape of that day: fifteen listings at sixty seconds, all but two
  // of them unchanged for well over a day. Read counts per hour, before and
  // after, with the fast ones still fast.
  const missions = [
    ...Array.from({ length: 13 }, () => listing({ lastChangedAt: hoursAgo(48) })),
    listing({ state: 'in', lastChangedAt: hoursAgo(2) }),
    listing({ lastChangedAt: hoursAgo(0.2) }),
  ];
  const before = missions.reduce((n, m) => n + 3600 / m.checkEverySeconds, 0);
  const after = missions.reduce((n, m) => n + 3600 / quietInterval(m, NOW), 0);

  assert.equal(Math.round(before), 900, 'fifteen listings a minute apart');
  assert.equal(Math.round(after), 172);
  assert.ok(after < before / 5, 'a fifth of the traffic, and the live ones unchanged');
});
