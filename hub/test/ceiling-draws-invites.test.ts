/**
 * 19 Oct 2026: "dropped under your ceiling", the drawing reminders that run on
 * Phantom's check-ins, the shared drawing rooms belonging to the owner's
 * Phantom alone, and Best Buy's invite window.
 *
 * Every new column here is added by hand by the owner, so half of these tests
 * DROP the column first and prove the old schema still takes readings.
 * No network: fetch is swapped for a fake in every test that could send.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import * as store from '../src/store.ts';
import { hashToken } from '../src/auth.ts';
import { identifyListing } from '../src/parsers/identify.ts';
import {
  buildDrawEmbeds,
  buildCeilingEmbeds,
  buildInviteEmbed,
  DEFAULT_PUSH_KINDS,
  DEFAULT_EMAIL_KINDS,
} from '../src/notify.ts';
import type { Env } from '../src/types.ts';

const TOKEN = 'Phantom-token';
const TOPIC = 'phantom-dan-7q2x9k4m';
const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
  INGEST_TOKEN: TOKEN,
  APP_PASSWORD: 'pw',
  NTFY_URL: 'https://ntfy.test',
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Sent { url: string; headers: Record<string, string>; body: string }
function fakeFetch(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      headers: { ...(init.headers as Record<string, string>) },
      body: String(init.body ?? ''),
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return sent;
}
const pushes = (sent: Sent[]) => sent.filter((s) => s.url.startsWith('https://ntfy.test/'));

async function call(
  db: TestDb, method: string, path: string, body?: unknown,
  e: Env = env, token = TOKEN,
): Promise<{ status: number; body: any }> {
  const res = await createHandler(db, e)(
    new Request(`https://hub.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* leave it */ }
  return { status: res.status, body: parsed };
}

async function withMission(url: string, ceiling: number | null = 45) {
  const db = await TestDb.create();
  const product = await call(db, 'POST', '/api/products', { name: 'Mega Evolution Elite Trainer Box', msrp: 49.99 });
  const listing = await call(db, 'POST', '/api/listings', { productKey: product.body.product.key, url });
  const listingId = listing.body.listing.id;
  const mission = await call(db, 'POST', '/api/missions', {
    listingId, label: 'ETB', ...(ceiling === null ? {} : { ceiling }),
  });
  await store.setSettings(db, 1, { pushTopic: TOPIC });
  return { db, listingId, missionId: mission.body.mission.id as number };
}

const TARGET = 'https://www.target.com/p/pokemon-tin/-/A-1012644666';
const BESTBUY = 'https://www.bestbuy.com/site/pokemon-tcg-mega-evolution-elite-trainer-box/6606082.p?skuId=6606082';

const reading = (listingId: number, over: Record<string, unknown> = {}) => ({
  listingId, state: 'in', confidence: 'exact', price: 60, sellerKind: 'retailer',
  sellerName: 'Target', availableQuantity: 10, orderLimit: 2, isPreOrder: false,
  releaseDate: null, imageUrl: '', note: '', ...over,
});
const post = (db: TestDb, ...obs: unknown[]) => call(db, 'POST', '/observations', { observations: obs });

// ── Dropped under your ceiling ───────────────────────────────────────────────

test('A PRICE FALLING UNDER THE CEILING ON A LISTING ALREADY IN STOCK RINGS ONCE', async () => {
  // The hole: out -> in was the only edge, so a deal arriving on a listing
  // already in stock said nothing at all.
  const { db, listingId } = await withMission(TARGET, 45);
  await post(db, reading(listingId, { state: 'out' }));
  await post(db, reading(listingId, { price: 60 })); // in stock, over the ceiling

  const sent = fakeFetch();
  const r = await post(db, reading(listingId, { price: 44 }));
  assert.equal(r.status, 200);
  const rang = pushes(sent);
  assert.equal(rang.length, 1, 'one ring');
  assert.match(rang[0]!.headers.Title!, /^UNDER YOUR CEILING/);
  assert.match(rang[0]!.body, /Dropped to \$44\.00 — within your \$45\.00 ceiling/);
  assert.equal(rang[0]!.headers.Priority, '5', 'a buy decision with a clock on it');

  // Same price again is not news, and nor is a flap back over and under.
  const again = fakeFetch();
  await post(db, reading(listingId, { price: 44 }));
  await post(db, reading(listingId, { price: 60 }));
  await post(db, reading(listingId, { price: 43 }));
  assert.equal(pushes(again).length, 0, 'claimed for the cooldown, so a flapping buy box says it once');
});

test('A BUY BOX MOVING TO A RESELLER UNDER THE CEILING IS THE SAME EDGE', async () => {
  const { db, listingId } = await withMission(TARGET, 45);
  await post(db, reading(listingId, { state: 'out' }));
  await post(db, reading(listingId, { price: 60 }));
  const sent = fakeFetch();
  await post(db, reading(listingId, { price: 40, sellerKind: 'marketplace', sellerName: 'Squeaks Game World LLC' }));
  const rang = pushes(sent);
  assert.equal(rang.length, 1);
  assert.match(rang[0]!.body, /Squeaks Game World LLC/, 'and it names who is selling');
});

test('COMING INTO STOCK UNDER THE CEILING IS THE IN-STOCK CARD, NOT TWO CARDS', async () => {
  const { db, listingId } = await withMission(TARGET, 45);
  await post(db, reading(listingId, { state: 'out' }));
  const sent = fakeFetch();
  await post(db, reading(listingId, { price: 40 }));
  // A spike and a dip straight back: the in-stock card already said "within
  // your ceiling", and it counts as having said it.
  await post(db, reading(listingId, { price: 60 }));
  await post(db, reading(listingId, { price: 44 }));
  const rang = pushes(sent);
  assert.equal(rang.length, 1, 'the in-stock card only');
  assert.doesNotMatch(rang[0]!.headers.Title!, /UNDER YOUR CEILING/);
});

test('A SELLER NOBODY COULD NAME IS NEVER "WITHIN YOUR CEILING"', () => {
  const before = { state: 'in', price: 60, sellerKind: 'retailer' };
  assert.equal(store.droppedUnderCeiling(before, { state: 'in', price: 30, sellerKind: 'unknown' }, 45), false);
  assert.equal(store.droppedUnderCeiling(before, { state: 'in', price: 30, sellerKind: 'retailer' }, null), false,
    'and no ceiling means nothing to be under');
  assert.equal(store.droppedUnderCeiling(before, { state: 'in', price: 45, sellerKind: 'retailer' }, 45), true,
    'at the ceiling is within it');
  assert.equal(store.droppedUnderCeiling({ state: 'out', price: 60, sellerKind: 'retailer' },
    { state: 'in', price: 40, sellerKind: 'retailer' }, 45), false, 'out -> in is the in-stock card’s');
});

test('WITHOUT THE NEW COLUMN, READINGS STILL LAND AND THE ALERT JUST WAITS', async () => {
  // The owner runs the SQL by hand. Until he does, /observations must work
  // exactly as before: no 500, no per-item error, the price stored.
  const { db, listingId } = await withMission(TARGET, 45);
  await db.query('ALTER TABLE missions DROP COLUMN ceiling_alert_at');
  await post(db, reading(listingId, { state: 'out' }));
  await post(db, reading(listingId, { price: 60 }));
  const sent = fakeFetch();
  const r = await post(db, reading(listingId, { price: 44 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.failed, 0, 'not a single reading failed');
  assert.equal(pushes(sent).length, 0, 'and the new alert stayed quiet');
  const [ws] = await db.query<{ price: unknown }>('SELECT price FROM watch_state WHERE listing_id = $1', [listingId]);
  assert.equal(Number(ws!.price), 44);
});

test('THE CEILING CARD SAYS WHAT MOVED, IN ITS FIRST LINE', () => {
  const [card] = buildCeilingEmbeds([{
    name: 'ETB', retailer: 'Walmart', price: 41.5, msrp: 49.99, url: 'https://x.test', imageUrl: '',
    seller: 'marketplace', sellerName: 'Rares Market', quantity: null, orderLimit: null, ceiling: 45,
  }], new Date().toISOString());
  assert.match(String(card!.title), /^UNDER YOUR CEILING · ETB/);
  assert.match(card!.description!, /^Dropped to \$41\.50 — within your \$45\.00 ceiling\. Sold by Rares Market, not Walmart\./);
});

test('THE NEW KINDS RING BY DEFAULT, AND "DRAWING ENDED" GOES TO THE INBOX', () => {
  for (const k of ['ceiling', 'inviteOpen', 'inviteReminder', 'drawEve'] as const) {
    assert.ok(DEFAULT_PUSH_KINDS.includes(k), k);
  }
  assert.ok(DEFAULT_EMAIL_KINDS.includes('drawEnded'));
});

// ── Drawings: reminders on the clock, and whose rooms they are ───────────────

const draw = (over: Record<string, unknown> = {}) => ({
  externalId: '21009455186',
  name: 'Pokémon TCG: 30th Celebration ex Box Bundle',
  url: 'https://www.walmart.com/ip/x/21009455186',
  price: 69.49, orderLimit: 3, phase: 'announced',
  windowLabel: 'Drawing starts', windowText: 'Oct 21, 2:00pm PDT',
  windowAt: new Date(Date.now() + 10 * 3600_000).toISOString(),
  ...over,
});

test('THE DAY-BEFORE REMINDER FIRES ONCE, FOR A DRAWING KNOWN MORE THAN A DAY AHEAD', async () => {
  const db = await TestDb.create();
  await store.recordDrawings(db, 1, 'Walmart', [draw()]);
  // Just announced ten hours out: the announced card was the news.
  assert.deepEqual(await store.claimEveDrawings(db, 1), []);

  await db.query("UPDATE drawings SET announced_at = now() - INTERVAL '3 days'");
  const eve = await store.claimEveDrawings(db, 1);
  assert.equal(eve.length, 1);
  assert.deepEqual(await store.claimEveDrawings(db, 1), [], 'and once');
});

test('"DRAWING ENDED" IS SAID ONCE, AND NOT FOR ONE THAT WAS OVER WHEN FIRST SEEN', async () => {
  const db = await TestDb.create();
  await store.recordDrawings(db, 1, 'Walmart', [draw(), draw({ externalId: 'old', phase: 'ended', windowLabel: 'Drawing ended' })]);
  // Ended within the same minute it was first seen counts as "over on arrival".
  await db.query("UPDATE drawings SET first_seen_at = now() - INTERVAL '2 days' WHERE external_id = '21009455186'");
  await store.recordDrawings(db, 1, 'Walmart', [draw({ phase: 'ended', windowLabel: 'Drawing ended' })]);

  const ended = await store.claimEndedDrawings(db, 1);
  assert.deepEqual(ended.map((d) => d.externalId), ['21009455186']);
  assert.deepEqual(await store.claimEndedDrawings(db, 1), []);

  const [card] = buildDrawEmbeds([{ ...draw(), retailer: 'Walmart' } as never], new Date().toISOString(), 'ended');
  assert.match(String(card!.title), /^DRAWING ENDED · /);
  assert.match(card!.footer!.text, /watch your email/i);
});

test('WITHOUT THE NEW DRAWING COLUMNS THE REMINDERS ARE EMPTY, NOT ERRORS', async () => {
  const db = await TestDb.create();
  await db.query('ALTER TABLE drawings DROP COLUMN eve_alert_at');
  await db.query('ALTER TABLE drawings DROP COLUMN ended_alert_at');
  await store.recordDrawings(db, 1, 'Walmart', [draw()]);
  assert.deepEqual(await store.claimEveDrawings(db, 1), []);
  assert.deepEqual(await store.claimEndedDrawings(db, 1), []);
  const r = await call(db, 'POST', '/api/drawings', { retailer: 'Walmart', drawings: [draw()] });
  assert.equal(r.status, 200);
});

test('A CLOSING REMINDER RIDES ON ANY CHECK-IN, NOT ONLY ON A DRAWINGS READ', async () => {
  // The drawings page is read every half hour and not at all while Walmart
  // stands down from a wall. The activity post comes every pass.
  const db = await TestDb.create();
  await store.setSettings(db, 1, { pushTopic: TOPIC });
  await store.recordDrawings(db, 1, 'Walmart', [draw({
    phase: 'open', windowLabel: 'Drawing ends', windowText: 'today, 3:00pm PDT',
    windowAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  })]);
  const sent = fakeFetch();
  const r = await call(db, 'POST', '/api/activity', { lines: [] });
  assert.equal(r.status, 200);
  const rang = pushes(sent);
  assert.equal(rang.length, 1);
  assert.match(rang[0]!.headers.Title!, /^DRAWING CLOSING/);
});

test('A BADGE FLICKERING BACK TO LAST WEEK’S START DOES NOT REOPEN LAST WEEK’S DRAWING', async () => {
  // Phantom now calls a drawing open from a start time that has passed. That
  // must not undo an ending: a new cycle needs a time after the old end.
  const db = await TestDb.create();
  const start = new Date(Date.now() - 5 * 3600_000).toISOString();
  await store.recordDrawings(db, 1, 'Walmart', [draw({ phase: 'open', windowAt: start })]);
  await store.recordDrawings(db, 1, 'Walmart', [draw({ phase: 'ended', windowLabel: 'Drawing ended', windowAt: start })]);
  const [again] = await store.recordDrawings(db, 1, 'Walmart', [draw({ phase: 'open', windowAt: start })]);
  assert.equal(again!.justOpened, false);
  assert.ok(again!.row.endedAt, 'still ended');

  // A genuinely new window on the same item, with a later time, is new.
  const later = new Date(Date.now() + 3 * 3600_000).toISOString();
  const [reborn] = await store.recordDrawings(db, 1, 'Walmart', [draw({ phase: 'open', windowLabel: 'Drawing ends', windowAt: later })]);
  assert.equal(reborn!.justOpened, true);
});

test('ONLY THE OWNER’S PHANTOM SPEAKS IN THE SHARED DRAWING ROOMS', async () => {
  // A tester's Phantom read the same drawings page and posted every card a
  // second time into the same channel.
  const db = await TestDb.create();
  await db.query("INSERT INTO users (id, handle) VALUES (2, 'tester') ON CONFLICT DO NOTHING");
  await store.setUserTokenById(db, 2, await hashToken('tester-token'));
  const e = { ...env, DISCORD_WEBHOOK_URL: 'https://discord.test/main' };

  const sent = fakeFetch();
  const theirs = await call(db, 'POST', '/api/drawings', { retailer: 'Walmart', drawings: [draw()] }, e, 'tester-token');
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.announced, 1, 'recorded and judged for them');
  assert.equal(sent.filter((s) => s.url.startsWith('https://discord.test/')).length, 0, 'but not posted to the room');

  const repeat = await call(db, 'POST', '/api/drawings/announce', {}, e, 'tester-token');
  assert.equal(repeat.status, 403, 'nor can they re-announce into it');

  // The owner's still goes. A guard that only passes on silence is a comment.
  const ours = await call(db, 'POST', '/api/drawings', { retailer: 'Walmart', drawings: [draw()] }, e);
  assert.equal(ours.status, 200);
  assert.equal(sent.filter((s) => s.url.startsWith('https://discord.test/')).length, 1);
});

// ── Best Buy ─────────────────────────────────────────────────────────────────

test('a Best Buy product link is read, and a category link is refused', () => {
  const got = identifyListing(BESTBUY);
  assert.equal(got?.retailer, 'Best Buy');
  assert.equal(got?.externalId, '6606082');
  assert.equal(identifyListing('https://www.bestbuy.com/site/toys/pokemon/pcmcat1234.c?id=pcmcat1234'), null);
});

test('BEST BUY IS NOT HANDED TO PHANTOM UNTIL IT IS SWITCHED ON', async () => {
  // Filtered in the app as well as on the machine: a Phantom older than this
  // switch would otherwise open bestbuy.com pages it has no reader for.
  const { db } = await withMission(BESTBUY, null);
  const off = await call(db, 'GET', '/api/missions/active');
  assert.deepEqual(off.body.missions, []);
  assert.deepEqual(off.body.settings.enabledRetailers, []);

  await call(db, 'POST', '/api/settings', { enabledRetailers: ['Best Buy'] });
  const on = await call(db, 'GET', '/api/missions/active');
  assert.equal(on.body.missions.length, 1);
  assert.equal(on.body.missions[0].retailer, 'Best Buy');
  assert.deepEqual(on.body.settings.enabledRetailers, ['Best Buy'], 'and Phantom is told too');

  assert.match(String(store.validateSettings({ enabledRetailers: ['Target'] })), /not a shop that needs switching on/);
});

test('AN OPEN INVITE WINDOW RINGS ONCE PER WINDOW, URGENTLY', async () => {
  const { db, listingId } = await withMission(BESTBUY, null);
  const bb = (invite: unknown): Record<string, unknown> => reading(listingId, { state: 'out', sellerKind: 'unknown', sellerName: '', price: 49.99, invite });
  await post(db, bb(null));

  const sent = fakeFetch();
  await post(db, bb('open'));
  await post(db, bb('open'));
  let rang = pushes(sent);
  assert.equal(rang.length, 1, 'once, though the page says it on every read');
  assert.match(rang[0]!.headers.Title!, /^INVITE WINDOW OPEN/);
  assert.equal(rang[0]!.headers.Priority, '5');
  assert.match(rang[0]!.body, /Phantom never asks for you/);

  // The window closes and opens again: news again.
  await post(db, bb(null));
  await post(db, bb('open'));
  rang = pushes(sent);
  assert.equal(rang.length, 2);

  // A reading from a Phantom that sends no invite field never clears it.
  const quiet = fakeFetch();
  const { invite: _x, ...old } = bb(null);
  await post(db, old);
  await post(db, bb('open'));
  assert.equal(pushes(quiet).length, 0);
});

test('"I GOT THE INVITE" STARTS 24 HOURS, AND ONLY ON A BEST BUY LISTING', async () => {
  const { db, missionId } = await withMission(BESTBUY, null);
  const r = await call(db, 'POST', `/api/missions/${missionId}/invite`, { received: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.inviteAt);
  assert.equal(Date.parse(r.body.expiresAt) - Date.parse(r.body.inviteAt), 24 * 3600_000);
  const dash = await call(db, 'GET', '/api/dashboard');
  assert.equal(dash.body.missions[0].inviteAt, r.body.inviteAt, 'and the page can count it down');

  const off = await call(db, 'POST', `/api/missions/${missionId}/invite`, { received: false });
  assert.equal(off.body.inviteAt, null);

  const t = await withMission(TARGET, null);
  const wrong = await call(t.db, 'POST', `/api/missions/${t.missionId}/invite`, {});
  assert.equal(wrong.status, 400);
});

test('BEFORE THE SQL, "I GOT THE INVITE" SAYS WHAT IS MISSING INSTEAD OF FAILING', async () => {
  const { db, missionId } = await withMission(BESTBUY, null);
  await db.query('ALTER TABLE missions DROP COLUMN invite_at');
  const r = await call(db, 'POST', `/api/missions/${missionId}/invite`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /database update/);
  assert.equal((await call(db, 'GET', '/api/dashboard')).status, 200, 'and the page still loads');
  assert.deepEqual(await store.claimInviteReminders(db, 1), []);
});

test('INVITE REMINDERS COME AT 12 H, 2 H AND 30 MIN LEFT, EACH ONCE, NEVER IN A BURST', async () => {
  const { db, missionId } = await withMission(BESTBUY, null);
  await store.setInviteReceived(db, 1, missionId, true);
  assert.deepEqual(await store.claimInviteReminders(db, 1), [], 'nothing due with 24 hours left');

  await db.query("UPDATE missions SET invite_at = now() - INTERVAL '12 hours 1 minute' WHERE id = $1", [missionId]);
  const twelve = await store.claimInviteReminders(db, 1);
  assert.equal(twelve.length, 1);
  assert.ok(twelve[0]!.minutesLeft <= 12 * 60 && twelve[0]!.minutesLeft > 11 * 60);
  assert.deepEqual(await store.claimInviteReminders(db, 1), [], 'once');

  // Nothing checked in for hours: the 2-hour moment passed unseen. The next
  // check-in sends the 30-minute one, not both at once.
  await db.query("UPDATE missions SET invite_at = now() - INTERVAL '23 hours 40 minutes' WHERE id = $1", [missionId]);
  const last = await store.claimInviteReminders(db, 1);
  assert.equal(last.length, 1);
  assert.ok(last[0]!.minutesLeft <= 30);
  assert.deepEqual(await store.claimInviteReminders(db, 1), [], 'and that was the last');

  const [card] = [buildInviteEmbed({ ...last[0]!, retailer: 'Best Buy' }, new Date().toISOString(), 'reminder')];
  assert.match(String(card.title), /^INVITE RUNS OUT IN \d+ MINUTES/);
  assert.match(card.footer!.text, /while Phantom is running/);
});

test('AN INVITE REMINDER REACHES THE PHONE ON A CHECK-IN', async () => {
  const { db, missionId } = await withMission(BESTBUY, null);
  await store.setInviteReceived(db, 1, missionId, true);
  await db.query("UPDATE missions SET invite_at = now() - INTERVAL '22 hours 5 minutes' WHERE id = $1", [missionId]);
  const sent = fakeFetch();
  await call(db, 'POST', '/api/activity', { lines: [] });
  const rang = pushes(sent);
  assert.equal(rang.length, 1);
  assert.match(rang[0]!.headers.Title!, /^INVITE RUNS OUT IN/);
});
