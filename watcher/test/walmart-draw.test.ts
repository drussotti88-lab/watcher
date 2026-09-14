/**
 * Reading a drawing, and refusing to guess one.
 *
 * The fixture is the real shape, captured from
 * `walmart.com/shop/collectibles/draw` on 14 Sep 2026 and rebuilt by hand with
 * the account's own identifiers left out. Every key path below is one Walmart
 * actually used.
 *
 * The tests that matter most are the ones about what this must NOT say. A
 * drawing is random, so nothing here is a race — the only thing a wrong answer
 * can do is send somebody to a page with no button, or fail to send them at
 * all. The second is worse and the first is what makes people stop reading the
 * alerts, which turns it into the second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  readWalmartDraw,
  drawModules,
  windowBadge,
  parseDrawWhen,
  drawEntryEnabled,
} from '../src/readers/walmart-draw.ts';

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/walmart-draw.json'), 'utf8'),
);

/** Before the 16th, which is when the captured page was announcing. */
const BEFORE = Date.parse('2026-09-14T12:00:00.000Z');

test('THE DRAWING CAROUSEL IS FOUND BY SHAPE, NOT BY NAME OR INDEX', () => {
  // The module Walmart uses is literally called "(USE THIS) Upcoming Drawing
  // Item Carousel Module CC-Web" — that is a person talking to a colleague,
  // and another module on the same page is named after a date in June.
  // Anchoring on either is anchoring on somebody's housekeeping.
  const found = drawModules(fixture);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.type, 'PrismItemCarousel');
  assert.equal(drawModules({}).length, 0, 'and an unrecognisable page finds nothing, quietly');
  assert.equal(drawModules(null).length, 0);
});

test('A DRAWING READS AS ITS PRODUCT, ITS PRICE AND ITS WINDOW', () => {
  const rows = readWalmartDraw(fixture, BEFORE);
  assert.equal(rows.length, 2);

  const [first] = rows;
  assert.equal(first!.usItemId, '21009455186');
  assert.match(first!.name, /30th Celebration/);
  assert.equal(first!.price, 69.49);
  assert.equal(first!.orderLimit, 1);
  // The path is kept, the tracking parameters are not: a watchlist entry
  // should be the product, not the page that happened to link to it.
  assert.equal(first!.url, 'https://www.walmart.com/ip/Pok-mon-TCG-30th-Celebration-ex-Box-Bundle/21009455186');
  assert.equal(first!.sellerName, 'Walmart.com');
});

test('THE WINDOW IS TWO FIELDS, AND BOTH ARE NEEDED', () => {
  // Walmart splits it: `text` is "Drawing starts " with its trailing space,
  // `slaText` is "Sep 16, 2:00pm PDT". Half of that is either a label with no
  // time or a time with no idea which end of the window it is.
  const p = fixture.props.pageProps.initialData.contentLayout.modules[2]
    .configs.productsConfig.products[0];
  assert.deepEqual(windowBadge(p), { label: 'Drawing starts', text: 'Sep 16, 2:00pm PDT' });
  assert.deepEqual(windowBadge({}), { label: '', text: '' });
  assert.deepEqual(windowBadge(null), { label: '', text: '' });
});

test('"Sep 16, 2:00pm PDT" IS AN INSTANT, IN THE ZONE WALMART NAMED', () => {
  // Not Date.parse. It accepts this shape on some runtimes and returns NaN on
  // others, and silently assumes the LOCAL zone for an abbreviation it does
  // not know. A countdown three hours wrong is worse than no countdown,
  // because it is one somebody trusts.
  assert.equal(parseDrawWhen('Sep 16, 2:00pm PDT', BEFORE), '2026-09-16T21:00:00.000Z');
  assert.equal(parseDrawWhen('Sep 16, 2:00am PDT', BEFORE), '2026-09-16T09:00:00.000Z');
  assert.equal(parseDrawWhen('Dec 1, 12:00am EST', BEFORE), '2026-12-01T05:00:00.000Z');
  assert.equal(parseDrawWhen('Dec 1, 12:00pm EST', BEFORE), '2026-12-01T17:00:00.000Z');

  // Walmart writes no year, so one has to be supplied, and "this year, rolled
  // forward if past" is wrong every January: a page read on the 5th saying
  // "Dec 20" means three weeks ago, and rolling forward puts it eleven months
  // out. The rule is NEAREST, which is right in both directions.
  const january = Date.parse('2027-01-05T00:00:00.000Z');
  assert.equal(parseDrawWhen('Dec 20, 2:00pm PST', january), '2026-12-20T22:00:00.000Z');
  assert.equal(parseDrawWhen('Feb 2, 2:00pm PST', january), '2027-02-02T22:00:00.000Z');
});

test('AN UNREADABLE TIME IS NULL, NEVER A GUESS', () => {
  // Null means the caller shows Walmart's own words, which are never wrong.
  assert.equal(parseDrawWhen('', BEFORE), null);
  assert.equal(parseDrawWhen('soon', BEFORE), null);
  assert.equal(parseDrawWhen('Sep 16', BEFORE), null, 'a date with no time is not a window');
  // No zone named is not "assume ours". Walmart has always named one, and
  // guessing is the three-hours-wrong countdown.
  assert.equal(parseDrawWhen('Sep 16, 2:00pm', BEFORE), null);
  assert.equal(parseDrawWhen('Sep 16, 2:00pm XYZ', BEFORE), null);
  assert.equal(parseDrawWhen('Smarch 16, 2:00pm PDT', BEFORE), null);
  assert.equal(parseDrawWhen('Sep 41, 2:00pm PDT', BEFORE), null);
  assert.equal(parseDrawWhen('Sep 16, 25:00pm PDT', BEFORE), null);
});

test('ANNOUNCED IS NOT OPEN, AND THE FLAG IS WHAT DECIDES', () => {
  // The capture had showDrawCTA false on every row while the page said
  // "Drawing starts Sep 16". What the flag does when a window actually opens
  // has not been seen, so `open` is claimed only when Walmart says so — never
  // inferred from the clock.
  const announced = readWalmartDraw(fixture, BEFORE);
  assert.ok(announced.every((r) => r.phase === 'announced'));
  assert.ok(announced.every((r) => r.showDrawCTA === false));

  const live = JSON.parse(JSON.stringify(fixture));
  live.props.pageProps.initialData.contentLayout.modules[2]
    .configs.productsConfig.products[0].showDrawCTA = true;
  const [open] = readWalmartDraw(live, BEFORE);
  assert.equal(open!.phase, 'open');
});

test('THE CLOCK PASSING A START TIME DOES NOT OPEN A DRAWING', () => {
  // The mistake worth naming. It is 2:01pm, the page still says
  // showDrawCTA: false, and inferring "open" from the time sends somebody to a
  // page with no button. They learn to ignore the alert, and the alert they
  // ignore is the next one.
  const after = Date.parse('2026-09-16T22:00:00.000Z');
  for (const row of readWalmartDraw(fixture, after)) {
    assert.notEqual(row.phase, 'open');
    assert.equal(row.showDrawCTA, false);
    // And Walmart's own words survive intact, whatever we concluded.
    assert.equal(row.windowText, 'Sep 16, 2:00pm PDT');
    assert.equal(row.windowLabel, 'Drawing starts');
  }
});

test('an empty or broken page reads as no drawings, not as a crash', () => {
  assert.deepEqual(readWalmartDraw(null), []);
  assert.deepEqual(readWalmartDraw({}), []);
  assert.deepEqual(readWalmartDraw({ props: { pageProps: {} } }), []);
  assert.deepEqual(
    readWalmartDraw({ props: { pageProps: { initialData: { contentLayout: { modules: 'nope' } } } } }),
    [],
  );
});

test('THE FEATURE FLAG TELLS "NONE TODAY" FROM "SWITCHED OFF"', () => {
  // Those look identical in an empty list, and they call for opposite
  // reactions: one is a quiet week, the other is the mechanism going away.
  assert.equal(drawEntryEnabled(fixture), true);
  assert.equal(drawEntryEnabled({}), null, 'not knowing is its own answer');
  const off = JSON.parse(JSON.stringify(fixture));
  off.props.pageProps.bootstrapData.cv.shared._all_.enableDrawEntry = false;
  assert.equal(drawEntryEnabled(off), false);
});

test('the same item listed twice is one drawing', () => {
  const twice = JSON.parse(JSON.stringify(fixture));
  const products = twice.props.pageProps.initialData.contentLayout.modules[2]
    .configs.productsConfig.products;
  products.push(JSON.parse(JSON.stringify(products[0])));
  assert.equal(readWalmartDraw(twice, BEFORE).length, 2);
});

// ── The cadence, and what counts as news ────────────────────────────────────

import { drawInterval, drawChanges, toDrawingIn } from '../src/draws.ts';
import type { DrawRow } from '../src/readers/walmart-draw.ts';

const row = (over: Partial<DrawRow> = {}): DrawRow => ({
  usItemId: '1', name: 'A bundle', url: '', price: 69.49, orderLimit: 1,
  imageUrl: '', phase: 'announced', showDrawCTA: false,
  windowLabel: 'Drawing starts', windowText: 'Sep 16, 2:00pm PDT',
  windowAt: '2026-09-16T21:00:00.000Z', sellerName: 'Walmart.com', sellerId: 'W',
  state: 'out', ...over,
});

test('A QUIET DRAWINGS PAGE IS READ TWICE AN HOUR, NOT TWICE A MINUTE', () => {
  // Drawings arrive a few times a month and are announced days ahead. Polling
  // a quiet page hard is how this house's address got a press-and-hold in
  // front of its own browsing in September, and hearing about an announcement
  // twenty minutes late costs precisely nothing.
  assert.equal(drawInterval([], BEFORE), 1800);
  assert.equal(drawInterval([row()], BEFORE), 1800, 'two days out is not urgent');
});

test('THE HOUR BEFORE A START IS THE ONLY PART THAT IS TIME-SENSITIVE', () => {
  const start = Date.parse('2026-09-16T21:00:00.000Z');
  assert.equal(drawInterval([row()], start - 90 * 60_000), 1800, 'ninety minutes out: still slow');
  assert.equal(drawInterval([row()], start - 30 * 60_000), 120);
  // And after the stated minute, because Walmart's stated time and the minute
  // the button appears are not guaranteed to be the same — the reader refuses
  // to infer one from the other, so the watcher keeps looking.
  assert.equal(drawInterval([row()], start + 20 * 60_000), 120);
  assert.equal(drawInterval([row()], start + 5 * 3600_000), 1800, 'but not forever');
  // Open is open, whatever the clock says.
  assert.equal(drawInterval([row({ phase: 'open', windowAt: null })], BEFORE), 120);
});

test('NEWS IS THE EDGE, NOT THE STATE', () => {
  // "A drawing is open" is true for hours; saying it every two minutes is how
  // a channel gets muted, and a muted channel misses the next one.
  const shut = row();
  const open = row({ phase: 'open', showDrawCTA: true });

  assert.deepEqual(drawChanges([], [shut]).map((c) => c.kind), ['announced']);
  assert.deepEqual(drawChanges([shut], [shut]).map((c) => c.kind), [], 'still announced is not news');
  assert.deepEqual(drawChanges([shut], [open]).map((c) => c.kind), ['opened']);
  assert.deepEqual(drawChanges([open], [open]).map((c) => c.kind), [], 'still open is not news either');

  // Arriving already open is the loud one, not a diary entry.
  assert.deepEqual(drawChanges([], [open]).map((c) => c.kind), ['opened']);

  // And leaving the page is worth saying: a window you meant to enter and did
  // not is worth knowing about, and it is how we learn how long they last.
  assert.deepEqual(drawChanges([open], []).map((c) => c.kind), ['gone']);
});

test('several drawings are tracked independently', () => {
  const a = row({ usItemId: 'a' });
  const b = row({ usItemId: 'b' });
  const bOpen = row({ usItemId: 'b', phase: 'open', showDrawCTA: true });
  const changes = drawChanges([a, b], [a, bOpen]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.row.usItemId, 'b');
});

test('A READING IS MAPPED ONTO THE CONTRACT, FIELD BY FIELD', () => {
  // Posting scan.rows straight down the wire is what caused it: the reader
  // calls Walmart's id `usItemId` and the Hub calls it `externalId`, so every
  // row was silently dropped and the endpoint said 200. An explicit mapper is
  // a place where a rename becomes a type error instead of an empty table.
  const mapped = toDrawingIn(row({ usItemId: '21009455186', price: 69.49, orderLimit: 3 }));
  assert.equal(mapped.externalId, '21009455186', 'the field that was wrong');
  assert.equal(mapped.price, 69.49);
  assert.equal(mapped.orderLimit, 3);
  assert.equal(mapped.phase, 'announced');
  assert.equal(mapped.windowText, 'Sep 16, 2:00pm PDT');
  assert.equal(mapped.windowAt, '2026-09-16T21:00:00.000Z');
  // And nothing the Hub does not ask for rides along.
  assert.deepEqual(Object.keys(mapped).sort(), [
    'externalId', 'imageUrl', 'name', 'orderLimit', 'phase', 'price',
    'url', 'windowAt', 'windowLabel', 'windowText',
  ]);
});
