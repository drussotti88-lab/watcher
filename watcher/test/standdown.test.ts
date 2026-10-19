/**
 * Walls, remembered.
 *
 * From 29 Sep 2026 Target walled the watch profile and did not stop: not one
 * reading after 2 Oct, and about 5,800 refused reads in the week to 19 Oct.
 * The stand-down doubled, then a restart put it back to twenty minutes; the
 * sweep was due forever, so it was re-planned every time it ran dry. These
 * tests hold the rules that stop both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Pacer, DEFAULT_PACING, WALLED_AFTER, pacingFor, LISTING_REST_MS, type Pacing,
} from '../src/rate.ts';
import {
  loadMemory, saveMemory, mayPlanSweep, nextSweepAllowedAt, SWEEP_RETRY_MS, STANDDOWN_FILE,
  type MemoryDeps,
} from '../src/standdown.ts';

const T0 = Date.parse('2026-10-19T15:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const STEADY: Pacing = { ...DEFAULT_PACING, jitterMs: 0 };

/** A file system of one file, in memory. */
function disk(): MemoryDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (p) => files.get(p) ?? null,
    write: (p, text) => {
      files.set(p, text);
    },
  };
}

function wallTarget(pacer: Pacer, times: number, at = T0): number {
  let until = 0;
  for (let i = 0; i < times; i += 1) until = pacer.challenged('Target', at);
  return until;
}

test('A WALL IS PROBED AT MOST EVERY SIX HOURS, DOUBLING TO TWELVE', () => {
  // The first three still start small: a single challenge is often a blip.
  // Past the third it is a wall, and a wall gets one look per six hours.
  const pacer = new Pacer(STEADY, () => 0);
  const steps = Array.from({ length: 7 }, () => (pacer.challenged('Target', T0) - T0) / MIN);
  assert.deepEqual(steps, [20, 40, 80, 360, 720, 720, 720]);
  assert.equal(WALLED_AFTER, 3);
  assert.equal(pacer.walled('Target'), true);
  assert.equal(pacer.walled('Walmart'), false, 'one shop walling says nothing about another');
});

test('A WEEK OF WALL COSTS A HANDFUL OF LOOKS, NOT THOUSANDS', () => {
  // Every look is refused, for a week. Count the looks the pacer allows.
  const pacer = new Pacer(STEADY, () => 0);
  let t = T0;
  let looks = 0;
  const end = T0 + 7 * 24 * HOUR;
  while (t < end) {
    looks += 1;
    t = pacer.challenged('Target', t);
  }
  assert.ok(looks <= 18, `a week of wall cost ${looks} looks`);
});

test('THE WALL PROBE IS CONFIGURABLE, AND A SILLY VALUE IS CLAMPED', () => {
  assert.equal(pacingFor(undefined), DEFAULT_PACING);
  assert.equal(pacingFor(0).wallProbeMs, 6 * HOUR, 'zero would turn a wall into a loop');
  assert.equal(pacingFor(-3).wallProbeMs, 6 * HOUR);
  assert.equal(pacingFor(Number.NaN).wallProbeMs, 6 * HOUR);
  assert.equal(pacingFor(3).wallProbeMs, 3 * HOUR);
  assert.equal(pacingFor(3).maxBackoffMs, 6 * HOUR);
  assert.equal(pacingFor(0.1).wallProbeMs, 1 * HOUR, 'never more often than hourly');
  assert.equal(pacingFor(100).wallProbeMs, 24 * HOUR, 'never longer than a day');

  const pacer = new Pacer({ ...pacingFor(3), jitterMs: 0 }, () => 0);
  wallTarget(pacer, WALLED_AFTER);
  assert.equal(pacer.challenged('Target', T0) - T0, 3 * HOUR);
});

test('A RESTART DOES NOT FORGET A WALL', () => {
  const fs = disk();
  const before = new Pacer(STEADY, () => 0);
  before.onChange = () => saveMemory(fs, { pacer: before.snapshot(), sweep: null }, T0);
  const until = wallTarget(before, 4); // the fourth: a six-hour stand-down
  assert.equal(until - T0, 6 * HOUR);
  assert.ok(fs.files.has(STANDDOWN_FILE), 'written down the moment it changed');

  // The keeper restarts Phantom an hour later.
  const later = T0 + HOUR;
  const after = new Pacer(STEADY, () => 0);
  after.restore(loadMemory(fs).pacer, later);

  assert.equal(after.standingDown('Target', later), true, 'still standing down');
  assert.equal(after.waitMs('Target', later), 5 * HOUR, 'for the five hours that were left');
  assert.equal(after.challengeStreak('Target'), 4);
  assert.equal(after.standingDown('Walmart', later), false);

  // And when the probe is refused, the stand-down grows from where it was,
  // not from twenty minutes. This is the half the old code lost.
  const probe = until + 1;
  assert.equal(after.challenged('Target', probe) - probe, 12 * HOUR);
});

test('a restart does not forget a resting listing either', () => {
  const fs = disk();
  const before = new Pacer(STEADY, () => 0);
  before.listingChallenged(45, T0);
  before.listingChallenged(45, T0); // 40 minutes
  saveMemory(fs, { pacer: before.snapshot(), sweep: null }, T0);

  const after = new Pacer(STEADY, () => 0);
  after.restore(loadMemory(fs).pacer, T0 + MIN);
  assert.equal(after.listingRestMs(45, T0 + MIN), 2 * LISTING_REST_MS - MIN);
  assert.equal(after.listingWalls(45), 2);
});

test('a clean read is written down too, so a restart does not resurrect a forgiven wall', () => {
  const fs = disk();
  const pacer = new Pacer(STEADY, () => 0);
  let writes = 0;
  pacer.onChange = () => {
    writes += 1;
    saveMemory(fs, { pacer: pacer.snapshot(), sweep: null }, T0);
  };
  wallTarget(pacer, 2);
  assert.equal(writes, 2);

  pacer.succeeded('Target');
  assert.equal(writes, 3, 'forgiving is a change');
  const after = new Pacer(STEADY, () => 0);
  after.restore(loadMemory(fs).pacer, T0);
  assert.equal(after.standingDown('Target', T0), false);
  assert.equal(after.challengeStreak('Target'), 0);

  // A clean read with nothing to forgive writes nothing: otherwise every
  // ordinary reading would rewrite the file.
  pacer.succeeded('Target');
  pacer.listingSucceeded(99);
  assert.equal(writes, 3);
});

test('A REMEMBERED STAND-DOWN CANNOT OUTLAST THE CEILING', () => {
  // A wrong clock or a hand edit must not silence a shop for a month.
  const pacer = new Pacer(STEADY, () => 0);
  pacer.restore(
    {
      retailers: {
        Target: { penaltyMs: 99 * 24 * HOUR, standDownUntil: T0 + 30 * 24 * HOUR, consecutiveChallenges: 9 },
      },
      listings: { '7': { until: T0 + 30 * 24 * HOUR, restMs: 99 * 24 * HOUR, walls: 3 } },
    },
    T0,
  );
  assert.equal(pacer.waitMs('Target', T0), STEADY.maxBackoffMs);
  assert.ok(pacer.listingRestMs(7, T0) <= 24 * HOUR);
});

test('A MANGLED MEMORY FILE MEANS STARTING FRESH, NEVER STOPPING', () => {
  // Fail open on watching: the worst a bad file may do is what no file did.
  const fs = disk();
  fs.files.set(STANDDOWN_FILE, '{ not json');
  assert.deepEqual(loadMemory(fs), { pacer: null, sweep: null });
  assert.deepEqual(loadMemory({ read: () => { throw new Error('EACCES'); }, write: () => {} }), {
    pacer: null,
    sweep: null,
  });
  assert.deepEqual(loadMemory(disk()), { pacer: null, sweep: null }, 'no file at all');

  const pacer = new Pacer(STEADY, () => 0);
  for (const junk of [null, 42, 'x', { retailers: 'x' }, { retailers: { Target: { penaltyMs: 'x' } } },
    { retailers: { Target: { penaltyMs: -1, standDownUntil: T0, consecutiveChallenges: 1 } } },
    { listings: { abc: { until: T0, restMs: 1, walls: 1 } } }]) {
    pacer.restore(junk, T0);
  }
  assert.equal(pacer.waitMs('Target', T0), 0);
  assert.equal(pacer.standingDown('Target', T0), false);

  // And a write that fails says so instead of throwing into the pass.
  const err = saveMemory({ read: () => null, write: () => { throw new Error('disk full'); } },
    { pacer: pacer.snapshot(), sweep: null }, T0);
  assert.equal(err, 'disk full');
});

test('a failing write inside the pacer never stops the reading', () => {
  const pacer = new Pacer(STEADY, () => 0);
  pacer.onChange = () => {
    throw new Error('disk full');
  };
  assert.doesNotThrow(() => pacer.challenged('Target', T0));
  assert.equal(pacer.standingDown('Target', T0), true);
});

test('A FAILED SWEEP IS PLANNED AGAIN AT MOST ONCE A DAY', () => {
  // Nothing planned yet: go.
  assert.equal(mayPlanSweep(null, T0), true);

  // Planned an hour ago and the app still says due: that sweep did not
  // finish (Target walled it). Not again until a day has passed.
  const failed = { plannedAt: T0 - HOUR, settled: false };
  assert.equal(mayPlanSweep(failed, T0), false);
  assert.equal(mayPlanSweep(failed, T0 - HOUR + SWEEP_RETRY_MS - 1), false);
  assert.equal(mayPlanSweep(failed, T0 - HOUR + SWEEP_RETRY_MS), true);
  assert.equal(nextSweepAllowedAt(failed), T0 - HOUR + SWEEP_RETRY_MS);

  // The app said "not due" since: that one finished, and the next due one is
  // a new sweep, whatever the setting's hours are.
  assert.equal(mayPlanSweep({ plannedAt: T0 - HOUR, settled: true }, T0), true);
  assert.equal(nextSweepAllowedAt({ plannedAt: T0 - HOUR, settled: true }), null);

  // A plan dated in the future means the clock moved; it must not hold the
  // sweep off until the clock catches up.
  assert.equal(mayPlanSweep({ plannedAt: T0 + 5 * HOUR, settled: false }, T0), true);
});

test('the sweep memory survives a restart', () => {
  const fs = disk();
  saveMemory(fs, { pacer: null, sweep: { plannedAt: T0, settled: false } }, T0);
  const back = loadMemory(fs);
  assert.deepEqual(back.sweep, { plannedAt: T0, settled: false });
  assert.equal(mayPlanSweep(back.sweep, T0 + HOUR), false, 'a restart is not a reason to sweep again');

  fs.files.set(STANDDOWN_FILE, JSON.stringify({ sweep: { plannedAt: 'yesterday' } }));
  assert.equal(loadMemory(fs).sweep, null, 'a mangled entry reads as nothing');
});

test('the memory file holds shop names, listing ids and times, and nothing else', () => {
  // It sits in logs/, which is gitignored, but rule 7 is about what exists at
  // all: no token, no URL, no address.
  const fs = disk();
  const pacer = new Pacer(STEADY, () => 0);
  wallTarget(pacer, 2);
  pacer.listingChallenged(45, T0);
  saveMemory(fs, { pacer: pacer.snapshot(), sweep: { plannedAt: T0, settled: false } }, T0);
  const text = fs.files.get(STANDDOWN_FILE)!;
  const keys = new Set<string>();
  JSON.parse(text, (k, v) => {
    if (k) keys.add(k);
    return v;
  });
  assert.deepEqual(
    [...keys].sort(),
    ['45', 'Target', 'consecutiveChallenges', 'listings', 'pacer', 'penaltyMs', 'plannedAt', 'restMs',
      'retailers', 'savedAt', 'settled', 'standDownUntil', 'sweep', 'until', 'walls'],
  );
  assert.doesNotMatch(text, /http|token|@/i);
});
