/**
 * Pacing.
 *
 * These tests are about not getting banned, so they are written as the
 * failure they prevent rather than as "waitMs returns a number".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, isDue, nextUp, DEFAULT_PACING, type Pacing } from '../src/rate.ts';

const T0 = 1_700_000_000_000;

/** No jitter, so gaps are exact and the assertions can be about the rule. */
const STEADY: Pacing = { ...DEFAULT_PACING, jitterMs: 0 };

const mission = (over: Partial<Mission> = {}): Mission => ({
  retailer: 'Target',
  checkEverySeconds: 30,
  lastCheckedAt: '',
  id: 1,
  ...over,
});
interface Mission {
  id: number;
  retailer: string;
  checkEverySeconds: number;
  lastCheckedAt: string;
  checkNow?: boolean;
}

test('a fresh retailer may be touched immediately', () => {
  const pacer = new Pacer(STEADY, () => 0);
  assert.equal(pacer.waitMs('Target', T0), 0);
});

test('the budget belongs to the retailer, not the mission', () => {
  // The bug this prevents: ten missions at Target meaning ten times the
  // traffic. One request is recorded; every other mission at that retailer
  // has to wait, because the site is what is being protected.
  const pacer = new Pacer(STEADY, () => 0);
  pacer.record('Target', T0);

  assert.equal(pacer.waitMs('Target', T0), STEADY.minSpacingMs);
  assert.equal(pacer.waitMs('Walmart', T0), 0, 'a different retailer is unaffected');
});

test('the gap is honoured and then released', () => {
  const pacer = new Pacer(STEADY, () => 0);
  pacer.record('Target', T0);

  assert.equal(pacer.waitMs('Target', T0 + STEADY.minSpacingMs - 1), 1);
  assert.equal(pacer.waitMs('Target', T0 + STEADY.minSpacingMs), 0);
  assert.equal(pacer.waitMs('Target', T0 + 60_000), 0);
});

test('jitter is added, so the requests are never clockwork', () => {
  // Clockwork is the tell. Two pacers with different randomness must not
  // agree on when the next request may go out.
  const low = new Pacer(DEFAULT_PACING, () => 0);
  const high = new Pacer(DEFAULT_PACING, () => 1);
  low.record('Target', T0);
  high.record('Target', T0);

  assert.equal(low.waitMs('Target', T0), DEFAULT_PACING.minSpacingMs);
  assert.equal(high.waitMs('Target', T0), DEFAULT_PACING.minSpacingMs + DEFAULT_PACING.jitterMs);
  assert.notEqual(low.waitMs('Target', T0), high.waitMs('Target', T0));
});

test('jitter never shortens the minimum gap', () => {
  for (const r of [0, 0.01, 0.5, 0.99, 1]) {
    const pacer = new Pacer(DEFAULT_PACING, () => r);
    pacer.record('Target', T0);
    assert.ok(
      pacer.waitMs('Target', T0) >= DEFAULT_PACING.minSpacingMs,
      `random()=${r} produced a gap below the floor`,
    );
  }
});

test('a challenge stands the whole retailer down, not just one mission', () => {
  const pacer = new Pacer(STEADY, () => 0);
  const until = pacer.challenged('Target', T0);

  assert.equal(until, T0 + STEADY.backoffMs);
  assert.equal(pacer.waitMs('Target', T0), STEADY.backoffMs);
  assert.equal(pacer.standingDown('Target', T0), true);
  assert.equal(pacer.standingDown('Walmart', T0), false);
});

test('each successive challenge doubles the stand-down', () => {
  // Arguing with a bot check is how a soft flag becomes a hard block.
  const pacer = new Pacer(STEADY, () => 0);
  const first = pacer.challenged('Target', T0);
  const second = pacer.challenged('Target', T0);
  const third = pacer.challenged('Target', T0);

  assert.equal(first - T0, STEADY.backoffMs);
  assert.equal(second - T0, STEADY.backoffMs * 2);
  assert.equal(third - T0, STEADY.backoffMs * 4);
  assert.equal(pacer.challengeStreak('Target'), 3);
});

test('the doubling stops at the ceiling', () => {
  const pacer = new Pacer(STEADY, () => 0);
  for (let i = 0; i < 20; i += 1) pacer.challenged('Target', T0);
  assert.equal(pacer.waitMs('Target', T0), STEADY.maxBackoffMs);
});

test('a clean read forgives the penalty', () => {
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);
  pacer.challenged('Target', T0);
  pacer.succeeded('Target');

  assert.equal(pacer.standingDown('Target', T0), false);
  assert.equal(pacer.challengeStreak('Target'), 0);
  // …and the next challenge starts from the base penalty again.
  assert.equal(pacer.challenged('Target', T0) - T0, STEADY.backoffMs);
});

test('a stand-down outlives the ordinary spacing', () => {
  // record() must not be able to shorten a stand-down: whichever is later wins.
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);
  pacer.record('Target', T0);
  assert.equal(pacer.waitMs('Target', T0), STEADY.backoffMs);
});

test('a mission never checked is due', () => {
  assert.equal(isDue(null, 30, T0), true);
  assert.equal(isDue('', 30, T0), true);
});

test('an unparseable last-checked is treated as due, not as never', () => {
  // Fail open on watching: a bad timestamp should cost a reading, not stop one.
  assert.equal(isDue('not a date', 30, T0), true);
});

test('a mission is due once its own interval has passed', () => {
  const last = new Date(T0).toISOString();
  assert.equal(isDue(last, 30, T0 + 29_000), false);
  assert.equal(isDue(last, 30, T0 + 30_000), true);
});

test('nextUp skips missions that are not due', () => {
  const pacer = new Pacer(STEADY, () => 0);
  const recent = mission({ lastCheckedAt: new Date(T0).toISOString() });
  assert.equal(nextUp([recent], pacer, T0 + 1_000), null);
});

test('nextUp skips a retailer that is standing down', () => {
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);
  assert.equal(nextUp([mission()], pacer, T0), null);
  // The Walmart mission in the same list still goes.
  const both = [mission(), mission({ id: 2, retailer: 'Walmart' })];
  assert.equal(nextUp(both, pacer, T0)?.id, 2);
});

test('nextUp takes the longest-waiting mission first', () => {
  // Otherwise a 30-second mission starves a 10-minute one that shares the
  // retailer's budget: the fast one is always due, so it always wins.
  const pacer = new Pacer(STEADY, () => 0);
  const fresh = mission({ id: 1, lastCheckedAt: new Date(T0 - 60_000).toISOString() });
  const stale = mission({ id: 2, lastCheckedAt: new Date(T0 - 600_000).toISOString() });
  const never = mission({ id: 3, lastCheckedAt: '' });

  assert.equal(nextUp([fresh, stale], pacer, T0)?.id, 2);
  assert.equal(nextUp([fresh, stale, never], pacer, T0)?.id, 3, 'never-checked is oldest of all');
});

// ── Test run ─────────────────────────────────────────────────────────────────

test('a requested check is due even when its schedule says otherwise', () => {
  const pacer = new Pacer(STEADY, () => 0);
  const justChecked = mission({ lastCheckedAt: new Date(T0).toISOString(), checkNow: true });
  assert.equal(nextUp([justChecked], pacer, T0 + 1_000)?.id, 1);
});

test('a requested check jumps the queue of missions', () => {
  // Somebody is watching the page waiting for it. Every other mission's
  // schedule can absorb a turn.
  const pacer = new Pacer(STEADY, () => 0);
  const ancient = mission({ id: 1, lastCheckedAt: new Date(T0 - 600_000).toISOString() });
  const asked = mission({ id: 2, lastCheckedAt: new Date(T0 - 1_000).toISOString(), checkNow: true });
  assert.equal(nextUp([ancient, asked], pacer, T0)?.id, 2);
});

test('A REQUESTED CHECK DOES NOT JUMP THE RETAILER', () => {
  // The line that matters. A button in a web page must not be able to override
  // pacing — that is how you get a bot check while looking at the screen that
  // caused it.
  const pacer = new Pacer(STEADY, () => 0);
  pacer.challenged('Target', T0);
  assert.equal(nextUp([mission({ checkNow: true })], pacer, T0), null);

  pacer.succeeded('Target');
  pacer.record('Target', T0);
  assert.equal(nextUp([mission({ checkNow: true })], pacer, T0), null, 'ordinary spacing holds too');
});

test('two requested checks fall back to longest-waiting between themselves', () => {
  const pacer = new Pacer(STEADY, () => 0);
  const a = mission({ id: 1, lastCheckedAt: new Date(T0 - 10_000).toISOString(), checkNow: true });
  const b = mission({ id: 2, lastCheckedAt: new Date(T0 - 90_000).toISOString(), checkNow: true });
  assert.equal(nextUp([a, b], pacer, T0)?.id, 2);
});
