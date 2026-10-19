/**
 * Getting an alert out: Discord reliably, and the owner's phone and inbox.
 *
 * Written 19 Oct 2026. Before it, a send had no timeout and no retry, rooms
 * were posted one after another inside a 12 second request, and a Discord
 * that answered 429 lost the card for good - the reading had already been
 * stored as "changed", so nothing would ever fire for it again.
 *
 * No network: every test here swaps `fetch` for a fake and puts it back.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import {
  deliver,
  sendLimits,
  asciiHeader,
  embedToText,
  buildStockEmbeds,
  DEFAULT_PUSH_KINDS,
  DEFAULT_EMAIL_KINDS,
  type Outlets,
} from '../src/notify.ts';
import type { Env } from '../src/types.ts';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  startedAt: number;
}

const realFetch = globalThis.fetch;
const realLimits = { ...sendLimits };
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(sendLimits, realLimits);
});

/** Swap fetch for `answer`, recording every call. */
function fakeFetch(
  answer: (url: string, init: RequestInit, n: number) => Promise<Response> | Response,
): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      headers: { ...(init.headers as Record<string, string>) },
      body: String(init.body ?? ''),
      startedAt: Date.now(),
    });
    return answer(String(url), init, sent.length);
  }) as typeof fetch;
  return sent;
}

/** A fetch that never answers until the caller gives up. */
function hangs(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

const ITEM = {
  name: 'Pokémon Mega Evolution — Elite Trainer Box…',
  retailer: 'Target',
  price: 49.99,
  msrp: 49.99,
  url: 'https://www.target.com/p/-/A-1',
  imageUrl: '',
  seller: 'retailer',
  sellerName: 'Target',
  quantity: 10,
  orderLimit: 2,
};

function outlets(over: Partial<Outlets> = {}): Outlets {
  return {
    rooms: { main: 'https://discord.test/main', byRetailer: {} },
    push: null,
    email: null,
    pushKinds: DEFAULT_PUSH_KINDS,
    emailKinds: DEFAULT_EMAIL_KINDS,
    ...over,
  };
}

const NOW = '2026-10-19T02:00:00.000Z';
const stock = (g: typeof ITEM[]) => buildStockEmbeds(g, NOW);

// ── Discord, reliably ────────────────────────────────────────────────────────

test('A DISCORD 429 IS RETRIED ONCE, AFTER THE WAIT IT ASKED FOR', async () => {
  const sent = fakeFetch((_u, _i, n) =>
    n === 1
      ? new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 })
      : new Response(null, { status: 204 }),
  );
  const r = await deliver(outlets(), 'stock', [ITEM], stock);
  assert.equal(sent.length, 2, 'the card is sent again rather than lost');
  assert.equal(r.discord, 1);
});

test('A 429 THAT ASKS FOR LONGER THAN THE REQUEST HAS IS NOT WAITED OUT', async () => {
  // Thirty seconds inside a twelve second deadline is a request that dies
  // with every other alert in it still unsent.
  const sent = fakeFetch(() => new Response(JSON.stringify({ retry_after: 30 }), { status: 429 }));
  const started = Date.now();
  const r = await deliver(outlets(), 'stock', [ITEM], stock);
  assert.equal(sent.length, 1);
  assert.equal(r.discord, 0);
  assert.ok(Date.now() - started < 1_000, 'and does not sit there pretending to');
});

test('A 429 RETRY-AFTER HEADER IS HONOURED TOO', async () => {
  const sent = fakeFetch((_u, _i, n) =>
    n === 1
      ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      : new Response(null, { status: 204 }),
  );
  await deliver(outlets(), 'stock', [ITEM], stock);
  assert.equal(sent.length, 2);
});

test('A DISCORD THAT NEVER ANSWERS IS GIVEN UP ON, NOT WAITED FOR', async () => {
  sendLimits.timeoutMs = 30;
  const sent = fakeFetch((_u, init) => hangs(init));
  // AbortSignal.timeout's timer is unref'd, and a fake fetch holds no socket,
  // so something has to keep the test's event loop alive while it fires.
  const keepAlive = setTimeout(() => {}, 5_000);
  const started = Date.now();
  const r = await deliver(outlets(), 'stock', [ITEM], stock);
  clearTimeout(keepAlive);
  assert.equal(sent.length, 1, 'a timeout is not a 429, so no retry');
  assert.equal(r.discord, 0);
  assert.ok(Date.now() - started < 2_000);
});

test('A FAILED SEND NEVER THROWS INTO THE REQUEST THAT RAISED IT', async () => {
  fakeFetch(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  const r = await deliver(outlets(), 'stock', [ITEM], stock);
  assert.equal(r.discord, 0);
});

test('DIFFERENT ROOMS ARE SENT AT THE SAME TIME, NOT ONE AFTER ANOTHER', async () => {
  // Every room starts before any room finishes. Sequential, three slow rooms
  // were three timeouts end to end inside a 12 second request.
  const finished: number[] = [];
  const sent = fakeFetch(async () => {
    await new Promise((r) => setTimeout(r, 40));
    finished.push(Date.now());
    return new Response(null, { status: 204 });
  });
  const out = outlets({
    rooms: {
      main: 'https://discord.test/main',
      byRetailer: { walmart: 'https://discord.test/walmart', pokemoncenter: 'https://discord.test/pkc' },
    },
  });
  const r = await deliver(out, 'stock', [
    ITEM,
    { ...ITEM, retailer: 'Walmart' },
    { ...ITEM, retailer: 'Pokémon Center' },
  ], stock);
  assert.equal(sent.length, 3, 'one post per room');
  assert.equal(r.discord, 3);
  const lastStart = Math.max(...sent.map((s) => s.startedAt));
  assert.ok(lastStart <= Math.min(...finished), 'all three were in flight together');
});

test('an alert with its own room ignores the shop routing', async () => {
  const sent = fakeFetch(() => new Response(null, { status: 204 }));
  await deliver(outlets(), 'bought', [ITEM], stock, { room: 'https://discord.test/wins' });
  assert.deepEqual(sent.map((s) => s.url), ['https://discord.test/wins']);
});

// ── The phone ────────────────────────────────────────────────────────────────

test('AN IN-STOCK ALERT RINGS THE PHONE, LOUDLY, AND OPENS THE PRODUCT', async () => {
  const sent = fakeFetch(() => new Response('{}', { status: 200 }));
  const r = await deliver(
    outlets({ rooms: { main: '', byRetailer: {} }, push: { server: 'https://ntfy.test/', topic: 'phantom-test-7q2x9k', token: 'tk_secret' } }),
    'stock',
    [ITEM],
    stock,
  );
  assert.equal(r.push, 1);
  assert.equal(sent.length, 1, 'no Discord room, so only the phone');
  const p = sent[0]!;
  assert.equal(p.url, 'https://ntfy.test/phantom-test-7q2x9k');
  assert.equal(p.headers.Priority, '5', 'a restock is the one that rings through');
  assert.equal(p.headers.Click, 'https://www.target.com/p/-/A-1');
  assert.equal(p.headers.Authorization, 'Bearer tk_secret');
  assert.match(p.headers.Title!, /^Pokemon Mega Evolution - Elite Trainer Box/);
  assert.match(p.headers.Title!, /^[\x20-\x7e]+$/, 'a header is ASCII or the send throws');
  assert.match(p.body, /Price: \$49\.99/);
});

test('A KIND NOT CHOSEN FOR THE PHONE DOES NOT RING IT', async () => {
  // The guard has to refuse something: the same alert, with stock unticked.
  const sent = fakeFetch(() => new Response('{}', { status: 200 }));
  await deliver(
    outlets({
      rooms: { main: '', byRetailer: {} },
      push: { server: 'https://ntfy.test', topic: 'phantom-test-7q2x9k' },
      pushKinds: ['bought'],
    }),
    'stock',
    [ITEM],
    stock,
  );
  assert.equal(sent.length, 0);
});

test('a batch of ten rings the phone three times at most', async () => {
  const sent = fakeFetch(() => new Response('{}', { status: 200 }));
  await deliver(
    outlets({ rooms: { main: '', byRetailer: {} }, push: { server: 'https://ntfy.test', topic: 'phantom-test-7q2x9k' } }),
    'stock',
    Array.from({ length: 10 }, (_, i) => ({ ...ITEM, name: `Box ${i}` })),
    stock,
  );
  assert.equal(sent.length, 3);
});

// ── The inbox ────────────────────────────────────────────────────────────────

test('A WIN IS EMAILED BY DEFAULT, AND AN IN-STOCK ALERT IS NOT', async () => {
  const sent = fakeFetch(() => new Response('{"id":"x"}', { status: 200 }));
  const out = outlets({
    rooms: { main: '', byRetailer: {} },
    email: { apiKey: 're_test', from: 'Phantom <alerts@example.com>', to: 'dan@example.com' },
  });
  await deliver(out, 'stock', [ITEM], stock);
  assert.equal(sent.length, 0, 'in-stock is over before the mail is read');

  const r = await deliver(out, 'bought', [ITEM], stock);
  assert.equal(r.email, 1);
  const mail = sent[0]!;
  assert.equal(mail.url, 'https://api.resend.com/emails');
  assert.equal(mail.headers.Authorization, 'Bearer re_test');
  const body = JSON.parse(mail.body);
  assert.deepEqual(body.to, ['dan@example.com']);
  assert.equal(body.from, 'Phantom <alerts@example.com>');
  assert.match(body.subject, /Elite Trainer Box/);
  assert.match(body.text, /https:\/\/www\.target\.com\/p\/-\/A-1/);
});

// ── The words ────────────────────────────────────────────────────────────────

test('A HEADER IS FOLDED TO ASCII RATHER THAN DROPPED', () => {
  assert.equal(asciiHeader('PRE-ORDER · Pokémon — Box…'), 'PRE-ORDER - Pokemon - Box...');
  assert.equal(asciiHeader('✅ ok'), 'ok', 'emoji go, the words stay');
});

test('a card becomes plain words, with Discord-only time tags made Central', () => {
  const t = embedToText({
    title: 'WAITING ROOM UP AT TARGET',
    url: 'https://www.target.com',
    description: '**Get in line yourself** — see [the shelf](https://x.test/a).',
    fields: [{ name: 'Seen', value: '<t:1760839740:t>' }],
    footer: { text: 'yours' },
  });
  assert.equal(t.title, 'WAITING ROOM UP AT TARGET');
  assert.equal(t.url, 'https://www.target.com');
  assert.match(t.body, /^Get in line yourself — see the shelf \(https:\/\/x\.test\/a\)\./);
  assert.match(t.body, /Seen: \d{1,2}:\d{2} [AP]M CT/);
  assert.doesNotMatch(t.body, /\*\*|<t:/);
});

test('A RESELLER CARD SAYS IT IS WITHIN THE CEILING', () => {
  const [e] = buildStockEmbeds(
    [{ ...ITEM, seller: 'marketplace', sellerName: 'Squeaks', price: 45, ceiling: 50 }],
    NOW,
  );
  assert.match(String(e!.description), /Third-party seller \(Squeaks\), within your \$50\.00 ceiling/);
  const [shop] = buildStockEmbeds([ITEM], NOW);
  assert.equal(shop!.description, undefined, 'the shop\u2019s own stock needs no such line');
});

// ── Settings ─────────────────────────────────────────────────────────────────

test('A PUSH TOPIC MUST BE LONG ENOUGH THAT NOBODY GUESSES IT', () => {
  assert.equal(store.validateSettings({ pushTopic: 'phantom-dan-7q2x9k' }), null);
  assert.equal(store.validateSettings({ pushTopic: '' }), null, 'blank turns it off');
  assert.match(String(store.validateSettings({ pushTopic: 'dan' })), /12 characters/);
  assert.match(String(store.validateSettings({ pushTopic: 'has spaces in it ok' })), /letters, numbers/);
  assert.match(String(store.validateSettings({ pushTopic: 'https://ntfy.sh/abc' })), /letters, numbers/);
  // The masked form the page is given cannot be saved back over the real one.
  assert.match(String(store.validateSettings({ pushTopic: '\u2022\u2022\u2022x9k' })), /letters, numbers/);
});

test('an email address is checked, and an alert kind must be one the app sends', () => {
  assert.equal(store.validateSettings({ emailTo: 'dan@example.com' }), null);
  assert.match(String(store.validateSettings({ emailTo: 'dan' })), /email/);
  assert.match(String(store.validateSettings({ emailTo: 'a@b.com, c@d.com' })), /email/);
  assert.equal(store.validateSettings({ pushKinds: ['stock', 'queue'] }), null);
  assert.match(String(store.validateSettings({ pushKinds: ['everything'] })), /not an alert/);
});

const TOKEN = 'Phantom-token';
const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
  APP_PASSWORD: 'pw',
};

async function call(
  db: TestDb,
  method: string,
  path: string,
  body?: unknown,
  e: Env = env,
): Promise<{ status: number; body: any; text: string }> {
  const res = await createHandler(db, e)(
    new Request(`https://hub.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* leave it */ }
  return { status: res.status, body: parsed, text };
}

test('UNSET MEANS THE DEFAULT CHOICES; SWITCHED ALL OFF STAYS OFF', async () => {
  const db = await TestDb.create();
  const fresh = await store.getSettings(db, 1);
  assert.deepEqual(fresh.pushKinds, [...DEFAULT_PUSH_KINDS]);
  assert.deepEqual(fresh.emailKinds, [...DEFAULT_EMAIL_KINDS]);
  const off = await store.setSettings(db, 1, { pushKinds: [], emailKinds: [] });
  assert.deepEqual(off.pushKinds, [], 'an empty list is a choice, not a missing one');
  assert.deepEqual(off.emailKinds, []);
});

test('THE PUSH TOPIC NEVER LEAVES THE APP IN FULL', async () => {
  // Not to the page, which people screenshot, and not to Phantom, which logs.
  const db = await TestDb.create();
  const topic = 'phantom-dan-7q2x9k4m';
  const saved = await call(db, 'POST', '/api/settings', { pushTopic: topic });
  assert.equal(saved.status, 200);
  for (const path of ['/api/settings', '/api/dashboard', '/api/missions/active']) {
    const r = await call(db, 'GET', path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, new RegExp(topic), `${path} carried the topic`);
  }
  const dash = await call(db, 'GET', '/api/dashboard');
  assert.equal(dash.body.push, true, 'it does say that push is on');
  assert.match(dash.body.settings.pushTopic, /k4m$/, 'only the last three letters');
  // And it really is saved, underneath the mask.
  assert.equal((await store.getSettings(db, 1)).pushTopic, topic);
});

test('THE TEST BUTTON REACHES THE PHONE WITH NO DISCORD SET UP, AND SAYS SO PER CHANNEL', async () => {
  const db = await TestDb.create();
  await store.setSettings(db, 1, { pushTopic: 'phantom-dan-7q2x9k4m', emailTo: 'dan@example.com' });
  const sent = fakeFetch(() => new Response('{}', { status: 200 }));
  const r = await call(db, 'POST', '/api/notify/test', undefined, { ...env, NTFY_URL: 'https://ntfy.test' });
  assert.equal(r.body.configured, true);
  assert.equal(r.body.sent, true);
  assert.equal(r.body.rooms, 0);
  assert.equal(r.body.push, true);
  assert.equal(r.body.email, null, 'no Resend key on the app, so email is not set up');
  assert.deepEqual(sent.map((s) => s.url), ['https://ntfy.test/phantom-dan-7q2x9k4m']);
});

test('A RESTOCK RINGS THE OWNER\u2019S PHONE EVEN WITH NO DISCORD ROOM', async () => {
  // Before 19 Oct every alert was behind "is there a Discord webhook". Push
  // has to stand on its own, or a muted Discord is a silent phone too.
  const db = await TestDb.create();
  const e = { ...env, NTFY_URL: 'https://ntfy.test' };
  const product = await call(db, 'POST', '/api/products', { name: 'Mega Evolution Elite Trainer Box', msrp: 49.99 });
  const listing = await call(db, 'POST', '/api/listings', {
    productKey: product.body.product.key,
    url: 'https://www.target.com/p/pokemon-tin/-/A-1012644666',
  });
  const listingId = listing.body.listing.id;
  await call(db, 'POST', '/api/missions', { listingId, label: 'ETB' });
  await store.setSettings(db, 1, { pushTopic: 'phantom-dan-7q2x9k4m' });

  // A listing's first reading is never announced (store.recordObservation
  // marks it isFirst), so show it out of stock first, then bring it in.
  await call(db, 'POST', '/observations', {
    observations: [{
      listingId, state: 'out', confidence: 'exact', price: 49.99, sellerKind: 'retailer',
      sellerName: 'Target', availableQuantity: 0, orderLimit: 2, isPreOrder: false,
      releaseDate: null, imageUrl: '', note: '',
    }],
  }, e);
  const sent = fakeFetch(() => new Response('{}', { status: 200 }));
  const r = await call(db, 'POST', '/observations', {
    observations: [{
      listingId, state: 'in', confidence: 'exact', price: 49.99, sellerKind: 'retailer',
      sellerName: 'Target', availableQuantity: 10, orderLimit: 2, isPreOrder: false,
      releaseDate: null, imageUrl: '', note: '',
    }],
  }, e);
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://ntfy.test/phantom-dan-7q2x9k4m');
  assert.equal(sent[0]!.headers.Priority, '5');
});
