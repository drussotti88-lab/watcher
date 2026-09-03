/**
 * What would stop the next drop working.
 *
 * Written against the failure it exists for. On 2 Sep 2026 Walmart was
 * switched off in Settings, every pass since 4:18pm said so in the run log,
 * and nobody noticed until the drop was an hour away. Nothing was broken. A
 * toggle was off and the only evidence was seventy identical log lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { asleepAtDrop, dropReadiness } from '../src/readiness.ts';

/** Wednesday 2 Sep 2026, 19:00 America/Chicago — an hour before the drop. */
const HOUR_BEFORE = new Date('2026-09-03T00:00:00Z');
/** 20:20 Chicago: twenty minutes into it. */
const DURING = new Date('2026-09-03T01:20:00Z');
/** A quiet Monday afternoon. */
const QUIET = new Date('2026-08-31T15:00:00Z');

const ok = {
  now: HOUR_BEFORE,
  settings: {
    pausedRetailers: [],
    paused: false,
    burstSpacingSeconds: 5,
    activeFrom: '',
    activeUntil: '',
    timezone: 'America/Chicago',
  },
  agentSeenAt: new Date(HOUR_BEFORE.getTime() - 30_000).toISOString(),
  missions: [{ retailer: 'Walmart', enabled: true }],
};

test('nothing to say when no drop is near', () => {
  assert.equal(dropReadiness({ ...ok, now: QUIET }), null);
});

test('an hour before a clean setup, it says ready and nothing else', () => {
  const r = dropReadiness(ok);
  assert.equal(r?.retailer, 'Walmart');
  assert.equal(r?.minutesUntil, 60);
  assert.equal(r?.running, false);
  assert.deepEqual(r?.blockers, []);
});

test('THE SWITCH THAT COST US THE 2 SEP DROP IS CAUGHT AN HOUR EARLY', () => {
  const r = dropReadiness({
    ...ok,
    settings: { ...ok.settings, pausedRetailers: ['Walmart', 'Pokemon Center'] },
  });
  assert.equal(r?.blockers.length, 1);
  assert.match(r!.blockers[0]!.what, /Walmart is switched off/);
  // The fix travels with the finding, or the warning has spent your attention
  // without saving you anything.
  assert.match(r!.blockers[0]!.fix, /Which shops/);
});

test('a silent Phantom is a blocker, and says how long', () => {
  const r = dropReadiness({
    ...ok,
    agentSeenAt: new Date(HOUR_BEFORE.getTime() - 45 * 60_000).toISOString(),
  });
  assert.ok(r!.blockers.some((b) => /silent for 45 minutes/.test(b.what)));
});

test('a Phantom that has never reported is a different sentence', () => {
  const r = dropReadiness({ ...ok, agentSeenAt: null });
  assert.ok(r!.blockers.some((b) => /never reported/.test(b.what)));
});

test('a shop with no live mission is watching nothing', () => {
  const none = dropReadiness({ ...ok, missions: [] });
  assert.ok(none!.blockers.some((b) => /No live mission at Walmart/.test(b.what)));
  // A paused mission is not a live one.
  const paused = dropReadiness({ ...ok, missions: [{ retailer: 'Walmart', enabled: false }] });
  assert.ok(paused!.blockers.some((b) => /No live mission/.test(b.what)));
  // Missions at other shops do not count for this one.
  const other = dropReadiness({ ...ok, missions: [{ retailer: 'Target', enabled: true }] });
  assert.ok(other!.blockers.some((b) => /No live mission/.test(b.what)));
});

test('a scheduled window with no burst spacing cannot speed anything up', () => {
  const r = dropReadiness({ ...ok, settings: { ...ok.settings, burstSpacingSeconds: 0 } });
  assert.ok(r!.blockers.some((b) => /spacing is unset/.test(b.what)));
});

test('QUIET HOURS SET FOR TARGET WOULD SLEEP THROUGH WALMART', () => {
  // The subtlest one. 02:00-06:00 is a sensible window for Target's small-hours
  // drops and it silently swallows an 8pm Wednesday.
  const r = dropReadiness({
    ...ok,
    settings: { ...ok.settings, activeFrom: '02:00', activeUntil: '06:00' },
  });
  assert.ok(r!.blockers.some((b) => /asleep at 20:00/.test(b.what)));
});

test('a window that covers the drop is not a blocker', () => {
  const r = dropReadiness({
    ...ok,
    settings: { ...ok.settings, activeFrom: '18:00', activeUntil: '23:00' },
  });
  assert.deepEqual(r?.blockers, []);
});

test('a window crossing midnight is one window, not two', () => {
  assert.equal(asleepAtDrop('22:00', '06:00', '20:00'), true);
  assert.equal(asleepAtDrop('19:00', '02:00', '20:00'), false);
  // Equal values mean no restriction, matching the watcher.
  assert.equal(asleepAtDrop('00:00', '00:00', '20:00'), false);
  assert.equal(asleepAtDrop('', '', '20:00'), false);
});

test('during the drop it counts up, not down', () => {
  // A weekly clock has no negatives: twenty minutes after Wednesday's drop is
  // also nearly a week before next Wednesday's. minutesSince is what tells the
  // page which sentence to write.
  const r = dropReadiness({ ...ok, now: DURING });
  assert.equal(r?.running, true);
  assert.equal(r?.minutesSince, 20);
  assert.ok(r!.minutesUntil > 10_000, 'still counting down to next week');
});

test('several switches off are several blockers', () => {
  const r = dropReadiness({
    ...ok,
    settings: { ...ok.settings, pausedRetailers: ['Walmart'], paused: true, burstSpacingSeconds: 0 },
    missions: [],
    agentSeenAt: null,
  });
  assert.equal(r!.blockers.length, 5);
});
