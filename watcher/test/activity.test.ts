/**
 * The log that leaves this machine.
 *
 * scrub.test.ts proves the scrubber removes what it should. This file proves
 * the scrubber is actually *in the path* — that no route exists by which a raw
 * line reaches the disk or the network. Those are different claims, and the
 * second one is the one that fails silently when somebody adds a destination
 * and forgets it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Activity, type ActivityLine } from '../src/activity.ts';
import { pass } from '../src/watch.ts';
import { Pacer, DEFAULT_PACING, type Pacing } from '../src/rate.ts';
import type { Browser } from '../src/browser.ts';
import type { Hub, Mission, ObservationOut, RunOut } from '../src/hub.ts';
import type { Reading } from '../src/read.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'activity-'));

function sink(): { sink: { recordActivity(l: ActivityLine[]): Promise<boolean> }; got: ActivityLine[]; fail: () => void } {
  const got: ActivityLine[] = [];
  let failing = false;
  return {
    got,
    fail: () => {
      failing = true;
    },
    sink: {
      async recordActivity(lines: ActivityLine[]) {
        if (failing) return false;
        got.push(...lines);
        return true;
      },
    },
  };
}

// ── the scrubber is in the path ──────────────────────────────────────────────

test('THE HUB NEVER SEES AN UNSCRUBBED LINE', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, secrets: ['tok-abcdefgh12345678'], batchSize: 1 });
  log.record({
    kind: 'check',
    message: 'failed at https://www.target.com/p/x?visitor_id=018F2A9C3B4D5E6F7A8B&zip=37067',
    detail: 'token tok-abcdefgh12345678 rejected',
  });
  await log.flush(true);

  const sent = JSON.stringify(s.got);
  assert.ok(!sent.includes('018F2A9C3B4D5E6F7A8B'), 'visitor id reached the Hub');
  assert.ok(!sent.includes('37067'), 'postcode reached the Hub');
  assert.ok(!sent.includes('tok-abcdefgh12345678'), 'the token reached the Hub');
  assert.ok(sent.includes('target.com'), 'and the useful half survived');
});

test('THE LOCAL FILE NEVER HOLDS AN UNSCRUBBED LINE EITHER', () => {
  // The reason scrubbing happens in record() rather than at send time. If it
  // were done on the way out, the raw text would be sitting on disk the whole
  // while and the guarantee would be worth nothing.
  const d = dir();
  const log = new Activity({ dir: d, secrets: ['tok-abcdefgh12345678'] });
  log.record({ kind: 'check', message: 'C:\\Users\\danru\\watcher failed, token tok-abcdefgh12345678' });

  const written = readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('');
  assert.ok(!written.includes('danru'), 'the account name is on disk');
  assert.ok(!written.includes('tok-abcdefgh12345678'), 'the token is on disk');
  assert.ok(written.includes('watcher failed'), 'and the useful half survived');
});

test('record hands back the scrubbed line, so printing it is safe too', () => {
  // A terminal ends up in a screenshot. Returning the original here would make
  // the console the one destination that still leaked.
  const log = new Activity();
  const out = log.record({ kind: 'check', message: 'signed in as someone@example.com' });
  assert.ok(!out.message.includes('someone@example.com'));
});

// ── delivery ─────────────────────────────────────────────────────────────────

test('lines are batched rather than sent one request per check', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 3 });
  for (let i = 0; i < 2; i += 1) log.record({ kind: 'check', message: `n${i}` });

  assert.deepEqual(await log.flush(), { sent: 0, queued: 2 }, 'below the batch size, nothing goes');
  log.record({ kind: 'check', message: 'n2' });
  assert.equal((await log.flush()).sent, 3);
});

test('a Hub that will not take the log keeps the log', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 1 });
  s.fail();
  log.record({ kind: 'check', message: 'during the outage' });

  assert.equal((await log.flush()).sent, 0);
  assert.equal(log.backlog, 1, 'still buffered, not discarded');
});

test('a sink that throws does not take the pass down with it', async () => {
  const log = new Activity({
    sink: {
      async recordActivity() {
        throw new Error('network gone');
      },
    },
    batchSize: 1,
  });
  log.record({ kind: 'check', message: 'x' });
  await assert.doesNotReject(() => log.flush());
  assert.equal(log.backlog, 1);
});

test('an unbounded outage drops the oldest and says how many', () => {
  // The alternative is a heap that grows until the process dies, which loses
  // every line rather than the least useful ones.
  const log = new Activity({ batchSize: 1, maxQueue: 3 });
  for (let i = 0; i < 5; i += 1) log.record({ kind: 'check', message: `n${i}` });

  assert.equal(log.backlog, 3);
  assert.equal(log.lost, 2);
});

test('a broken disk is reported, not thrown', () => {
  // A file where a directory should be. Portable, instant, and a real ENOTDIR
  // rather than a path chosen for being weird — the first attempt at this used
  // somewhere under /proc and hung the whole suite.
  const notADir = join(dir(), 'this-is-a-file');
  writeFileSync(notADir, 'x');

  const log = new Activity({ dir: notADir });
  assert.doesNotThrow(() => log.record({ kind: 'check', message: 'x' }));
  assert.ok(log.fileError, 'and the reason is available to print');
});

test('old local files are swept, recent ones kept', () => {
  const d = dir();
  const old = join(d, 'activity-2020-01-01.ndjson');
  const recent = join(d, 'activity-2020-01-02.ndjson');
  writeFileSync(old, '{}\n');
  writeFileSync(recent, '{}\n');
  const longAgo = Date.now() / 1000 - 30 * 86400;
  utimesSync(old, longAgo, longAgo);

  new Activity({ dir: d, keepDays: 7 });
  const left = readdirSync(d);
  assert.ok(!left.includes('activity-2020-01-01.ndjson'), 'a month-old file is gone');
  assert.ok(left.includes('activity-2020-01-02.ndjson'), 'today is kept');
});

// ── the pass writes one line per check ───────────────────────────────────────

const T0 = 1_700_000_000_000;
const STEADY: Pacing = { ...DEFAULT_PACING, jitterMs: 0 };

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: 1, listingId: 11, productKey: 'mega-evolution-etb', productName: 'Mega Evolution ETB',
  retailer: 'Target', externalId: '1012644666', url: 'https://www.target.com/p/-/A-1012644666',
  enabled: true, armed: false, ceiling: null, quantity: 1, sellerPolicy: 'retailer_only',
  checkEverySeconds: 30, state: 'out', price: null, lastCheckedAt: '', ...over,
});

const reading = (over: Partial<Reading> = {}): Reading => ({
  name: 'Mega Evolution ETB', price: 49.99, state: 'out', confidence: 'exact',
  availableQuantity: null, orderLimit: null, pickupAvailable: false,
  seller: { kind: 'retailer', name: 'Target' },
  preOrder: { isPreOrder: false, releaseDate: null },
  note: '', challenged: false, challengeReason: '', imageUrl: '', ms: 812, ...over,
});

const quietHub = {
  backlog: 0,
  async report(o: ObservationOut[]) {
    return { sent: o.length, buffered: 0 };
  },
  async recordRun(_r: RunOut) {
    return true;
  },
} as unknown as Hub;

test('AN ORDINARY OUT-OF-STOCK CHECK STILL WRITES A LINE', async () => {
  // The whole point, and the one thing the runs table deliberately does not
  // do. Without the boring rows there is no way to tell a retailer that is
  // failing from one that is simply not being checked.
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 1 });
  await pass([mission()], new Pacer(STEADY), {
    browser: {} as Browser,
    hub: quietHub,
    activity: log,
    now: () => T0,
    read: async () => reading(),
  });
  await log.flush(true);

  assert.equal(s.got.length, 1);
  assert.equal(s.got[0]!.kind, 'check');
  assert.equal(s.got[0]!.level, 'info');
  assert.equal(s.got[0]!.retailer, 'Target');
  assert.equal(s.got[0]!.state, 'out');
  assert.equal(s.got[0]!.ms, 812);
  assert.ok(s.got[0]!.message.includes('49.99'));
});

test('the count the retailer stated travels with the check', async () => {
  // Target reports available_to_promise_quantity, and it is 0 on everything
  // out of stock. Whether that ever moves before a drop is a question about
  // data we did not previously keep — so now every check carries it.
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 1 });
  await pass([mission()], new Pacer(STEADY), {
    browser: {} as Browser,
    hub: quietHub,
    activity: log,
    now: () => T0,
    read: async () => reading({ availableQuantity: 0 }),
  });
  await log.flush(true);

  assert.equal(s.got[0]!.availableQuantity, 0, 'zero is a reading, not a missing value');
});

test('a check that could not be read is logged at error, with the reason', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 1 });
  await pass([mission()], new Pacer(STEADY), {
    browser: {} as Browser,
    hub: quietHub,
    activity: log,
    now: () => T0,
    read: async () => {
      throw new Error('net::ERR_ABORTED');
    },
  });
  await log.flush(true);

  assert.equal(s.got[0]!.level, 'error');
  assert.ok(s.got[0]!.message.includes('ERR_ABORTED'), s.got[0]!.message);
});

test('a challenge is a warning, not an error — it is us being asked to wait', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 1 });
  await pass([mission()], new Pacer(STEADY), {
    browser: {} as Browser,
    hub: quietHub,
    activity: log,
    now: () => T0,
    read: async () =>
      reading({ state: 'unknown', confidence: 'unknown', challenged: true, challengeReason: 'press and hold' }),
  });
  await log.flush(true);

  assert.equal(s.got[0]!.level, 'warn');
  assert.ok(s.got[0]!.detail!.includes('press and hold'));
});

test('a pass with no activity attached behaves exactly as before', async () => {
  // Every existing caller and every existing test constructs a pass without
  // one. Logging must be additive or it is a rewrite.
  const result = await pass([mission()], new Pacer(STEADY), {
    browser: {} as Browser,
    hub: quietHub,
    now: () => T0,
    read: async () => reading(),
  });
  assert.equal(result.checked, 1);
});

// ── Lines must not die with the process ──────────────────────────────────────

test('AN OLD LINE IS SENT EVEN WHEN THE BATCH IS NOT FULL', async () => {
  // Batching alone means up to batchSize lines sit in memory indefinitely on a
  // quiet watchlist, and they are lost outright if the process is killed rather
  // than asked to stop. That is how nearly an hour of checks went missing from
  // the Hub while the local file had every one of them.
  const s = sink();
  let now = 1_000_000;
  const log = new Activity({
    sink: s.sink,
    batchSize: 25,
    flushAfterMs: 120_000,
    now: () => now,
  });

  log.record({ kind: 'check', message: 'lonely' });
  assert.equal((await log.flush()).sent, 0, 'too new and too few');

  now += 121_000;
  assert.equal((await log.flush()).sent, 1, 'old enough now');
  assert.equal(s.got[0]!.message, 'lonely');
});

test('the clock restarts from the oldest line still waiting', async () => {
  const s = sink();
  let now = 1_000_000;
  const log = new Activity({ sink: s.sink, batchSize: 25, flushAfterMs: 60_000, now: () => now });

  log.record({ kind: 'check', message: 'first' });
  now += 61_000;
  await log.flush();
  assert.equal(s.got.length, 1);

  // A fresh line starts a fresh wait rather than inheriting the old one.
  log.record({ kind: 'check', message: 'second' });
  assert.equal((await log.flush()).sent, 0, 'the new line is not old yet');
  now += 61_000;
  assert.equal((await log.flush()).sent, 1);
});

test('a full batch still goes immediately, however new', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 3, flushAfterMs: 999_999 });
  for (let i = 0; i < 3; i += 1) log.record({ kind: 'check', message: `n${i}` });
  assert.equal((await log.flush()).sent, 3);
});

test('an empty queue is never a request', async () => {
  const s = sink();
  const log = new Activity({ sink: s.sink, batchSize: 1, flushAfterMs: 1000 });
  assert.deepEqual(await log.flush(true), { sent: 0, queued: 0 });
  assert.equal(s.got.length, 0);
});
