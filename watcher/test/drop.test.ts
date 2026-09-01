/**
 * When to hurry, and which shops to look at.
 *
 * Both of these change how much traffic goes to a retailer, so the tests are
 * named after the mistake they prevent rather than the function they call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dropWindow, burstMsFor, retailerOn, pausedList, todayIn } from '../src/drop.ts';
import { DEFAULT_SETTINGS, type Mission, type Settings } from '../src/hub.ts';
import { Pacer, DEFAULT_PACING, MIN_SAFE_SPACING_MS } from '../src/rate.ts';

const T0 = Date.parse('2026-09-16T14:00:00Z');

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: 1,
  listingId: 11,
  productKey: 'etb',
  productName: 'Chaos Rising ETB',
  retailer: 'Target',
  externalId: '95267143',
  url: 'https://www.target.com/p/-/A-95267143',
  enabled: true,
  armed: false,
  ceiling: null,
  quantity: 1,
  sellerPolicy: 'retailer_only',
  preOrderPolicy: 'skip',
  checkEverySeconds: 30,
  state: 'out',
  price: null,
  lastCheckedAt: '',
  ...over,
});

// ── the window ───────────────────────────────────────────────────────────────

test('NO BURST CONFIGURED MEANS NO WINDOW — a claim of hurry with no hurry is a lie in the log', () => {
  // Every other input says "open", but with no burst spacing set there is
  // nothing to open, and saying otherwise would put a tightened pace in the
  // log that never happened.
  const w = dropWindow(
    settings({ dropModeUntil: new Date(T0 + 3600_000).toISOString() }),
    [mission({ releaseDate: '2026-09-16' })],
    T0,
  );
  assert.equal(w.open, false);
  assert.equal(burstMsFor(settings({ dropModeUntil: new Date(T0 + 3600_000).toISOString() }), [], T0), null);
});

test('a manual window is open until it expires, and not one minute after', () => {
  const s = settings({ burstSpacingSeconds: 8, dropModeUntil: new Date(T0 + 20 * 60_000).toISOString() });
  const open = dropWindow(s, [], T0);
  assert.equal(open.open, true);
  assert.match(open.reason, /drop mode is on for another 20m/);
  assert.equal(burstMsFor(s, [], T0), 8_000);

  // One second past the expiry the pace is ordinary again — the switch closes
  // itself, which is the whole reason it is an expiry and not a toggle.
  const later = dropWindow(s, [], T0 + 20 * 60_000 + 1000);
  assert.equal(later.open, false);
  assert.equal(burstMsFor(s, [], T0 + 20 * 60_000 + 1000), null);
});

test('RELEASE DAY OPENS ITS OWN WINDOW — the one day the shop is certainly interesting', () => {
  const s = settings({ burstSpacingSeconds: 10, timezone: 'UTC' });
  const w = dropWindow(s, [mission({ releaseDate: '2026-09-16' })], T0);
  assert.equal(w.open, true);
  assert.match(w.reason, /released today: Chaos Rising ETB/);
});

test('a release date that is not today, or a disabled mission, opens nothing', () => {
  const s = settings({ burstSpacingSeconds: 10, timezone: 'UTC' });
  assert.equal(dropWindow(s, [mission({ releaseDate: '2026-09-17' })], T0).open, false);
  assert.equal(dropWindow(s, [mission({ releaseDate: null })], T0).open, false);
  assert.equal(
    dropWindow(s, [mission({ releaseDate: '2026-09-16', enabled: false })], T0).open,
    false,
    'a paused mission does not get to speed the whole shop up',
  );
});

test('several releases name a couple and count the rest', () => {
  const s = settings({ burstSpacingSeconds: 10, timezone: 'UTC' });
  const w = dropWindow(
    s,
    [
      mission({ id: 1, productName: 'A', releaseDate: '2026-09-16' }),
      mission({ id: 2, productName: 'B', releaseDate: '2026-09-16' }),
      mission({ id: 3, productName: 'C', releaseDate: '2026-09-16' }),
    ],
    T0,
  );
  assert.match(w.reason, /A, B \+1 more/);
});

test('the day is read in the settings timezone, not the server’s', () => {
  // 01:30 UTC on the 17th is still the evening of the 16th in Chicago, and a
  // release-day window that opens a day early (or late) is worse than none.
  const night = Date.parse('2026-09-17T01:30:00Z');
  assert.equal(todayIn('America/Chicago', night), '2026-09-16');
  assert.equal(todayIn('UTC', night), '2026-09-17');
  // An unknown zone falls back rather than throwing mid-pass.
  assert.match(todayIn('Not/AZone', night), /^\d{4}-\d{2}-\d{2}$/);
});

// ── the floor beneath the floor ──────────────────────────────────────────────

test('A BURST MAY TIGHTEN THE FLOOR, NEVER ABOLISH IT', () => {
  const pacer = new Pacer({ ...DEFAULT_PACING, jitterMs: 0 }, () => 0);
  assert.equal(pacer.spacingMs, 20_000, 'the ordinary pace to begin with');

  pacer.setBurstSpacing(8_000);
  assert.equal(pacer.spacingMs, 8_000);

  // A typo, or a settings field someone got creative with. The worst it may do
  // is make us brisk — being blocked during the drop it was tightened for is
  // the exact failure this clamp exists to prevent.
  pacer.setBurstSpacing(50);
  assert.equal(pacer.spacingMs, MIN_SAFE_SPACING_MS);
  pacer.setBurstSpacing(-1);
  assert.equal(pacer.spacingMs, 20_000, 'nonsense restores the ordinary floor');

  pacer.setBurstSpacing(null);
  assert.equal(pacer.spacingMs, 20_000, 'and the window closing restores it too');
});

test('bursting does not argue with a challenge', () => {
  // A stand-down is about us, not about the pace. Tightening the floor while
  // a retailer is telling us to go away is how a soft flag becomes a block.
  const pacer = new Pacer({ ...DEFAULT_PACING, jitterMs: 0 }, () => 0);
  const until = pacer.challenged('Target', T0);
  pacer.setBurstSpacing(5_000);
  assert.equal(pacer.standingDown('Target', T0), true);
  assert.equal(pacer.waitMs('Target', T0), until - T0, 'the full back-off, unshortened');
});

test('jitter scales with the floor so a burst is actually a burst', () => {
  // 8s of wobble on top of a 5s floor would average out to the old pace and
  // make the whole setting decorative.
  const pacer = new Pacer(DEFAULT_PACING, () => 1);
  pacer.setBurstSpacing(5_000);
  pacer.record('Target', T0);
  assert.ok(pacer.waitMs('Target', T0) <= 7_000, 'burst + at most 40% jitter');
});

// ── shops on and off ─────────────────────────────────────────────────────────

test('A SWITCHED-OFF SHOP IS OFF; EVERY OTHER SHOP IS UNAFFECTED', () => {
  const s = settings({ pausedRetailers: ['Walmart'] });
  assert.equal(retailerOn(s, 'Walmart'), false);
  assert.equal(retailerOn(s, 'Target'), true);
  assert.equal(retailerOn(s, 'Pokemon Center'), true);
  assert.equal(pausedList(s), 'Walmart');
});

test('an unknown shop is ON — the list names what is off', () => {
  // A reader landing before the settings know its name must keep working
  // rather than silently going dark.
  assert.equal(retailerOn(settings({ pausedRetailers: ['Walmart'] }), 'Costco'), true);
  assert.equal(retailerOn(settings(), 'Target'), true);
  // Spelling is not a reason to leave a shop running.
  assert.equal(retailerOn(settings({ pausedRetailers: ['walmart'] }), 'Walmart'), false);
});
