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

async function boot(
  dashboard: unknown = DASHBOARD,
  url = 'https://hub.test/',
): Promise<Harness> {
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
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: failures.get(key) }),
          text: async () => JSON.stringify({ error: failures.get(key) }),
        };
      }
      const value = replies.get(key) ?? {};
      // Both, because not every caller wants parsed JSON. The diagnostics
      // download takes the text so it can save exactly the bytes it checked.
      return {
        ok: true,
        status: 200,
        json: async () => value,
        text: async () => JSON.stringify(value),
      };
    };
    win.__confirms = [];
    win.confirm = (msg: string) => {
      win.__confirms.push(msg);
      return true;
    };

    // jsdom implements neither, and the download button needs both. Recording
    // what was handed to createObjectURL is also how the test reads the file
    // that would have been saved.
    win.__blobs = [];
    win.URL.createObjectURL = (blob: any) => {
      win.__blobs.push(blob);
      return 'blob:test/' + win.__blobs.length;
    };
    win.URL.revokeObjectURL = () => {};
  };

  const dom = new JSDOM(dashboardPage(), {
    runScripts: 'dangerously',
    url,
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

// ── Quick add, and installing ────────────────────────────────────────────────

test('QUICK ADD SENDS THE URL YOU PASTED', async () => {
  // Same lesson as the product form above: a button that looks right and posts
  // nothing passes every test that does not press it.
  const h = await boot(DASHBOARD, 'https://hub.test/add');
  const form = $(h, '#quick-form');
  assert.ok(form, 'the quick-add box should be open on /add');

  form.querySelector('#quick-url').value = 'https://www.target.com/p/x/-/A-1012944745';
  h.reply('POST /api/quick-add', {
    product: { name: 'Mega Forces Tin' }, listing: {}, mission: {}, alreadyTracked: false,
  });

  submit(form, h.dom.window);
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/quick-add');
  assert.ok(call, 'submitting quick add must reach the API');
  assert.equal(call.body.url, 'https://www.target.com/p/x/-/A-1012944745');
});

test('a link shared from the phone arrives pre-filled', async () => {
  const shared = 'https://www.target.com/p/tin/-/A-1012944745';
  const h = await boot(DASHBOARD, 'https://hub.test/add?url=' + encodeURIComponent(shared));
  assert.equal($(h, '#quickadd').hidden, false);
  assert.equal($(h, '#quick-url').value, shared);
});

test('a link buried in the shared text is still found', async () => {
  // Android hands some shares over as "Product name https://…" in `text`
  // rather than as a clean `url`.
  const h = await boot(
    DASHBOARD,
    'https://hub.test/add?text=' +
      encodeURIComponent('Pokémon tin https://www.target.com/p/tin/-/A-1012944745'),
  );
  assert.equal($(h, '#quick-url').value, 'https://www.target.com/p/tin/-/A-1012944745');
});

test('the quick-add box stays shut on the ordinary dashboard', async () => {
  const h = await boot();
  assert.equal($(h, '#quickadd').hidden, true);
});

test('an already-tracked link says so rather than claiming a new watch', async () => {
  const h = await boot(DASHBOARD, 'https://hub.test/add');
  const form = $(h, '#quick-form');
  form.querySelector('#quick-url').value = 'https://www.target.com/p/x/-/A-1012644666';
  h.reply('POST /api/quick-add', { listing: {}, mission: {}, alreadyTracked: true });

  submit(form, h.dom.window);
  await h.settle();

  assert.match($(h, '#quick-msg').textContent, /already watching/i);
});

test('the install button is hidden until a browser offers an install', async () => {
  // Chrome fires beforeinstallprompt; Safari never does. A button that is
  // always there and usually does nothing is worse than no button.
  const h = await boot();
  assert.equal($(h, '#install').hidden, true);
});

test('the page asks the browser to register a service worker', async () => {
  // Without one there is no install prompt, on any browser.
  const html = dashboardPage();
  assert.match(html, /serviceWorker/);
  assert.match(html, /\/sw\.js/);
  assert.match(html, /rel="manifest"/);
});

// ── The ceiling, MSRP, and what is true of every mission ─────────────────────

test('A SUGGESTED CEILING IS FILLED IN AND LABELLED AS A SUGGESTION', async () => {
  // A number that appears in a spending field without saying where it came
  // from is a limit nobody chose.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].ceiling = null;
  d.missions[0].msrp = 49.99;
  d.settings = { taxRate: 0.0975, shippingAllowance: 0 };

  const h = await boot(d);
  const form = $(h, 'form[data-mission="1"]');
  assert.equal(form.querySelector('[name=ceiling]').value, '54.86');
  assert.match(form.querySelector('[data-hint=ceiling]').textContent, /suggested/i);
  assert.match(form.querySelector('[data-hint=ceiling]').textContent, /9\.75% tax/);
});

test('a ceiling already set is never overwritten by a suggestion', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].ceiling = 40;
  d.missions[0].msrp = 49.99;
  d.settings = { taxRate: 0.0975, shippingAllowance: 0 };

  const h = await boot(d);
  assert.equal($(h, 'form[data-mission="1"]').querySelector('[name=ceiling]').value, '40');
});

test('with no MSRP the box stays empty and says why', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].ceiling = null;
  d.missions[0].msrp = null;

  const h = await boot(d);
  const form = $(h, 'form[data-mission="1"]');
  assert.equal(form.querySelector('[name=ceiling]').value, '');
  assert.match(form.querySelector('[data-hint=ceiling]').textContent, /no MSRP/i);
});

test('THE TAX BOX SPEAKS PERCENT AND THE WIRE SPEAKS FRACTION', async () => {
  // 9.75 sent as a rate would price every mission out of its own ceiling. The
  // conversion lives in one place and this is the test that keeps it there.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.settings = { taxRate: 0, shippingAllowance: 0 };
  const h = await boot(d);

  const form = $(h, '#settings-form');
  form.querySelector('[name=taxRatePercent]').value = '9.75';
  form.querySelector('[name=shippingAllowance]').value = '9.99';
  h.reply('POST /api/settings', { settings: {} });

  submit(form, h.dom.window);
  await h.settle();

  const { body } = h.calls.find((c) => c.path === '/api/settings')!;
  assert.equal(body.taxRate, 0.0975);
  assert.equal(body.shippingAllowance, 9.99);
});

test('a saved rate comes back into the box as a percentage', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.settings = { taxRate: 0.0975, shippingAllowance: 9.99 };
  const h = await boot(d);
  assert.equal($(h, '#settings-form').querySelector('[name=taxRatePercent]').value, '9.75');
  assert.equal($(h, '#settings-form').querySelector('[name=shippingAllowance]').value, '9.99');
});

test('the ceiling field says what it covers', async () => {
  const h = await boot();
  const label = $(h, 'form[data-mission="1"]').textContent;
  assert.match(label, /per unit, including tax/);
});

// ── Adding a product, with or without a link ─────────────────────────────────

test('ADD PRODUCT WITH A URL DOES IT IN ONE STEP', async () => {
  const h = await boot();
  (h.doc.querySelector('[data-tab=products]') as any).click();

  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'Ascended Heroes Elite Trainer Box';
  form.querySelector('[name=msrp]').value = '60';
  form.querySelector('[name=url]').value = 'https://www.target.com/p/x/-/A-1012944745';
  h.reply('POST /api/quick-add', {
    product: { key: 'prd_ascended' },
    listing: { retailer: 'Target', externalId: '1012944745', productKey: 'prd_ascended' },
    mission: {},
    alreadyTracked: false,
  });

  submit(form, h.dom.window);
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/quick-add');
  assert.ok(call, 'a URL should go through quick-add, not three round trips');
  assert.equal(call.body.name, 'Ascended Heroes Elite Trainer Box');
  assert.equal(call.body.msrp, 60);
  assert.equal(call.body.url, 'https://www.target.com/p/x/-/A-1012944745');
  assert.equal(h.calls.filter((c) => c.path === '/api/products').length, 0);
});

test('add product without a URL is still just a product', async () => {
  // The point he asked about: the URL is optional, and a product is not tied
  // to one. Adding without it must keep working exactly as before.
  const h = await boot();
  (h.doc.querySelector('[data-tab=products]') as any).click();

  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'Journey Together ETB';
  h.reply('POST /api/products', { product: { key: 'prd_jt' } });

  submit(form, h.dom.window);
  await h.settle();

  assert.ok(h.calls.find((c) => c.path === '/api/products'));
  assert.equal(h.calls.filter((c) => c.path === '/api/quick-add').length, 0);
});

test('the form says the product is not tied to the link', async () => {
  // He asked for this feature having previously said he did not want a product
  // locked to one URL. Both are true, and the form has to say so.
  const h = await boot();
  const text = $(h, '#product-form').textContent;
  assert.match(text, /not tied to this link/i);
  assert.match(text, /another retailer/i);
});

// ── Saying the useful thing ──────────────────────────────────────────────────

const failingRead = () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'unknown';
  d.missions[0].confidence = 'unknown';
  d.missions[0].note = 'the check could not be completed: browser has been closed';
  d.missions[0].lastCheckedAt = new Date().toISOString();
  return d;
};

test('A FAILING CHECK SAYS "NOT READING", NOT "UNKNOWN" TWICE', async () => {
  // The card used to show UNKNOWN and UNKNOWN READ side by side — the same
  // fact twice, in the colour that means "hmm" — while the actual news was
  // that nothing had been read for hours.
  const h = await boot(failingRead());
  const pills = [...h.doc.querySelectorAll('#missions .pill')].map((p: any) => p.textContent);

  assert.ok(pills.some((t) => /not reading/i.test(t)), 'it has to name the problem');
  assert.equal(pills.filter((t) => /unknown/i.test(t)).length, 0, 'and stop shrugging twice');
});

test('the summary leads with what is broken', async () => {
  const h = await boot(failingRead());
  assert.match($(h, '#summary').textContent, /1 NOT READING/);
});

test('an ordinary out-of-stock card is unchanged', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'out';
  d.missions[0].confidence = 'exact';
  const h = await boot(d);
  const pills = [...h.doc.querySelectorAll('#missions .pill')].map((p: any) => p.textContent);

  assert.ok(pills.some((t) => /out of stock/i.test(t)));
  assert.ok(!pills.some((t) => /not reading/i.test(t)));
});

test('an inferred read is still flagged, because it is a real caveat', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'in';
  d.missions[0].confidence = 'inferred';
  const h = await boot(d);
  const pills = [...h.doc.querySelectorAll('#missions .pill')].map((p: any) => p.textContent);
  assert.ok(pills.some((t) => /inferred read/i.test(t)));
});

test('an exact read gets no badge — it is the normal case', async () => {
  const h = await boot();
  const pills = [...h.doc.querySelectorAll('#missions .pill')].map((p: any) => p.textContent);
  assert.ok(!pills.some((t) => /exact/i.test(t)));
});

test('a never-checked mission is not called "not reading"', async () => {
  // Nothing has gone wrong; nothing has happened yet. Different words.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'unchecked';
  d.missions[0].confidence = 'unknown';
  d.missions[0].lastCheckedAt = '';
  const h = await boot(d);
  const pills = [...h.doc.querySelectorAll('#missions .pill')].map((p: any) => p.textContent);

  assert.ok(pills.some((t) => /never checked/i.test(t)));
  assert.ok(!pills.some((t) => /not reading/i.test(t)));
});

test('the shared Pokémon TCG prefix is trimmed from the row', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].productName = 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box';
  const h = await boot(d);
  const name = $(h, '#missions .name');

  assert.equal(name.textContent, '30th Celebration Elite Trainer Box');
  assert.equal(name.title, d.missions[0].productName, 'the full name stays, on hover');
});

test('a name with no shared prefix is left alone', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].productName = 'Prismatic Evolutions Booster Bundle';
  const h = await boot(d);
  assert.equal($(h, '#missions .name').textContent, 'Prismatic Evolutions Booster Bundle');
});

// ── Check now, on the card ───────────────────────────────────────────────────

test('EVERY WATCHED CARD HAS A CHECK NOW BUTTON', async () => {
  const h = await boot();
  const btn = [...h.doc.querySelectorAll('#missions button')].find(
    (b: any) => /check now/i.test(b.textContent),
  ) as any;
  assert.ok(btn, 'it belongs on the card, not three clicks inside a panel');

  h.reply('POST /api/missions/1/check-now', { queued: 1 });
  btn.click();
  await h.settle();

  assert.ok(h.calls.find((c) => c.path === '/api/missions/1/check-now'));
  assert.match(btn.textContent, /queued/i);
});

test('a mission already waiting shows the button as queued', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].checkNow = true;
  const h = await boot(d);
  const btn = [...h.doc.querySelectorAll('#missions button')].find(
    (b: any) => /queued/i.test(b.textContent),
  ) as any;
  assert.ok(btn);
  assert.equal(btn.disabled, true);
});

// ── The add form is a dialog now ─────────────────────────────────────────────

test('THE ADD FORM IS CLOSED UNTIL YOU ASK FOR IT', async () => {
  const h = await boot();
  assert.equal($(h, '#add-dialog').open, false, 'it should not sit open down the page');
  assert.ok($(h, '#add-open'), 'and there is a button to open it');
});

test('the Add product button opens the dialog', async () => {
  const h = await boot();
  $(h, '#add-open').click();
  assert.equal($(h, '#add-dialog').open, true);
});

test('Cancel closes it without adding anything', async () => {
  const h = await boot();
  $(h, '#add-open').click();
  $(h, '#add-dialog').querySelector('[data-act=add-close]').click();

  assert.equal($(h, '#add-dialog').open, false);
  assert.equal(h.calls.filter((c) => c.path === '/api/products').length, 0);
});

test('a successful add closes the dialog', async () => {
  const h = await boot();
  $(h, '#add-open').click();
  const form = $(h, '#product-form');
  form.querySelector('[name=name]').value = 'Chaos Rising ETB';
  h.reply('POST /api/products', { product: { key: 'prd_cr' } });

  submit(form, h.dom.window);
  await h.settle();

  assert.equal($(h, '#add-dialog').open, false);
});

// ── Numbers that add something, and a log that does not lie by omission ──────

test('ZERO IS SHOWN — it is evidence the count was read', async () => {
  // This test asserted the opposite for an afternoon, on the grounds that "0
  // available" beside OUT OF STOCK was the same fact twice. It is not. A
  // listing where the retailer said zero is different from one where it never
  // said, and absence has to be reserved for the second.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'out';
  d.missions[0].availableQuantity = 0;
  const h = await boot(d);
  assert.match($(h, '#missions').textContent, /0 available/);
});

test('a real count is shown when it tells you something', async () => {
  // Target states a genuine number in its fulfillment API. How much runway a
  // restock has is worth knowing.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'in';
  d.missions[0].availableQuantity = 12;
  const h = await boot(d);
  assert.match($(h, '#missions').textContent, /12 available/);
});

test('a retailer that never states a count says nothing at all', async () => {
  // Pokémon Center and Walmart do not give one. null means "not stated", which
  // is not "none".
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].availableQuantity = null;
  const h = await boot(d);
  assert.doesNotMatch($(h, '#missions').textContent, /available/);
});

test('A RECOVERED SYSTEM DOES NOT READ AS PERMANENTLY BROKEN', async () => {
  // Runs are only written when something happened, so after an outage the log
  // is nothing but failures for ever. A check newer than the newest failure is
  // the proof it recovered, and the log has to say so.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.runs = [
    {
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      productName: 'Pitch Black ETB', outcome: 'failed',
      reason: 'browser has been closed', price: null, ms: 26,
    },
  ];
  d.missions[0].lastCheckedAt = new Date(Date.now() - 30_000).toISOString();

  const h = await boot(d);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  const text = $(h, '#runs-card').textContent;

  assert.match(text, /Checked successfully/);
  assert.match(text, /nothing has failed since/);
});

test('a system still failing is not told it recovered', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  const failedAt = new Date(Date.now() - 30_000).toISOString();
  d.runs = [
    {
      startedAt: failedAt, productName: 'Pitch Black ETB', outcome: 'failed',
      reason: 'browser has been closed', price: null, ms: 26,
    },
  ];
  d.missions[0].lastCheckedAt = new Date(Date.now() - 3600_000).toISOString();

  const h = await boot(d);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  assert.doesNotMatch($(h, '#runs-card').textContent, /Checked successfully/);
});

test('a clean log is not given a recovery note either', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.runs = [
    {
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      productName: 'Pitch Black ETB', outcome: 'in_stock',
      reason: 'in stock at $49.99', price: 49.99, ms: 812,
    },
  ];
  const h = await boot(d);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  assert.doesNotMatch($(h, '#runs-card').textContent, /nothing has failed since/);
});

test('the run table stacks on a phone instead of one word per line', async () => {
  // A five-column table at 390px wraps the product name down the screen while
  // "when" and "outcome" sit in slivers beside it.
  const html = dashboardPage();
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /table, tbody, tr, td \{ display: block/);
  assert.match(html, /td\[data-label\]::before/);
});

test('every stacked cell carries the label its column header gave it', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.runs = [
    {
      startedAt: new Date().toISOString(), productName: 'Pitch Black ETB',
      outcome: 'failed', reason: 'because', price: null, ms: 26,
    },
  ];
  const h = await boot(d);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  const labels = [...h.doc.querySelectorAll('#runs-card td[data-label]')].map(
    (td: any) => td.dataset.label,
  );
  assert.deepEqual(labels, ['when', 'outcome', 'why']);
});

test('the run log trims the shared prefix too', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.runs = [
    {
      startedAt: new Date().toISOString(),
      productName: 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box',
      outcome: 'failed', reason: 'because', price: null, ms: 26,
    },
  ];
  const h = await boot(d);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  assert.match($(h, '#runs-card').textContent, /30th Celebration Elite Trainer Box/);
  assert.doesNotMatch($(h, '#runs-card').textContent, /Trading Card Game/);
});

// ── The diagnostics download ─────────────────────────────────────────────────

const EXPORT = {
  generatedAt: '2026-08-29T12:00:00.000Z',
  windowHours: 24,
  counts: { lines: 412, byLevel: { info: 400, warn: 4, error: 8 } },
  summary: [{ retailer: 'target', checks: 400, failures: 8, inStock: 2, medianMs: 1180 }],
  lines: [],
  warnings: [],
};

test('THE DOWNLOAD BUTTON PRODUCES A FILE, NOT A NAVIGATION', async () => {
  // On a phone, pointing a link at a JSON endpoint opens a viewer and saves
  // nothing. The bytes have to be turned into a file by the page.
  const h = await boot();
  h.reply('GET /api/activity/export?hours=24', EXPORT);

  $(h, '#diag-download').click();
  await h.settle();

  const win = h.dom.window as any;
  assert.equal(win.__blobs.length, 1, 'nothing was offered for saving');
  assert.ok(
    h.calls.some((c) => c.path === '/api/activity/export?hours=24'),
    'the export was never fetched',
  );
});

test('the chosen window is the window that gets asked for', async () => {
  const h = await boot();
  $(h, '#diag-hours').value = '168';
  h.reply('GET /api/activity/export?hours=168', EXPORT);

  $(h, '#diag-download').click();
  await h.settle();

  assert.ok(h.calls.some((c) => c.path === '/api/activity/export?hours=168'));
});

test('the button reports what it saved, and how much of it failed', async () => {
  // A download that says nothing leaves you wondering whether it worked. The
  // failure count is the number worth seeing before opening the file.
  const h = await boot();
  h.reply('GET /api/activity/export?hours=24', EXPORT);

  $(h, '#diag-download').click();
  await h.settle();

  const msg = $(h, '#diag-msg').textContent;
  assert.match(msg, /412 lines/);
  assert.match(msg, /8 of them failures/);
});

test("A BUNDLE THAT WARNS ABOUT ITSELF SAYS SO ON THE BUTTON", async () => {
  // The export checks its own output. If that check ever trips, the person
  // holding the file needs to know before they pass it to anybody.
  const h = await boot();
  h.reply('GET /api/activity/export?hours=24', { ...EXPORT, warnings: ['email'] });

  $(h, '#diag-download').click();
  await h.settle();

  assert.match($(h, '#diag-msg').textContent, /check it first: email/);
});

test('a failed export says so instead of saving an error page', async () => {
  const h = await boot();
  h.fail('GET /api/activity/export?hours=24', 'nope');

  $(h, '#diag-download').click();
  await h.settle();

  assert.match($(h, '#diag-msg').textContent, /400/);
  assert.equal((h.dom.window as any).__blobs.length, 0, 'and saved nothing');
});

test('the settings tab spells out what is and is not in the file', async () => {
  // The claim is the reason it is safe to send. It belongs next to the button,
  // not in a commit message.
  const h = await boot();
  const text = $(h, '#tab-settings').textContent;
  assert.match(text, /Not in it/);
  for (const promised of ['token', 'password', 'postcode', 'email']) {
    assert.ok(text.includes(promised), `the page should say ${promised} is excluded`);
  }
});

// ── The countdown ────────────────────────────────────────────────────────────
//
// The only forward-looking thing on the card. Everything else describes a
// reading that has already happened; this says something is coming.

function withRelease(over: Record<string, unknown>): unknown {
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  Object.assign(base.missions[0], { state: 'out', price: 69.99 }, over);
  return base;
}

const inDays = (n: number): string =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/**
 * The text of the rendered pills, and nothing else.
 *
 * Not `body.textContent`: in jsdom that includes the page's own <script>, so
 * every negative assertion passed by matching the source of the very code it
 * was meant to prove had not run. Three of these tests were green for that
 * reason before this helper existed.
 */
const pills = (h: Harness): string =>
  [...h.doc.querySelectorAll('.pill')].map((p) => p.textContent).join(' | ');

test('AN OUT-OF-STOCK ITEM WITH A KNOWN DROP DATE SAYS SO', async () => {
  // Without this, a box dropping on Tuesday and a box that sold out in March
  // render identically: one grey OUT OF STOCK pill each.
  const h = await boot(withRelease({ releaseDate: inDays(18) }));
  assert.match(pills(h), /drops in 18 days/);
});

test('the day itself is called out, not counted', async () => {
  const h = await boot(withRelease({ releaseDate: inDays(0) }));
  assert.match(pills(h), /DROPS TODAY/);
  assert.ok(!pills(h).includes('drops in 0 days'));
});

test('tomorrow reads as tomorrow', async () => {
  const h = await boot(withRelease({ releaseDate: inDays(1) }));
  assert.match(pills(h), /drops tomorrow/);
});

test('A COUNTDOWN THAT HAS GONE NEGATIVE IS NOT SHOWN', async () => {
  // Worse than no countdown: a date that has passed still reads as news, and
  // the whole point of the pill is that it means something is coming.
  const h = await boot(withRelease({ releaseDate: inDays(-5) }));
  assert.ok(!pills(h).includes('drops in'));
});

test('once it is actually in stock the date stops being the story', async () => {
  const h = await boot(withRelease({ state: 'in', releaseDate: inDays(2) }));
  assert.ok(!pills(h).includes('drops in'));
});

test('a mission with no release date renders exactly as before', async () => {
  const h = await boot(withRelease({ releaseDate: null }));
  assert.ok(!pills(h).includes('drops'));
});

test('a date far enough out is not treated as a countdown', async () => {
  // A street date a year away is a catalogue fact, not something to watch for.
  const h = await boot(withRelease({ releaseDate: inDays(300) }));
  assert.ok(!pills(h).includes('drops in'));
});

// ── The review list ──────────────────────────────────────────────────────────
//
// A sweep proposes, a person decides. These are about the deciding.

const FINDS = [
  {
    id: 7, sourceId: 'target-tcg', externalId: '1010892076',
    name: 'Pokémon TCG: 30th Celebration Elite Trainer Box',
    url: 'https://www.target.com/p/-/A-1010892076', price: 69.99,
    kind: 'elite trainer box', confidence: 'sealed', foundBy: 'pokemon elite trainer box',
    status: 'new', firstSeenAt: new Date().toISOString(), alreadyHave: false,
  },
  {
    id: 8, sourceId: 'target-tcg', externalId: '1010892099',
    name: 'Pokémon TCG: 30th Celebration Poster Collection',
    url: 'https://www.target.com/p/-/A-1010892099', price: 19.99,
    kind: 'poster collection', confidence: 'unsure', foundBy: 'pokemon booster pack',
    status: 'new', firstSeenAt: new Date().toISOString(), alreadyHave: false,
  },
];

const withFinds = (finds: unknown[] = FINDS): unknown => {
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  base.discoveries = finds;
  return base;
};

test('THE SWEEP LIST SHOWS WHAT WAS FOUND, WITH KEEP AND FORGET', async () => {
  const h = await boot(withFinds());
  const text = $(h, '#tab-finds').textContent;

  assert.match(text, /30th Celebration Elite Trainer Box/);
  assert.match(text, /elite trainer box/);
  assert.match(text, /found by "pokemon elite trainer box"/);

  const buttons = [...h.doc.querySelectorAll('#finds-list button')].map((b) => b.textContent);
  assert.ok(buttons.includes('Keep'));
  assert.ok(buttons.includes('Forget'));
});

test('the confident ones come first, but the unsure ones are still shown', async () => {
  // Dropping a real drop is the expensive error. Showing a poster collection
  // costs two seconds, so it is shown — just not first.
  const h = await boot(withFinds());
  const names = [...h.doc.querySelectorAll('#finds-list .name')].map((n) => n.textContent);
  assert.match(names[0], /Elite Trainer Box/);
  assert.match(names[1], /Poster Collection/);
});

test('an uncertain find says so on its face', async () => {
  const h = await boot(withFinds());
  const pillText = [...h.doc.querySelectorAll('#finds-list .pill')].map((p) => p.textContent);
  assert.ok(pillText.some((t) => t.includes('not sure')));
});

test('KEEPING SENDS KEEP, AND SAYS IT ARMED NOTHING', async () => {
  // The whole safety story of this feature in one assertion. A machine's guess
  // becoming a thing that spends money must take a second, deliberate step.
  const h = await boot(withFinds());
  h.reply('POST /api/discoveries/7/keep', { kept: { productKey: 'k', listingId: 3 } });

  const keep = [...h.doc.querySelectorAll('#finds-list button')].find((b) => b.textContent === 'Keep');
  keep.click();
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/discoveries/7/keep');
  assert.ok(call, 'keep did nothing at all');
  assert.equal(call.method, 'POST');
  assert.ok(
    !h.calls.some((c) => c.path === '/api/missions'),
    'keeping must never create a mission, let alone arm one',
  );
});

test('forgetting sends forget for that exact find', async () => {
  const h = await boot(withFinds());
  h.reply('POST /api/discoveries/7/forget', { forgotten: 7 });

  const forget = [...h.doc.querySelectorAll('#finds-list button')].find((b) => b.textContent === 'Forget');
  forget.click();
  await h.settle();

  assert.ok(h.calls.some((c) => c.path === '/api/discoveries/7/forget' && c.method === 'POST'));
});

test('an empty list says what to do about it, not just that it is empty', async () => {
  const h = await boot(withFinds([]));
  const text = $(h, '#tab-finds').textContent;
  assert.match(text, /Nothing waiting/);
  assert.match(text, /npm run discover/);
});

test('a find you already watch is marked, not hidden', async () => {
  // Hiding it would make the sweep look like it had missed something.
  const h = await boot(withFinds([{ ...FINDS[0], alreadyHave: true }]));
  const pillText = [...h.doc.querySelectorAll('#finds-list .pill')].map((p) => p.textContent);
  assert.ok(pillText.some((t) => t.includes('already on your list')));
});

test('a dashboard from before this feature does not break the page', async () => {
  // The Watcher and the Hub deploy separately, and an old payload with no
  // discoveries key must render rather than throw.
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  delete base.discoveries;
  const h = await boot(base);
  assert.match($(h, '#tab-finds').textContent, /Nothing waiting/);
  assert.equal($(h, '#c-finds').textContent, '');
});

// ── When to watch ────────────────────────────────────────────────────────────

const withSettings = (over: Record<string, unknown>): unknown => {
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  base.settings = { taxRate: 0, shippingAllowance: 0, activeFrom: '', activeUntil: '', timezone: '', paused: false, ...over };
  return base;
};

test('the window is shown as it was saved', async () => {
  const h = await boot(withSettings({ activeFrom: '02:30', activeUntil: '05:00', timezone: 'America/Chicago' }));
  assert.equal($(h, '#hours-form [name=activeFrom]').value, '02:30');
  assert.equal($(h, '#hours-form [name=activeUntil]').value, '05:00');
  assert.equal($(h, '#hours-form [name=timezone]').value, 'America/Chicago');
});

test('saving hours sends all four fields', async () => {
  const h = await boot(withSettings({}));
  $(h, '#hours-form [name=activeFrom]').value = '03:00';
  $(h, '#hours-form [name=activeUntil]').value = '05:00';
  $(h, '#hours-form [name=timezone]').value = 'America/Chicago';
  h.reply('POST /api/settings', { settings: {} });

  submit($(h, '#hours-form'), h.dom.window);
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/settings');
  assert.ok(call, 'saving did nothing');
  assert.equal(call.body.activeFrom, '03:00');
  assert.equal(call.body.activeUntil, '05:00');
  assert.equal(call.body.timezone, 'America/Chicago');
  assert.equal(call.body.paused, false);
});

test('PAUSING IS SAID WHERE IT CANNOT BE MISSED', async () => {
  // A system that is doing nothing on purpose and a system that is broken look
  // identical from the outside. This is the difference.
  const h = await boot(withSettings({ paused: true }));
  assert.equal($(h, '#paused-banner').hidden, false);
  assert.match($(h, '#paused-banner').textContent, /Everything is paused/);
  assert.equal($(h, '#hours-form [name=paused]').checked, true);
});

test('the banner is not there when nothing is paused', async () => {
  const h = await boot(withSettings({ paused: false }));
  assert.equal($(h, '#paused-banner').hidden, true);
});

test('the page says what still wakes it', async () => {
  // The promise that makes quiet hours safe to turn on. It belongs next to the
  // switch, not in a commit message.
  const h = await boot(withSettings({}));
  const text = $(h, '#tab-settings').textContent;
  assert.match(text, /Check now/);
  assert.match(text, /release date is today/);
});


// ── The two buttons in the bar ───────────────────────────────────────────────

const withSweep = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): unknown => {
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  base.settings = { taxRate: 0, shippingAllowance: 0, activeFrom: '', activeUntil: '', timezone: '', paused: false, sweepEveryHours: 24, ...settings };
  base.sweep = { queued: false, lastSweptAt: null, lastStatus: '', ...over };
  return base;
};

test('THE TOGGLE IS LABELLED WITH THE ACTION, NOT THE STATE', async () => {
  // A button that says "Paused" leaves you guessing whether that is what it
  // is or what it will do. These say what pressing them does.
  const running = await boot(withSweep({}, { paused: false }));
  assert.equal($(running, '#watcher-toggle').textContent, 'Turn watcher off');

  const stopped = await boot(withSweep({}, { paused: true }));
  assert.equal($(stopped, '#watcher-toggle').textContent, 'Turn watcher on');
});

test('turning the watcher off asks first, and then says so', async () => {
  const h = await boot(withSweep({}, { paused: false }));
  h.reply('POST /api/settings', { settings: {} });

  $(h, '#watcher-toggle').click();
  await h.settle();

  const asked = (h.dom.window as any).__confirms;
  assert.equal(asked.length, 1, 'stopping everything should ask first');
  assert.match(asked[0], /Stop all watching/);

  const call = h.calls.find((c) => c.path === '/api/settings');
  assert.ok(call, 'the toggle did nothing');
  assert.equal(call.body.paused, true);
});

test('TURNING IT BACK ON DOES NOT ASK — STARTING IS NOT THE RISKY DIRECTION', async () => {
  // Interrupting someone to confirm that they want the thing switched on is
  // noise. Interrupting them before switching off the thing meant to catch a
  // drop is not.
  const h = await boot(withSweep({}, { paused: true }));
  h.reply('POST /api/settings', { settings: {} });

  $(h, '#watcher-toggle').click();
  await h.settle();

  assert.deepEqual((h.dom.window as any).__confirms, [], 'it should not have asked');
  assert.equal(h.calls.find((c) => c.path === '/api/settings').body.paused, false);
});

test('THE SWEEP BUTTON QUEUES A SWEEP', async () => {
  const h = await boot(withSweep());
  h.reply('POST /api/sweep-now', { queued: true, sourceId: 'target-tcg' });

  $(h, '#sweep-now').click();
  await h.settle();

  assert.ok(h.calls.some((c) => c.path === '/api/sweep-now' && c.method === 'POST'));
});

test('an already-queued sweep cannot be queued twice', async () => {
  // Pressing it again would do no harm, but a button that looks pressable
  // when nothing more will happen invites pressing it repeatedly and
  // wondering why nothing changes.
  const h = await boot(withSweep({ queued: true }));
  assert.equal($(h, '#sweep-now').disabled, true);
  assert.equal($(h, '#sweep-now').textContent, 'sweep queued');
});

test('the button says when the catalogue was last swept', async () => {
  const h = await boot(
    withSweep({ lastSweptAt: new Date(Date.now() - 3600_000).toISOString(), lastStatus: 'watcher: 2 new' }),
  );
  const title = $(h, '#sweep-now').title;
  assert.match(title, /last swept/);
  assert.match(title, /2 new/);
});

test('a dashboard with no sweep block still renders the bar', async () => {
  // The Hub and the Watcher deploy separately; an older payload must not take
  // the page down.
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  base.settings = { taxRate: 0, shippingAllowance: 0, paused: false };
  delete base.sweep;
  const h = await boot(base);
  assert.equal($(h, '#sweep-now').disabled, false);
  assert.equal($(h, '#sweep-now').textContent, 'Run catalogue sweep');
});

test('A FIND SHOWS ITS PICTURE, NOT JUST ITS NAME', async () => {
  // Twenty text rows is a chore. Twenty boxes you recognise is a glance.
  const h = await boot(withFinds([{ ...FINDS[0], imageUrl: 'https://target.scene7.com/is/image/Target/GUEST_x?wid=300' }]));
  const img = h.doc.querySelector('#finds-list img.thumb');
  assert.ok(img, 'no thumbnail rendered');
  assert.match(img.src, /GUEST_x/);
  assert.equal(img.alt, FINDS[0].name, 'and it is described for anyone not seeing it');
});

test('a find with no picture gets the placeholder, not a broken image', async () => {
  const h = await boot(withFinds([{ ...FINDS[0], imageUrl: '' }]));
  assert.equal(h.doc.querySelector('#finds-list img.thumb'), null);
  assert.ok(h.doc.querySelector('#finds-list .thumb.ph'), 'the placeholder should stand in');
});

// ── What "available" actually means ──────────────────────────────────────────

test('A CAPPED QUANTITY IS SHOWN AS A FLOOR, NOT A COUNT', async () => {
  // Target's available_to_promise never exceeds 20 across every reading taken,
  // and 10 and 20 recur far too often to be real counts. Printing "10
  // available" states as fact something the retailer only bounded.
  const h = await boot(withRelease({ state: 'in', availableQuantity: 10, orderLimit: 2 }));
  const text = h.doc.body.querySelector('#tab-missions').textContent;
  assert.match(text, /10\+ available/);
  // And nothing explaining what the plus means. The plus means it.
  assert.ok(!text.includes('at least 10'));
});

test('a number below the ceiling is reported plainly', async () => {
  // Nine means nine. This is the range where the figure is worth trusting.
  const h = await boot(withRelease({ state: 'in', availableQuantity: 9, orderLimit: 2 }));
  const text = h.doc.querySelector('#tab-missions').textContent;
  assert.match(text, /9 available/);
  assert.ok(!text.includes('9+ available'));
});

test('THE PER-ORDER LIMIT IS SHOWN NEXT TO IT', async () => {
  // A limit of 2 against 10 available is two. Burying that in the note line
  // while the headline says 10 is the wrong way round.
  const h = await boot(withRelease({ state: 'in', availableQuantity: 10, orderLimit: 2 }));
  assert.match(h.doc.querySelector('#tab-missions').textContent, /limit 2 per order/);
});

test('no stated limit means no line about it', async () => {
  const h = await boot(withRelease({ state: 'in', availableQuantity: 9, orderLimit: null }));
  assert.ok(!h.doc.querySelector('#tab-missions').textContent.includes('per order'));
});

test('zero available is still shown, and is not a floor', async () => {
  const h = await boot(withRelease({ state: 'out', availableQuantity: 0 }));
  const text = h.doc.querySelector('#tab-missions').textContent;
  assert.match(text, /0 available/);
  assert.ok(!text.includes('0+ available'));
});

test('THE SWEEP BUTTON SAYS SWEEPING WHILE IT IS SWEEPING', async () => {
  // A sweep is thirteen queries reported one at a time. "queued" for forty
  // minutes reads as stuck, which is how a working feature gets reported as
  // broken.
  const h = await boot(withSweep({ queued: true, lastStatus: 'sweeping — 9 to go' }));
  assert.equal($(h, '#sweep-now').textContent, 'sweeping — 9 to go');
  assert.equal($(h, '#sweep-now').disabled, true);
});

test('before it starts it still says queued', async () => {
  const h = await boot(withSweep({ queued: true, lastStatus: 'watcher: 2 new' }));
  assert.equal($(h, '#sweep-now').textContent, 'sweep queued');
});

test('and when it is over it offers another', async () => {
  const h = await boot(withSweep({ queued: false, lastStatus: 'watcher: 2 new' }));
  assert.equal($(h, '#sweep-now').textContent, 'Run catalogue sweep');
  assert.equal($(h, '#sweep-now').disabled, false);
});

test('THE TABS WRAP RATHER THAN RUNNING OFF THE EDGE', async () => {
  // Five tabs and their counts are wider than a phone, and the fifth was
  // simply gone — no scrollbar, no affordance, just off the right-hand side.
  const h = await boot();
  const style = h.doc.querySelector('style').textContent;
  const tabs = /\.tabs \{([^}]*)\}/.exec(style)?.[1] ?? '';
  assert.match(tabs, /flex-wrap:\s*wrap/);
});

// ── Pre-order is not in stock ────────────────────────────────────────────────

const preorderMission = (over: Record<string, unknown> = {}): unknown => {
  const base = JSON.parse(JSON.stringify(DASHBOARD));
  Object.assign(base.missions[0], {
    state: 'in', isPreOrder: true, releaseDate: '2026-11-14',
    preOrderPolicy: 'skip', armed: false, ...over,
  });
  return base;
};

test('A PRE-ORDER DOES NOT SAY IN STOCK', async () => {
  // Orderable and in stock call for different decisions — one is a race, the
  // other is a queue. "IN STOCK" on a box that ships in November is the single
  // most misleading thing this card could say.
  const h = await boot(preorderMission());
  const pills = [...h.doc.querySelectorAll('.pill')].map((p) => p.textContent);
  assert.ok(pills.includes('PRE-ORDER'));
  assert.ok(!pills.includes('IN STOCK'));
});

test('and it says when it ships', async () => {
  const h = await boot(preorderMission());
  const pills = [...h.doc.querySelectorAll('.pill')].map((p) => p.textContent);
  assert.ok(pills.some((t) => t.includes('ships 2026-11-14')));
});

test('AN ARMED MISSION SAYS WHAT IT WILL DO ABOUT IT', async () => {
  // Whether money moves is worth saying on the card, not only inside a panel.
  const skip = await boot(preorderMission({ armed: true, preOrderPolicy: 'skip' }));
  assert.ok([...skip.doc.querySelectorAll('.pill')].some((p) => p.textContent.includes('will not buy')));

  const allow = await boot(preorderMission({ armed: true, preOrderPolicy: 'allow' }));
  assert.ok([...allow.doc.querySelectorAll('.pill')].some((p) => p.textContent.includes('will buy pre-orders')));
});

test('a watching-only pre-order makes no claim about buying', async () => {
  const h = await boot(preorderMission({ armed: false }));
  const pills = [...h.doc.querySelectorAll('.pill')].map((p) => p.textContent).join(' ');
  assert.ok(!pills.includes('will buy'));
  assert.ok(!pills.includes('will not buy'));
});

test('an ordinary in-stock item still says IN STOCK', async () => {
  const h = await boot(preorderMission({ isPreOrder: false, releaseDate: null }));
  const pills = [...h.doc.querySelectorAll('.pill')].map((p) => p.textContent);
  assert.ok(pills.includes('IN STOCK'));
  assert.ok(!pills.includes('PRE-ORDER'));
});

test('the policy is editable and is sent when saved', async () => {
  const h = await boot(preorderMission());
  const panel = $(h, '#tab-missions details');
  panel.open = true;
  const form = h.doc.querySelector('#tab-missions form');
  form.querySelector('[name=preOrderPolicy]').value = 'allow';
  h.reply('POST /api/missions', { mission: {} });

  submit(form, h.dom.window);
  await h.settle();

  const call = h.calls.find((c) => c.path === '/api/missions');
  assert.ok(call, 'saving did nothing');
  assert.equal(call.body.preOrderPolicy, 'allow');
});

test('the header names the account you are signed in as', async () => {
  // The bug this whole change closes was invisible: two people, one dashboard,
  // no way to tell which. A badge that is present when the API says who you
  // are, and absent when it does not, is what makes the fix legible.
  const h = await boot({ ...DASHBOARD, you: 'tester' });
  assert.equal(h.doc.getElementById('who')?.textContent, 'tester');
});

test('the header badge stays empty rather than guessing at a name', async () => {
  const h = await boot(DASHBOARD);
  assert.equal(h.doc.getElementById('who')?.textContent, '');
});

// ── A find card has to carry a decision ──────────────────────────────────────

const RICH_FIND = {
  id: 21, sourceId: 'pc-new-releases', externalId: '10-10447-111',
  name: 'Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box',
  url: 'https://www.pokemoncenter.com/product/10-10447-111',
  price: 59.99, kind: 'elite trainer box', confidence: 'sealed', foundBy: '',
  imageUrl: 'https://www.pokemoncenter.com/images/DAMRoot/Thumbnail/x.jpg',
  status: 'new', firstSeenAt: new Date().toISOString(), alreadyHave: false,
  retailer: 'Pokemon Center', state: 'out', isPreOrder: false,
  releaseDate: '2026-07-15', orderLimit: null, signal: 'recent',
};

const findPills = (h: Harness): string[] =>
  [...h.doc.querySelectorAll('#finds-list .pill')].map((p) => p.textContent ?? '');

test('A FIND SAYS WHICH SHOP IT IS AT', async () => {
  // The most-missed fact by a distance. The same box at Pokémon Center and at a
  // Walmart reseller are not the same decision.
  const h = await boot(withFinds([RICH_FIND]));
  const meta = h.doc.querySelector('#finds-list .meta')?.textContent ?? '';
  assert.match(meta, /Pokemon Center/);
  assert.match(meta, /elite trainer box/);
  assert.match(meta, /\$59\.99/);
});

test('A PRE-ORDER SAYS SO ON THE CARD', async () => {
  // It takes the money now and ships whenever the publisher says. That is a
  // different decision from a restock, not a variety of one.
  const h = await boot(withFinds([{ ...RICH_FIND, isPreOrder: true, state: 'in' }]));
  assert.ok(findPills(h).includes('PRE-ORDER'), 'no pre-order pill');
  assert.ok(!findPills(h).includes('in stock'), 'pre-order must not also read as in stock');
});

test('stock state is on the card when it is not a pre-order', async () => {
  const inStock = await boot(withFinds([{ ...RICH_FIND, state: 'in' }]));
  assert.ok(findPills(inStock).includes('in stock'));
  const outOfStock = await boot(withFinds([{ ...RICH_FIND, state: 'out' }]));
  assert.ok(findPills(outOfStock).includes('out of stock'));
  const unknown = await boot(withFinds([{ ...RICH_FIND, state: '' }]));
  assert.ok(!findPills(unknown).some((p) => /in stock|out of stock/.test(p)),
    'an unknown state must claim neither');
});

test('a release date is shown, with how far away it is', async () => {
  const soon = new Date(Date.now() + 17 * 86400000).toISOString().slice(0, 10);
  const h = await boot(withFinds([{ ...RICH_FIND, releaseDate: soon }]));
  assert.ok(findPills(h).some((p) => p.includes(soon) && p.includes('17d')),
    `expected a countdown pill, got ${findPills(h).join(' | ')}`);
});

test('a date already passed is not counted down to', async () => {
  const h = await boot(withFinds([{ ...RICH_FIND, releaseDate: '2026-07-15' }]));
  assert.ok(findPills(h).some((p) => p.startsWith('released 2026-07-15')),
    `expected a past-tense pill, got ${findPills(h).join(' | ')}`);
});

test('THE CARD SAYS WHY IT IS IN FRONT OF YOU', async () => {
  // Pokémon Center is walked rather than searched, so it has no keyword to
  // name. It was writing its signal into foundBy and the card read
  // `found by "recent"` — true, and useless.
  const recent = await boot(withFinds([{ ...RICH_FIND, signal: 'recent' }]));
  assert.match($(recent, '#finds-list').textContent, /released recently and sold out/);
  assert.ok(!$(recent, '#finds-list').textContent.includes('found by "recent"'),
    'the signal must never masquerade as a keyword');

  const scheduled = await boot(withFinds([{ ...RICH_FIND, signal: 'scheduled' }]));
  assert.match($(scheduled, '#finds-list').textContent, /the shop has published a date/);
});

test('a keyword find still names its keyword', async () => {
  // Target has a query to name, and naming it is how a keyword that only
  // returns rubbish earns its way out of the sweep.
  const h = await boot(withFinds([
    { ...RICH_FIND, retailer: 'Target', signal: '', foundBy: 'pokemon booster box' },
  ]));
  assert.match($(h, '#finds-list').textContent, /found by "pokemon booster box"/);
});

test('an order limit is shown when the shop states one', async () => {
  const h = await boot(withFinds([{ ...RICH_FIND, orderLimit: 2 }]));
  assert.match(h.doc.querySelector('#finds-list .meta')?.textContent ?? '', /limit 2 per order/);
});

test('a find recorded before any of this still renders', async () => {
  // Eleven rows predate these columns. A review list that throws on them is
  // worse than one that says a little less about them.
  const bare = {
    id: 3, sourceId: 'target-tcg', externalId: '1', name: 'An older find',
    url: '', price: null, kind: '', confidence: '', foundBy: '', imageUrl: '',
    status: 'new', firstSeenAt: new Date().toISOString(), alreadyHave: false,
  };
  const h = await boot(withFinds([bare]));
  assert.match($(h, '#finds-list').textContent, /An older find/);
  assert.equal(findPills(h).length, 0, 'nothing is claimed about it');
});

test('an image the retailer refuses looks different from one we never had', async () => {
  // Only one of the two is a bug, and they were indistinguishable.
  const h = await boot(withFinds([{ ...RICH_FIND, imageUrl: 'https://example.test/x.jpg' }]));
  const img = h.doc.querySelector('#finds-list img.thumb') as HTMLImageElement;
  assert.ok(img, 'the image is attempted');
  img.dispatchEvent(new h.dom.window.Event('error'));
  const ph = h.doc.querySelector('#finds-list .thumb.broken');
  assert.ok(ph, 'a refused image gets its own marker');
  assert.match(ph.getAttribute('title') ?? '', /would not serve/);
});

test('THE FINDS LIST LEADS WITH WHAT YOU CAN ACT ON', async () => {
  // Walmart's catalogue runs back years with no release date to judge age by,
  // so a long list is unavoidable. Ordering it is what stops it being a wall.
  const at = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const h = await boot(withFinds([
    { ...RICH_FIND, id: 1, name: 'Dormant back-catalogue', state: 'out', signal: '', releaseDate: '', firstSeenAt: at(1) },
    { ...RICH_FIND, id: 2, name: 'Sold out recently', state: 'out', signal: 'recent', releaseDate: '', firstSeenAt: at(1) },
    { ...RICH_FIND, id: 3, name: 'Dated and ahead', state: 'out', signal: '', releaseDate: soon, firstSeenAt: at(1) },
    { ...RICH_FIND, id: 4, name: 'Buyable now', state: 'in', signal: 'buyable', releaseDate: '', firstSeenAt: at(1) },
    { ...RICH_FIND, id: 5, name: 'A pre-order', state: 'in', isPreOrder: true, releaseDate: '', firstSeenAt: at(1) },
  ]));
  const names = [...h.doc.querySelectorAll('#finds-list .name')].map((n) => n.textContent);
  assert.deepEqual(names, [
    'A pre-order',
    'Buyable now',
    'Dated and ahead',
    'Sold out recently',
    'Dormant back-catalogue',
  ]);
});

test('within a band, the newest find comes first', async () => {
  const at = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  const h = await boot(withFinds([
    { ...RICH_FIND, id: 1, name: 'Found last week', state: 'in', signal: 'buyable', releaseDate: '', firstSeenAt: at(7) },
    { ...RICH_FIND, id: 2, name: 'Found today', state: 'in', signal: 'buyable', releaseDate: '', firstSeenAt: at(0) },
  ]));
  const names = [...h.doc.querySelectorAll('#finds-list .name')].map((n) => n.textContent);
  assert.deepEqual(names, ['Found today', 'Found last week']);
});
