/**
 * The two ends of the activity log over HTTP.
 *
 * The export is the interesting one, because it is the moment this data leaves
 * for somebody else. Everything it contains has supposedly been scrubbed
 * already, by code running on a different machine that this Hub cannot verify.
 * These tests are what make the export's promise a property rather than a
 * hope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import type { Env } from '../src/types.ts';

const TOKEN = 'watcher-token-9f2c8a1b';
const PASSWORD = 'correct-horse-battery';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
  APP_PASSWORD: PASSWORD,
};

const call = async (
  db: TestDb,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; body: any }> => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await createHandler(db, env)(
    new Request(`https://hub.test${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, text, body };
};

const line = (over: Partial<store.ActivityIn> = {}): store.ActivityIn => ({
  kind: 'check',
  retailer: 'target',
  message: 'out, $49.99',
  ms: 1180,
  ...over,
});

test('the Watcher can post a batch and gets a count back', async () => {
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/activity', {
    token: TOKEN,
    body: { lines: [line(), line({ message: 'second' })] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.written, 2);
});

test('posting activity without a token gets nowhere', async () => {
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/activity', { body: { lines: [line()] } });
  assert.equal(res.status, 401);
});

test('a body that is not a batch is refused in words', async () => {
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/activity', { token: TOKEN, body: { nope: true } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /lines/);
});

test('a single request cannot post a million rows', async () => {
  const db = await TestDb.create();
  const res = await call(db, 'POST', '/api/activity', {
    token: TOKEN,
    body: { lines: Array.from({ length: 900 }, () => line()) },
  });
  assert.equal(res.body.written, 500, 'capped, and honest about how many landed');
});

test('ingest prunes, so retention needs no scheduler', async () => {
  // There is no cron on this plan. If retention only happened on a schedule it
  // would never happen at all, and the log would be the whole database inside
  // a month.
  const db = await TestDb.create();
  const old = new Date(Date.now() - (store.ACTIVITY_DAYS + 2) * 86400_000).toISOString();
  await store.recordActivity(db, 1, [line({ at: old })]);

  const res = await call(db, 'POST', '/api/activity', { token: TOKEN, body: { lines: [line()] } });
  assert.equal(res.body.pruned, 1);
});

// ── the export ───────────────────────────────────────────────────────────────

test('THE EXPORT SCRUBS AGAIN ON THE WAY OUT', async () => {
  // The line below was posted raw, as a Watcher on an old version or a curl by
  // hand would post it. The Hub cannot verify what happened on that machine,
  // so it does not assume anything happened at all.
  const db = await TestDb.create();
  await call(db, 'POST', '/api/activity', {
    token: TOKEN,
    body: {
      lines: [
        line({
          level: 'error',
          message: 'failed at https://www.target.com/p/x?visitor_id=018F2A9C3B4D5E6F7A8B&zip=37067',
          detail: 'from C:\\Users\\danru\\Pokemon\\watcher, as someone@example.com',
        }),
      ],
    },
  });

  const res = await call(db, 'GET', '/api/activity/export', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('018F2A9C3B4D5E6F7A8B'), 'visitor id left the building');
  assert.ok(!res.text.includes('37067'), 'postcode left the building');
  assert.ok(!res.text.includes('danru'), 'account name left the building');
  assert.ok(!res.text.includes('someone@example.com'), 'email left the building');
  assert.ok(res.text.includes('target.com'), 'and the diagnosis survived');
});

test("THE EXPORT NEVER CONTAINS THIS HUB'S OWN SECRETS", async () => {
  // The case no pattern catches: APP_PASSWORD is an ordinary phrase. Removed
  // by value, because the Hub is the one place that knows what it is.
  const db = await TestDb.create();
  await call(db, 'POST', '/api/activity', {
    token: TOKEN,
    body: { lines: [line({ kind: 'hub', message: `401 with ${TOKEN}, password ${PASSWORD}` })] },
  });

  const res = await call(db, 'GET', '/api/activity/export', { token: TOKEN });
  assert.ok(!res.text.includes(TOKEN), 'the ingest token');
  assert.ok(!res.text.includes(PASSWORD), 'the dashboard password');
});

test('the export says out loud whether anything still looks sensitive', async () => {
  const db = await TestDb.create();
  await call(db, 'POST', '/api/activity', { token: TOKEN, body: { lines: [line()] } });
  const res = await call(db, 'GET', '/api/activity/export', { token: TOKEN });
  assert.deepEqual(res.body.warnings, [], 'a clean bundle warns about nothing');
});

test('the export carries the shape of the trouble, not only the lines', async () => {
  // What you want first: which retailer, how often it failed, how slow it was.
  // Reading ten thousand lines to work that out is not a diagnosis.
  const db = await TestDb.create();
  await call(db, 'POST', '/api/activity', {
    token: TOKEN,
    body: {
      lines: [
        line({ retailer: 'target', level: 'error', ms: 900 }),
        line({ retailer: 'target', ms: 1100, state: 'out' }),
        line({ retailer: 'walmart', ms: 400, state: 'in' }),
      ],
    },
  });

  const res = await call(db, 'GET', '/api/activity/export', { token: TOKEN });
  const target = res.body.summary.find((s: { retailer: string }) => s.retailer === 'target');
  assert.equal(target.checks, 2);
  assert.equal(target.failures, 1);
  assert.equal(res.body.counts.lines, 3);
  assert.equal(res.body.counts.byLevel.error, 1);
});

test('the export arrives as a file, named for the day it was taken', async () => {
  const db = await TestDb.create();
  const res = await createHandler(db, env)(
    new Request('https://hub.test/api/activity/export', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
  );
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="watcher-activity-\d{4}-\d{2}-\d{2}\.json"/);
});

test('the window is bounded, however large a number is asked for', async () => {
  const db = await TestDb.create();
  const res = await call(db, 'GET', '/api/activity/export?hours=999999', { token: TOKEN });
  assert.equal(res.body.windowHours, store.ACTIVITY_DAYS * 24);
});

test('nonsense in the window falls back rather than failing', async () => {
  const db = await TestDb.create();
  const res = await call(db, 'GET', '/api/activity/export?hours=banana', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.body.windowHours, 24);
});

test('MY EXPORT DOES NOT CONTAIN YOUR LOG', async () => {
  const db = await TestDb.create();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'other') ON CONFLICT DO NOTHING");
  await store.recordActivity(db, 2, [line({ message: 'somebody else entirely' })]);
  await store.recordActivity(db, 1, [line({ message: 'mine' })]);

  const res = await call(db, 'GET', '/api/activity/export', { token: TOKEN });
  assert.ok(!res.text.includes('somebody else entirely'));
  assert.ok(res.text.includes('mine'));
});
