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

import { quietInterval, quietLabel, alwaysFast, MAX_INTERVAL_S, OUT_FLOOR_TIMES } from '../src/quiet.ts';

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

  // Six minutes ago it went OUT, and out never buys the top rung — see
  // OUT_FLOOR_TIMES. This said 60 until 7 Sep 2026.
  assert.equal(at(0.1), 180, 'it went out six minutes ago: already on the ramp');
  assert.equal(at(0.9), 180, 'still inside the first hour, still not full speed');
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
  assert.equal(
    quietLabel(listing({ state: 'queue' }), NOW),
    '',
    'ordinary cadence says nothing',
  );
  // And a freshly-out listing now says something, because it is already
  // resting and a person watching the log deserves to know why.
  assert.match(quietLabel(listing(), NOW), /^resting \(every 3m/);
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
  assert.equal(Math.round(after), 132);
  assert.ok(after < before / 6, 'a sixth of the traffic, and the live one unchanged');
});

test('OUT OF STOCK DOES NOT BUY FULL SPEED, IN STOCK DOES', () => {
  // The asymmetry, stated as the one comparison that matters. Both of these
  // listings changed one minute ago. One of them sold out; the other came in.
  const justNow = { lastChangedAt: hoursAgo(1 / 60) };

  assert.equal(quietInterval(listing({ ...justNow, state: 'in' }), NOW), 60);
  assert.equal(quietInterval(listing({ ...justNow, state: 'out' }), NOW), 180);

  // What this cost, in the real case that prompted it: Target #45 flapped in
  // and out three times on 6 Sep and so spent the whole day at full speed.
  // Each hour it sat out, it now costs a third as much.
  assert.equal(3600 / quietInterval(listing({ ...justNow, state: 'out' }), NOW), 20);
  assert.equal(3600 / 60, 60);

  // The floor is a floor and not a ceiling: a shelf that has been out for a
  // week still walks all the way up to the cap.
  assert.equal(quietInterval(listing({ state: 'out', lastChangedAt: hoursAgo(24 * 10) }), NOW), MAX_INTERVAL_S);
  assert.equal(OUT_FLOOR_TIMES, 3);
});

test('A WAITING ROOM IS NOT A QUIET SHELF, AND NEITHER IS NOT KNOWING', () => {
  // Two states that reach the ramp and must NOT get the out-of-stock floor.
  //
  // 'queue' means the retailer has put up a waiting room, which is what they
  // do when something is dropping — the loudest signal there is, and the one
  // moment reading less would be indefensible.
  //
  // 'unknown' means the read failed. Not seeing is a reason to look again.
  const justNow = { lastChangedAt: hoursAgo(1 / 60) };
  assert.equal(quietInterval(listing({ ...justNow, state: 'queue' }), NOW), 60);
  assert.equal(quietInterval(listing({ ...justNow, state: 'unknown' }), NOW), 60);
});

test('A RESTING LISTING REPORTS THE INTERVAL IT EARNED, NOT THE ONE IT ASKED FOR', () => {
  // The "next in Ns" line is computed from the same interval the due check
  // uses — or it was not, for a day. Three isDue call sites moved onto
  // quietInterval and a fourth, feeding only a log line, was missed. So a
  // listing resting on thirty minutes announced itself "due in 0s" on every
  // pass, forever. Nobody acts on that number, which is precisely why it
  // survived a day of being watched.
  //
  // This is the arithmetic that line does, pinned so the two cannot drift
  // apart again.
  const m = listing({ lastChangedAt: hoursAgo(48) });
  const lastCheckedAt = NOW - 70_000; // 70s ago: past its asked-for 60s

  const asked = lastCheckedAt + m.checkEverySeconds * 1000;
  const earned = lastCheckedAt + quietInterval(m, NOW) * 1000;

  assert.ok(asked < NOW, 'by its own interval it looks overdue');
  assert.ok(earned > NOW, 'by the interval it earned it is not');
  // 48h unchanged is the x15 tier, so 60s becomes 900s: about fourteen
  // minutes still to wait, where the raw interval said it was 10s overdue.
  assert.equal(Math.round((earned - NOW) / 60_000), 14);
});

test('A PRE-ORDER IS A QUEUE, NOT A RACE', () => {
  // 11 Sep 2026. Fixing the Target reader so a pre-order reads `in` — which is
  // correct, you can put it in a basket — would have exempted every Target
  // pre-order from resting. Target lists them six weeks ahead, so that is six
  // weeks of reading a page every sixty seconds, around the clock, to confirm
  // that a thing you can order can still be ordered.
  //
  // Stock is urgent because it vanishes in minutes. An open pre-order stays
  // open, and when it closes there is nothing to be done about it in the
  // following minute.
  const stale = { lastChangedAt: hoursAgo(24 * 30) };

  assert.equal(quietInterval(listing({ ...stale, state: 'in' }), NOW), 60);
  assert.equal(
    quietInterval(listing({ ...stale, state: 'in', isPreOrder: true }), NOW),
    MAX_INTERVAL_S,
    'the same reading, minus the urgency it does not have',
  );

  // Everything that makes it urgent again still does.
  const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
  const pre = { ...stale, state: 'in', isPreOrder: true };
  assert.equal(quietInterval(listing({ ...pre, armed: true }), NOW), 60, 'money is committed');
  assert.equal(quietInterval(listing({ ...pre, checkNow: true }), NOW), 60, 'somebody pressed it');
  assert.equal(quietInterval(listing(pre), NOW, true), 60, 'a drop window is open');
  assert.equal(
    quietInterval(listing({ ...pre, releaseDate: inDays(4) }), NOW), 60,
    'release week is the whole point of having watched it',
  );

  // And staged stock is untouched: a count appearing before a drop opens is
  // the earliest warning there is, and it is not a pre-order.
  assert.equal(quietInterval(listing({ ...stale, state: 'staged' }), NOW), 60);
  assert.equal(
    quietInterval(listing({ ...stale, state: 'staged', isPreOrder: true }), NOW), 60,
  );
});
