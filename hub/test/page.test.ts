/**
 * The page, driven like a person drives it.
 *
 * This file exists because of a bug that every other test in the suite was
 * blind to. The add-product form read its name field as `form.name` — which is
 * the form's *own* name attribute, not the input called "name". Every
 * submission sent an empty name and came back "a product needs a name". Since
 * the name box plainly had a name in it, the only field left to suspect was the
 * date, which looked required when it never was.
 *
 * 98 tests passed while that button did nothing. They tested the API the page
 * calls; not one of them pressed the button. So these load the real HTML into a
 * real DOM, fill the real fields, click the real buttons, and assert on what
 * actually reaches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { dashboardPage } from '../src/page.ts';

interface Call {
  method: string;
  path: string;
  body: any;
}

interface Harness {
  dom: JSDOM;
  doc: Document;
  calls: Call[];
  /** Wait for the page's own promises to settle. */
  settle: () => Promise<void>;
  reply: (path: string, value: unknown) => void;
  fail: (path: string, error: string) => void;
}

const DASHBOARD = {
  missions: [
    {
      id: 1, listingId: 10, productKey: 'prd_etb', productName: 'Pitch Black ETB',
      imageUrl: '', msrp: 49.99, retailer: 'Target', externalId: '1012644666',
      url: 'https://www.target.com/p/-/A-1012644666', label: 'Pitch Black ETB',
      enabled: true, armed: false, ceiling: null, quantity: 1,
      sellerPolicy: 'retailer_only', checkEverySeconds: 60, notes: '',
      state: 'in', confidence: 'exact', price: 73.76,
      sellerKind: 'marketplace', sellerName: 'Rares Market L.L.C.',
      availableQuantity: 3, orderLimit: 12, isPreOrder: false, releaseDate: null,
      note: '', lastCheckedAt: new Date().toISOString(),
      lastChangedAt: new Date().toISOString(),
    },
  ],
  runs: [],
  changes: [],
  products: [
    { key: 'prd_etb', name: 'Pitch Black ETB', releaseDate: null, msrp: 49.99, imageUrl: '', notes: '' },
  ],
  listings: [
    {
      id: 10, productKey: 'prd_etb', productName: 'Pitch Black ETB', retailer: 'Target',
      externalId: '1012644666', url: 'https://www.target.com/p/-/A-1012644666',
      sellerKind: 'retailer', sellerName: '', isPrimary: true,
    },
  ],
};

async function boot(dashboard: unknown = DASHBOARD): Promise<Harness> {
  const calls: Call[] = [];
  const replies = new Map<string, unknown>();
  const failures = new Map<string, string>();
  replies.set('GET /api/dashboard', dashboard);

  // beforeParse, not after. The page calls load() on its last line, so a fetch
  // installed after construction arrives too late and the first render dies
  // with "fetch is not defined" — which looks exactly like a broken page.
  const stub = (win: any): void => {
    win.fetch = async (path: string, init: any = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (failures.has(key)) {
        return { ok: false, status: 400, json: async () => ({ error: failures.get(key) }) };
      }
      return { ok: true, status: 200, json: async () => replies.get(key) ?? {} };
    };
    win.confirm = () => true;
  };

  const dom = new JSDOM(dashboardPage(), {
    runScripts: 'dangerously',
    url: 'https://hub.test/',
    beforeParse: stub,
  });
  const win = dom.window as any;

  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  await settle();

  return {
    dom,
    doc: win.document,
    calls,
    settle,
    reply: (path, value) => replies.set(path, value),
    fail: (path, error) => failures.set(path, error),
  };
}

const $ = (h: Harness, sel: string): any => h.doc.querySelector(sel);
const submit = (form: any, win: any): void => {
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
};

// ── The bug this file was written for ────────────────────────────────────────

test('ADD PRODUCT SENDS THE NAME YOU TYPED', async () => {
  const h = await boot();
  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'Pitch Black Elite Trainer Box';
  h.reply('POST /api/products', { product: { key: 'prd_pitch_black' } });

  submit(form, h.dom.window);
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/products');
  assert.ok(call, 'the button did nothing at all');
  assert.equal(
    call.body.name,
    'Pitch Black Elite Trainer Box',
    'the name box had a name in it and the request must carry it',
  );
});

test('the date really is optional — a product submits without one', async () => {
  const h = await boot();
  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'No Date Product';
  h.reply('POST /api/products', { product: { key: 'prd_no_date' } });

  submit(form, h.dom.window);
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/products');
  assert.ok(call, 'submitting with an empty date must still reach the API');
  assert.equal(call.body.releaseDate, null, 'an empty date is null, not an empty string');
});

test('every optional field is genuinely optional', async () => {
  const h = await boot();
  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'Bare Minimum';
  h.reply('POST /api/products', { product: { key: 'prd_bare' } });

  submit(form, h.dom.window);
  await h.settle();

  const { body } = h.calls.find((c) => c.path === '/api/products')!;
  assert.equal(body.msrp, null);
  assert.equal(body.releaseDate, null);
  assert.equal(body.imageUrl, '');
  assert.equal(body.notes, '');
});

test('the full product form sends every field it shows', async () => {
  const h = await boot();
  const form = $(h, '#product-form');
  const set = (n: string, v: string) => { form.querySelector('[name=' + n + ']').value = v; };
  set('name', 'Pitch Black ETB');
  set('releaseDate', '2026-09-26');
  set('msrp', '49.99');
  set('imageUrl', 'https://example.test/a.jpg');
  set('notes', 'two per person');
  h.reply('POST /api/products', { product: { key: 'prd_pb' } });

  submit(form, h.dom.window);
  await h.settle();

  const { body } = h.calls.find((c) => c.path === '/api/products')!;
  assert.deepEqual(body, {
    name: 'Pitch Black ETB',
    releaseDate: '2026-09-26',
    msrp: 49.99,
    imageUrl: 'https://example.test/a.jpg',
    notes: 'two per person',
  });
});

// ── Buttons do what they say ─────────────────────────────────────────────────

test('a failed save shows the API sentence, not a status code', async () => {
  const h = await boot();
  h.fail('POST /api/products', 'a product needs a name');
  const form = $(h, '#product-form');
  submit(form, h.dom.window);
  await h.settle();

  const msg = $(h, '#product-msg');
  assert.equal(msg.textContent, 'a product needs a name');
  assert.match(msg.className, /bad/);
});

test('a button cannot be pressed twice while it is working', async () => {
  // Double-submitting an edit is harmless; double-submitting a buy would not
  // be, and the habit should be identical in both places.
  const h = await boot();
  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'Slow One';

  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const win = h.dom.window as any;
  const original = win.fetch;
  win.fetch = async (...args: any[]) => { await held; return original(...args); };

  const button = form.querySelector('button[type=submit]');
  submit(form, win);
  await h.settle();

  assert.equal(button.disabled, true, 'the button must lock while it works');
  assert.equal(button.textContent, 'Adding…', 'and say what it is doing');

  release();
  await h.settle();
  assert.equal(button.disabled, false, 'and unlock afterwards');
  assert.equal(button.textContent, 'Add product', 'and say what it does again');
});

test('the refresh button refetches', async () => {
  const h = await boot();
  const before = h.calls.filter((c) => c.path === '/api/dashboard').length;
  $(h, '#refresh').click();
  await h.settle();
  assert.equal(h.calls.filter((c) => c.path === '/api/dashboard').length, before + 1);
});

test('tabs switch what is shown, and only one at a time', async () => {
  const h = await boot();
  assert.equal($(h, '#tab-missions').hidden, false);
  assert.equal($(h, '#tab-products').hidden, true);

  (h.doc.querySelector('[data-tab=products]') as any).click();
  assert.equal($(h, '#tab-missions').hidden, true);
  assert.equal($(h, '#tab-products').hidden, false);
  assert.equal($(h, '#tab-activity').hidden, true);
});

test('saving a mission sends the settings actually on screen', async () => {
  const h = await boot();
  const form = $(h, 'form[data-mission="1"]');
  assert.ok(form, 'the mission panel should be rendered');

  form.querySelector('[name=ceiling]').value = '49.99';
  form.querySelector('[name=quantity]').value = '2';
  form.querySelector('[name=armed]').checked = true;
  h.reply('POST /api/missions', { mission: {} });

  submit(form, h.dom.window);
  await h.settle();

  const { body } = h.calls.find((c) => c.path === '/api/missions')!;
  assert.equal(body.listingId, 10);
  assert.equal(body.ceiling, 49.99);
  assert.equal(body.quantity, 2);
  assert.equal(body.armed, true, 'checkboxes must be read as booleans');
  assert.equal(body.enabled, true);
  assert.equal(body.sellerPolicy, 'retailer_only');
});

test('an empty ceiling is sent as null, never as an empty string', async () => {
  const h = await boot();
  const form = $(h, 'form[data-mission="1"]');
  form.querySelector('[name=ceiling]').value = '';
  h.reply('POST /api/missions', { mission: {} });

  submit(form, h.dom.window);
  await h.settle();

  assert.equal(h.calls.find((c) => c.path === '/api/missions')!.body.ceiling, null);
});

test('ticking Armed warns before anything is saved', async () => {
  const h = await boot();
  const form = $(h, 'form[data-mission="1"]');
  const armed = form.querySelector('[name=armed]');
  armed.checked = true;
  armed.dispatchEvent(new (h.dom.window as any).Event('change', { bubbles: true }));

  const warning = [...form.querySelectorAll('.msg')].map((n: any) => n.textContent).join(' ');
  assert.match(warning, /buy on its own/, 'arming spends money and should say so first');
});

test('adding a listing also creates the mission to watch it', async () => {
  // A listing with no mission is a thing you meant to watch and didn't.
  const h = await boot();
  (h.doc.querySelector('[data-tab=products]') as any).click();
  const panel = $(h, 'details');
  panel.open = true;

  const form = $(h, 'form[data-product="prd_etb"]');
  form.querySelector('[name=url]').value = 'https://www.target.com/p/-/A-1012644666';
  h.reply('POST /api/listings', { listing: { id: 42, retailer: 'Target', externalId: '1012644666' } });
  h.reply('POST /api/missions', { mission: {} });

  submit(form, h.dom.window);
  await h.settle();

  assert.ok(h.calls.find((c) => c.path === '/api/listings'), 'the listing should be created');
  const mission = h.calls.find((c) => c.path === '/api/missions');
  assert.ok(mission, 'and a mission with it');
  assert.equal(mission.body.listingId, 42);
});

// ── What the page says ───────────────────────────────────────────────────────

test('a marketplace price over MSRP is called out, not just displayed', async () => {
  const h = await boot();
  const card = $(h, '#missions .card');
  const text = card.textContent;
  assert.match(text, /marketplace: Rares Market/, 'the seller has to be visible');
  assert.match(text, /over MSRP/, 'and so does the fact that it is above retail');
  assert.ok(card.querySelector('.price.over'), 'the price itself should read as wrong');
});

test('an empty state explains the next step rather than showing nothing', async () => {
  const h = await boot({ missions: [], runs: [], changes: [], products: [], listings: [] });
  assert.match($(h, '#missions').textContent, /Add a product/);
  (h.doc.querySelector('[data-tab=products]') as any).click();
  assert.match($(h, '#products').textContent, /No products yet/);
});

test('a stale reading is marked stale', async () => {
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const h = await boot({
    ...DASHBOARD,
    missions: [{ ...DASHBOARD.missions[0], lastCheckedAt: old, lastChangedAt: old }],
  });
  assert.ok($(h, '.meta.stale'), 'a half-hour-old price must not read as current');
});

test('a dashboard that will not load says so instead of sitting blank', async () => {
  const h = await boot();
  h.fail('GET /api/dashboard', 'the hub is unreachable');
  $(h, '#refresh').click();
  await h.settle();
  assert.match($(h, '#summary').textContent, /unreachable/);
});

// ── Tags ─────────────────────────────────────────────────────────────────────

test('TAGS ARE CENTRED — the CSS says so, in both directions', async () => {
  // Two separate bugs lived here. Vertically, an inline-block pill inherits the
  // body's 1.55 line-height, so the text sits high in a box taller than it
  // needs to be. Horizontally, letter-spacing adds its gap after *every*
  // character including the last, so the glyphs drift left of centre by exactly
  // one gap.
  const style = dashboardPage();
  const pill = /\.pill \{([^}]*)\}/.exec(style)?.[1] ?? '';

  assert.match(pill, /display:\s*inline-flex/, 'inline-block cannot centre its own content');
  assert.match(pill, /align-items:\s*center/, 'vertical centring');
  assert.match(pill, /justify-content:\s*center/, 'horizontal centring');
  assert.match(pill, /font:[^;]*\/1\.2/, 'an inherited 1.55 makes the pill too tall');

  const spacing = /letter-spacing:\s*\.(\d+)em/.exec(pill)?.[1];
  const indent = /text-indent:\s*\.(\d+)em/.exec(pill)?.[1];
  assert.ok(spacing, 'letter-spacing is set');
  assert.equal(indent, spacing, 'text-indent must cancel letter-spacing exactly');
});

test('the theme is the one from dnacardvault.com, not an approximation of it', async () => {
  // Read off the live site rather than eyeballed: ground, surface, accent,
  // hairline border and the three faces it uses.
  const css = dashboardPage();
  for (const [what, value] of [
    ['ground', '#09080e'],
    ['surface', '#17161f'],
    ['ink', '#edebf5'],
    ['accent', '#7f77dd'],
    ['hairline border', 'rgba(237, 235, 245, .07)'],
  ] as const) {
    assert.ok(css.toLowerCase().includes(value), `${what} ${value} missing from the theme`);
  }
  for (const face of ['Syne', 'DM Sans', 'DM Mono']) {
    assert.ok(css.includes(face), `${face} missing`);
  }
  assert.match(css, /fonts\.googleapis\.com/, 'the faces have to actually load');
  assert.match(css, /color-scheme:\s*dark/, 'the site is dark only, so this is too');
});

test('tags are spaced by a flex gap, not by stray text nodes', async () => {
  const h = await boot();
  const tags = $(h, '.tags');
  assert.ok(tags, 'the tag row should exist');
  assert.ok(tags.children.length >= 2, 'this fixture has several tags');
  for (const child of tags.children) {
    assert.match(child.className, /pill/, 'a tag row holds pills and nothing else');
  }
  assert.equal(tags.textContent.includes('  '), false, 'no double spaces from manual padding');

  const css = dashboardPage();
  assert.match(/\.tags \{([^}]*)\}/.exec(css)?.[1] ?? '', /gap:/, 'spacing comes from the gap');
});

test('the tag row sits below the card, not squeezed beside the price', async () => {
  const h = await boot();
  const card = $(h, '#missions .card');
  const row = card.querySelector('.row');
  const tags = card.querySelector('.tags');
  assert.ok(tags, 'tags render');
  assert.equal(row.contains(tags), false,
    'nested in the title column they compete with the price and wrap at odd points');
  assert.equal(tags.parentElement, card);
});

test('the price column is a fixed width, so prices line up down the page', async () => {
  const right = /\.right \{([^}]*)\}/.exec(dashboardPage())?.[1] ?? '';
  assert.match(right, /min-width:/, 'without it each card picks its own right edge');
  assert.match(right, /text-align:\s*right/);
});

test('THE TEST RUN BUTTON ACTUALLY ASKS FOR A TEST RUN', async () => {
  // The lesson from the add-product bug: a button that looks right and posts
  // nowhere passes every test that does not press it.
  const h = await boot();
  const form = $(h, 'form[data-mission="1"]');
  const btn = form.querySelector('[data-act=check-now]');
  assert.ok(btn, 'the button should be on the mission panel');

  h.reply('POST /api/missions/1/check-now', { queued: 1, note: 'next pass' });
  btn.click();
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/missions/1/check-now');
  assert.ok(call, 'clicking Test run must reach the API');
  assert.equal(call.method, 'POST');
});

test('the test run button says queued, never "checking now"', async () => {
  // The Hub has no browser and the Watcher will not jump the retailer's pacing
  // for a button click. Wording that promises otherwise is a claim neither of
  // them can keep.
  const h = await boot();
  const form = $(h, 'form[data-mission="1"]');
  const btn = form.querySelector('[data-act=check-now]');

  h.reply('POST /api/missions/1/check-now', { queued: 1 });
  btn.click();
  await h.settle();

  assert.match(btn.textContent, /queued/i);
  assert.doesNotMatch(form.textContent, /checking now/i);
});

test('a mission already waiting on a test run shows it', async () => {
  const pending = JSON.parse(JSON.stringify(DASHBOARD));
  pending.missions[0].checkNow = true;
  const h = await boot(pending);
  const btn = $(h, 'form[data-mission="1"]').querySelector('[data-act=check-now]');
  assert.match(btn.textContent, /queued/i);
});
