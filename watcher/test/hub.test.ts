/**
 * Talking to the Hub.
 *
 * The rule these tests exist to hold down:
 *
 *   Fail open on watching. Fail closed on spending.
 *
 * So: an unreachable Hub must never lose a reading, and must never let a
 * purchase through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, type ObservationOut, type RunOut } from '../src/hub.ts';

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string;
}

/** A fetch stand-in that records what it was asked and answers to script. */
function stubFetch(script: Array<{ status?: number; body?: unknown; throws?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)] ?? { status: 200, body: {} };
    i += 1;
    const u = String(url);
    calls.push({
      method: init?.method ?? 'GET',
      path: u.slice(u.indexOf('/', 'https://'.length)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
    });
    if (step.throws) throw new Error(step.throws);
    const status = step.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(step.body ?? {}),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const hubWith = (script: Parameters<typeof stubFetch>[0]) => {
  const { impl, calls } = stubFetch(script);
  return { hub: new Hub({ url: 'https://hub.test/', token: 'tok', fetchImpl: impl }), calls };
};

const observation = (listingId: number): ObservationOut => ({
  listingId,
  productName: 'Mega Evolution ETB',
  state: 'out',
  confidence: 'exact',
  price: null,
  sellerKind: 'retailer',
  sellerName: 'Target',
  availableQuantity: null,
  orderLimit: null,
  isPreOrder: false,
  releaseDate: null,
  imageUrl: '',
  note: '',
});

const run = (missionId: number): RunOut => ({
  missionId,
  outcome: 'in_stock',
  reason: 'in stock at $49.99 — this mission is watching only',
});

test('every request carries the ingest token', async () => {
  const { hub, calls } = hubWith([{ body: { missions: [] } }]);
  await hub.missions();
  assert.equal(calls[0]?.auth, 'Bearer tok');
});

test('a trailing slash on the Hub URL does not produce a double slash', async () => {
  const { hub, calls } = hubWith([{ body: { missions: [] } }]);
  await hub.missions();
  assert.equal(calls[0]?.path, '/api/missions/active');
});

test('missions() throws so the caller can decide — it does not swallow an outage', async () => {
  const { hub } = hubWith([{ throws: 'network down' }]);
  await assert.rejects(() => hub.missions(), /network down/);
});

test('an error body is surfaced rather than a bare status', async () => {
  const { hub } = hubWith([{ status: 401, body: { error: 'bad token' } }]);
  await assert.rejects(() => hub.missions(), /401: bad token/);
});

test('a body with no missions array is refused, not read as none', async () => {
  // This test used to assert the opposite, and it was wrong: silently
  // returning [] turns a broken answer into "you have nothing to watch",
  // which is indistinguishable from working. See AN EMPTY ANSWER IS NOT AN
  // EMPTY WATCHLIST below.
  const { hub } = hubWith([{ body: {} }]);
  await assert.rejects(() => hub.missions(), /without a missions list/);
});

test('a reading the Hub refused is kept, not dropped', async () => {
  // Fail open on watching. The page can catch up; a lost reading cannot.
  const { hub } = hubWith([{ throws: 'hub cold' }]);
  const result = await hub.report([observation(1)]);

  assert.equal(result.sent, 0);
  assert.equal(result.buffered, 1);
  assert.equal(hub.backlog, 1);
});

test('report() never throws, whatever the Hub does', async () => {
  const { hub } = hubWith([{ status: 500, body: { error: 'boom' } }]);
  await assert.doesNotReject(() => hub.report([observation(1)]));
});

test('buffered readings go out with the next successful report', async () => {
  const { impl, calls } = stubFetch([{ throws: 'down' }, { status: 200, body: {} }]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.report([observation(1)]);
  const second = await hub.report([observation(2)]);

  assert.equal(second.sent, 2, 'the buffered one goes with the new one');
  assert.equal(hub.backlog, 0);
  const sentIds = (calls[1]?.body as { observations: ObservationOut[] }).observations.map(
    (o) => o.listingId,
  );
  assert.deepEqual(sentIds, [1, 2], 'oldest first');
});

test('a run the Hub refused is kept and re-sent in order', async () => {
  const { impl, calls } = stubFetch([{ throws: 'down' }, { status: 200 }, { status: 200 }]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  assert.equal(await hub.recordRun(run(1)), false);
  assert.equal(hub.backlog, 1);

  assert.equal(await hub.recordRun(run(2)), true);
  assert.equal(hub.backlog, 0);
  assert.deepEqual(
    calls.slice(1).map((c) => (c.body as RunOut).missionId),
    [1, 2],
    'a run history out of order is worse than a late one',
  );
});

test('authorised() says no when the Hub cannot be reached', async () => {
  // Fail closed on spending: an unreachable Hub is exactly when a duplicate
  // purchase is most likely, because nothing knows what has been bought.
  const { hub } = hubWith([{ throws: 'timeout' }]);
  const verdict = await hub.authorised(1);

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /could not reach the Hub/);
});

test('authorised() says no when the Hub no longer lists the mission', async () => {
  const { hub } = hubWith([{ body: { missions: [] } }]);
  assert.equal((await hub.authorised(7)).ok, false);
});

test('authorised() says no for an unarmed mission or one with no ceiling', async () => {
  const armedNoCeiling = { id: 1, armed: true, ceiling: null };
  const unarmed = { id: 2, armed: false, ceiling: 60 };
  const { hub } = hubWith([{ body: { missions: [armedNoCeiling, unarmed] } }]);

  assert.match((await hub.authorised(1)).reason, /no price ceiling/);
  assert.match((await hub.authorised(2)).reason, /not armed/);
});

test('authorised() says yes only for an armed mission with a ceiling', async () => {
  const { hub } = hubWith([{ body: { missions: [{ id: 1, armed: true, ceiling: 59.99 }] } }]);
  assert.deepEqual(await hub.authorised(1), { ok: true, reason: '' });
});

test('a Hub with no token cannot authorise spending', async () => {
  const hub = new Hub({ url: 'https://hub.test', token: '' });
  const verdict = await hub.authorised(1);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no Hub configured/);
});

test('a buffer that is not emptying says why', async () => {
  // "1 queued to send" with no reason is the same silent failure in a nicer
  // coat. Whatever the Hub objected to has to reach the terminal.
  const { hub } = hubWith([{ status: 413, body: { error: 'payload too large' } }]);
  await hub.report([observation(1)]);

  assert.match(hub.lastError, /413/);
  assert.match(hub.lastError, /payload too large/);
});

test('the reason is cleared once the backlog goes out', async () => {
  const { impl } = stubFetch([{ throws: 'down' }, { status: 200 }]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.report([observation(1)]);
  assert.notEqual(hub.lastError, '', 'a stale reason is worse than none');
  await hub.report([observation(2)]);
  assert.equal(hub.lastError, '');
});

test('a refused run also leaves a reason behind', async () => {
  const { hub } = hubWith([{ status: 400, body: { error: 'need missionId' } }]);
  await hub.recordRun(run(1));
  assert.match(hub.lastError, /need missionId/);
});

// ── Riding out a Hub outage ──────────────────────────────────────────────────

const T = 1_700_000_000_000;
const activeBody = { missions: [{ id: 1, retailer: 'Target', armed: false, ceiling: null }] };

test('one flaky request is retried before anything is given up', async () => {
  // Observed in the wild: a request hangs until the abort fires, and the very
  // next one answers in under 100ms. That should cost a second, not a pass.
  const { impl, calls } = stubFetch([
    { body: activeBody },
    { throws: 'This operation was aborted' },
    { body: activeBody },
  ]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.missions(T);
  const second = await hub.missionsOrCached(T + 90_000);

  assert.equal(second.stale, false, 'a retry that worked is not a fallback');
  assert.equal(second.missions.length, 1);
  assert.equal(calls.length, 3, 'it tried again rather than reaching for the cache');
});

test('two failures in a row are reported with both timings, not as one', async () => {
  const { impl } = stubFetch([{ body: activeBody }, { throws: 'down' }, { throws: 'down' }]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.missions(T);
  const second = await hub.missionsOrCached(T + 90_000);

  assert.equal(second.stale, true);
  assert.match(second.reason, /down after \d+s; then down after \d+s/);
});

test('a cold Hub does not stop us watching what we were already watching', async () => {
  // This is the bug the first live run found: missions() throwing cost the
  // whole pass, which is failing CLOSED on watching — the opposite of the rule
  // this file is built on.
  const { impl } = stubFetch([
    { body: activeBody },
    { throws: 'This operation was aborted' },
    { throws: 'This operation was aborted' },
  ]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.missions(T);
  const second = await hub.missionsOrCached(T + 90_000);

  assert.equal(second.missions.length, 1, 'we keep looking at the page');
  assert.equal(second.stale, true);
  assert.match(second.reason, /aborted/);
  assert.match(second.reason, /90s ago/, 'and the terminal says how old the list is');
});

test('a watchlist stops being trusted once it is stale', async () => {
  // Long enough to ride out a cold start or a deploy; short enough that a
  // mission you paused is not still being polled an afternoon later.
  const { impl } = stubFetch([{ body: activeBody }, { throws: 'down' }]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.missions(T);
  const later = await hub.missionsOrCached(T + 16 * 60_000);

  assert.deepEqual(later.missions, [], 'better to skip a pass than watch a stale list');
  assert.equal(later.stale, true);
});

test('with no watchlist ever received there is nothing to fall back on', async () => {
  const { hub } = hubWith([{ throws: 'down' }]);
  const first = await hub.missionsOrCached(T);
  assert.deepEqual(first.missions, []);
  assert.equal(first.stale, true);
});

test('a live watchlist is never reported as stale', async () => {
  const { hub } = hubWith([{ body: activeBody }]);
  const result = await hub.missionsOrCached(T);
  assert.equal(result.stale, false);
  assert.equal(result.reason, '');
});

test('A STALE WATCHLIST STILL CANNOT SPEND', async () => {
  // The safety argument for caching at all. Watching from memory is fine;
  // buying from memory is how you buy something you already cancelled.
  const { impl } = stubFetch([{ body: activeBody }, { throws: 'down' }, { throws: 'down' }]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.missions(T);
  const cached = await hub.missionsOrCached(T + 60_000);
  assert.equal(cached.missions.length, 1, 'still watching');

  const verdict = await hub.authorised(1);
  assert.equal(verdict.ok, false, 'and still not spending');
  assert.match(verdict.reason, /could not reach the Hub/);
});

test('a request that takes too long is aborted rather than hanging the pass', async () => {
  // The mechanism that bit us in the wild: the abort is real, and whatever it
  // aborts surfaces as an error the caller can fall back from. The default is
  // 30s — proven by construction, not by waiting 30 seconds here.
  const hub = new Hub({
    url: 'https://hub.test',
    token: 'tok',
    timeoutMs: 20,
    fetchImpl: ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () =>
          reject(new Error('This operation was aborted')),
        );
      })) as unknown as typeof fetch,
  });

  await assert.rejects(() => hub.missions(), /aborted/);

  // …and the loop rides it out rather than losing the pass.
  const result = await hub.missionsOrCached();
  assert.equal(result.stale, true);
  assert.match(result.reason, /aborted/);
});

test('A 200 THAT IS NOT JSON IS AN ERROR, not a TypeError three frames away', async () => {
  // Vercel serves exactly this, with a 200, while a deployment swaps. Reading
  // `.missions` off it blows up somewhere unrelated; the deploy window is the
  // actual answer and the message should say so.
  const impl = (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => 'An error occurred with your deployment',
    }) as Response) as unknown as typeof fetch;
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await assert.rejects(() => hub.missions(), /not JSON/);
  await assert.rejects(() => hub.missions(), /An error occurred with your deployment/);
});

test('AN EMPTY ANSWER IS NOT AN EMPTY WATCHLIST', async () => {
  // The difference matters: "you have no missions" makes the Watcher go quiet
  // and look like it is working. An answer with no missions list is a broken
  // answer, and the loop should fall back to the list it already had.
  const impl = (async () =>
    ({ ok: true, status: 200, text: async () => '' }) as Response) as unknown as typeof fetch;
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await assert.rejects(() => hub.missions(), /without a missions list/);
});

test('a genuinely empty watchlist is still an empty watchlist', async () => {
  const { hub } = hubWith([{ body: { missions: [] } }]);
  assert.deepEqual(await hub.missions(), []);
});

// ── Settings travel with the watchlist ───────────────────────────────────────

test('settings arrive with the missions and are kept', async () => {
  const { hub } = hubWith([
    { body: { missions: [], settings: { taxRate: 0.0975, shippingAllowance: 9.99 } } },
  ]);
  await hub.missions();
  assert.deepEqual(hub.settings, { taxRate: 0.0975, shippingAllowance: 9.99 });
});

test('settings default to the safe direction before the Hub has spoken', async () => {
  // No tax estimate, and postage must be free. Both refuse rather than assume.
  const hub = new Hub({ url: 'https://hub.test', token: 'tok' });
  assert.deepEqual(hub.settings, { taxRate: 0, shippingAllowance: 0 });
});

test('A HALF-ANSWER DOES NOT SILENTLY RESET THE TAX RATE', async () => {
  // An older Hub, or a truncated response, must not quietly turn a 9.75% rate
  // into zero — that widens every ceiling by the tax and nothing says so.
  const { impl } = stubFetch([
    { body: { missions: [], settings: { taxRate: 0.0975, shippingAllowance: 9.99 } } },
    { body: { missions: [] } },
  ]);
  const hub = new Hub({ url: 'https://hub.test', token: 'tok', fetchImpl: impl });

  await hub.missions();
  await hub.missions();
  assert.equal(hub.settings.taxRate, 0.0975, 'the last known good rate stands');
});

test('a negative rate from the wire is clamped, not trusted', async () => {
  const { hub } = hubWith([
    { body: { missions: [], settings: { taxRate: -1, shippingAllowance: -5 } } },
  ]);
  await hub.missions();
  assert.deepEqual(hub.settings, { taxRate: 0, shippingAllowance: 0 });
});
