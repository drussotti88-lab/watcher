/**
 * The capability table, held against the code it describes.
 *
 * A feature list is a document, and documents rot. These tests are the
 * mechanism that stops this one: the table may not claim a checkout that has
 * no driver on disk, and may not omit one that does. Adding a Walmart cart
 * driver without saying so here turns this file red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TestDb } from './pg.ts';
import { createHandler } from '../src/app.ts';
import {
  ABILITIES, RETAILERS, FEATURES, capabilityTable, statusOf,
  type Status,
} from '../src/capabilities.ts';
import type { Env } from '../src/types.ts';

const env: Env = {
  DATABASE_URL: 'postgres://unused',
  DISCORD_WEBHOOK_URL: '',
};

const phantomSrc = join(import.meta.dirname, '..', '..', 'watcher', 'src');

/** Retailer key → the name the code uses for that shop. */
const CODE_NAME: Record<string, string> = {
  target: 'Target',
  walmart: 'Walmart',
  'pokemon-center': 'Pokemon Center',
};

// ── the table against the code ───────────────────────────────────────────────

test('EVERY CLAIMED CHECKOUT HAS A DRIVER, AND EVERY DRIVER IS CLAIMED', (t) => {
  const dir = join(phantomSrc, 'checkout');
  if (!existsSync(dir)) return t.skip('Phantom is not checked out beside the Hub');

  // A driver file per shop that can buy: checkout/target.ts is Target's.
  const drivers = new Set(
    readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')),
  );

  for (const r of RETAILERS) {
    const claimed = statusOf(r.key, 'autoCheckout') === 'live';
    // 'pokemon-center' → 'pokemoncenter', the shape the reader files use.
    const hasDriver = drivers.has(r.key) || drivers.has(r.key.replace(/-/g, ''));
    assert.equal(
      claimed, hasDriver,
      `${r.name}: table says checkout ${claimed ? 'live' : 'not live'}, disk says ${hasDriver ? 'a driver exists' : 'no driver'}`,
    );
  }
});

test('a shop that claims watching has a reader on disk', (t) => {
  const dir = join(phantomSrc, 'readers');
  if (!existsSync(dir)) return t.skip('Phantom is not checked out beside the Hub');
  const readers = readdirSync(dir);

  for (const r of RETAILERS) {
    if (statusOf(r.key, 'watch') !== 'live') continue;
    const stem = r.key.replace(/-/g, '');
    assert.ok(
      readers.some((f) => f === `${stem}.ts`),
      `${r.name} claims watching but has no readers/${stem}.ts`,
    );
  }
});

test('THE BUY PATH ONLY KNOWS THE SHOPS THE TABLE SAYS CAN BUY', (t) => {
  const buy = join(phantomSrc, 'buy.ts');
  if (!existsSync(buy)) return t.skip('Phantom is not checked out beside the Hub');
  const src = readFileSync(buy, 'utf8');
  // The DRIVERS map is the real answer to "what can this thing buy from".
  const map = /const DRIVERS[^=]*=\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';

  for (const r of RETAILERS) {
    const inMap = new RegExp(`\\b${CODE_NAME[r.key]}\\b`).test(map);
    assert.equal(
      statusOf(r.key, 'autoCheckout') === 'live', inMap,
      `${r.name} disagrees with the DRIVERS map in buy.ts`,
    );
  }
});

// ── the table's own coherence ────────────────────────────────────────────────

test('every per-retailer ability key is a defined ability', () => {
  const known = new Set(ABILITIES.map((a) => a.key));
  for (const r of RETAILERS) {
    for (const key of Object.keys(r.abilities)) {
      assert.ok(known.has(key), `${r.name} claims unknown ability "${key}"`);
    }
  }
});

test('statuses are from the vocabulary, and an unlisted ability is none', () => {
  const ok: Status[] = ['live', 'partial', 'planned', 'none'];
  for (const r of RETAILERS) {
    for (const [k, v] of Object.entries(r.abilities)) {
      assert.ok(ok.includes(v), `${r.name}.${k} has bogus status "${v}"`);
    }
  }
  assert.equal(statusOf('target', 'teleportation'), 'none', 'unknown ability is never a guess');
  assert.equal(statusOf('costco', 'watch'), 'none', 'unknown shop is never a guess');
});

test('AUTO-CHECKOUT IS MARKED OWNER-ONLY — a membership must not promise it', () => {
  // It runs on the owner's machine, signed into the owner's account, against
  // the owner's card. Selling it to a member would be selling something that
  // cannot be delivered, and this is the flag the perks page filters on.
  const checkout = ABILITIES.find((a) => a.key === 'autoCheckout');
  assert.ok(checkout);
  assert.equal(checkout!.audience, 'owner');

  const writeback = FEATURES.find((f) => f.key === 'vaultWriteback');
  assert.equal(writeback?.audience, 'owner', 'the vault write-back is the owner’s too');
});

test('the member-facing list is not empty, and every entry reads as a benefit', () => {
  const member = ABILITIES.filter((a) => a.audience === 'member');
  assert.ok(member.length >= 4, 'a membership has to be worth something');
  for (const a of [...ABILITIES, ...FEATURES]) {
    assert.ok(a.blurb.length > 20, `${a.key} needs a real sentence`);
    assert.ok(a.label.length > 0);
  }
});

test('Target is the most complete shop — the table agrees with what shipped', () => {
  assert.equal(statusOf('target', 'stagedStock'), 'live', 'the measured drop precursor');
  assert.equal(statusOf('target', 'autoCheckout'), 'live');
  // Pokémon Center publishes availability as a yes/no. There is no quantity to
  // warn on, so claiming the staged-stock warning there would be an invention.
  assert.equal(statusOf('pokemon-center', 'stagedStock'), 'none');
  assert.equal(statusOf('walmart', 'autoCheckout'), 'planned');
});

// ── the endpoint the vault reads ─────────────────────────────────────────────

const call = async (method: string, path: string): Promise<Response> => {
  const db = await TestDb.create();
  try {
    return await createHandler(db, env)(new Request(`https://hub.test${path}`, { method }));
  } finally {
    await db.close();
  }
};

test('THE TABLE IS PUBLIC — a page that must sign in would hard-code the list instead', async () => {
  const res = await call('GET', '/api/capabilities');
  assert.equal(res.status, 200, 'no session, no token, still answers');
  const body = await res.json();
  assert.equal(body.app, 'Phantom by DNA');
  assert.equal(body.retailers.length, RETAILERS.length);
  assert.ok(body.abilities.some((a: { key: string }) => a.key === 'stagedStock'));
});

test('it is fetchable cross-origin and cached, because the vault renders it', async () => {
  const res = await call('GET', '/api/capabilities');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Cache-Control') ?? '', /s-maxage=3600/);
  const pre = await call('OPTIONS', '/api/capabilities');
  assert.equal(pre.status, 204, 'the preflight a browser sends');
});

test('the endpoint says nothing about any person', async () => {
  const res = await call('GET', '/api/capabilities');
  const text = JSON.stringify(await res.json()).toLowerCase();
  for (const leak of ['roberto', 'danru', 'password', 'token', 'secret', '@']) {
    assert.ok(!text.includes(leak), `the public feature list must not contain "${leak}"`);
  }
});
