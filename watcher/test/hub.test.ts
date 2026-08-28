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

test('a missing missions array reads as none, not as a crash', async () => {
  const { hub } = hubWith([{ body: {} }]);
  assert.deepEqual(await hub.missions(), []);
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
