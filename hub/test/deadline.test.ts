/**
 * Getting in front of the platform's timeout.
 *
 * These tests exist because of a real 504: a wedged pooled connection meant
 * the function ran past its limit, Vercel wrote the error instead of the Hub,
 * and Phantom received plain text where it expected JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from '../src/deadline.ts';

const late = () => new Response('{"error":"too slow"}', { status: 503 });

test('work that finishes in time is what the caller gets', async () => {
  const res = await withDeadline(Promise.resolve(new Response('ok', { status: 200 })), {
    ms: 50,
    late,
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('work that overruns is answered for, in the shape the caller expects', async () => {
  const never = new Promise<Response>(() => {});
  const res = await withDeadline(never, { ms: 5, late });

  assert.equal(res.status, 503);
  assert.equal(JSON.parse(await res.text()).error, 'too slow');
});

test('THE CONNECTION IS DROPPED WHEN THE DEADLINE FIRES', async () => {
  // The whole point. Answering late and keeping the broken connection would
  // hand the same failure to the next request, and the one after that.
  let dropped = 0;
  await withDeadline(new Promise<Response>(() => {}), {
    ms: 5,
    late,
    onTimeout: () => {
      dropped += 1;
    },
  });
  assert.equal(dropped, 1);
});

test('a connection that answered in time is not thrown away', async () => {
  let dropped = 0;
  await withDeadline(Promise.resolve(new Response('ok')), {
    ms: 50,
    late,
    onTimeout: () => {
      dropped += 1;
    },
  });
  assert.equal(dropped, 0, 'reconnecting on every request would be its own outage');
});

test('the timer is cleared, so a fast answer does not hold the process open', async () => {
  // A serverless instance that will not exit is billed for, and a stray timer
  // is the usual reason.
  let cleared = 0;
  await withDeadline(Promise.resolve(new Response('ok')), {
    ms: 50,
    late,
    clearTimer: ((t: unknown) => {
      cleared += 1;
      clearTimeout(t as never);
    }) as typeof clearTimeout,
  });
  assert.equal(cleared, 1);
});

test('an abandoned query that later fails does not crash the instance', async () => {
  // The work is not cancellable — there is nothing to cancel a query with —
  // so it is abandoned. An abandoned promise that rejects with nobody left to
  // catch it takes the whole function down.
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown): void => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const doomed = new Promise<Response>((_resolve, reject) =>
      setTimeout(() => reject(new Error('connection terminated')), 10),
    );
    const res = await withDeadline(doomed, { ms: 2, late });
    assert.equal(res.status, 503);

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(unhandled, null, 'the abandoned rejection was swallowed');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
