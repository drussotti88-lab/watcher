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
import { test, afterEach } from 'node:test';
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
  // The owner's view. Every test below describes what the person who curates
  // the catalogue sees; the member's view is a smaller page and is tested
  // against `canCurate: false` where it differs.
  canCurate: true,
  requests: [],
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
  OPEN.push(dom);
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

/*
 * Close the windows.
 *
 * Every boot() builds a whole JSDOM — document, timers, an event loop's worth
 * of listeners — and none of them were ever torn down. At a hundred tests that
 * is untidy; at two hundred and forty it is a suite that gets OOM-killed the
 * moment it shares a machine with three others, and reports "fail 2" with no
 * failing assertion anywhere in it.
 *
 * A test run that dies of its own weight is indistinguishable from a bug, and
 * the wrong one is much easier to chase.
 */
const OPEN: { window: { close(): void } }[] = [];
afterEach(() => {
  for (const d of OPEN) {
    try { d.window.close(); } catch { /* already gone */ }
  }
  OPEN.length = 0;
});

const $ = (h: Harness, sel: string): any => h.doc.querySelector(sel);
const submit = (form: any, win: any): void => {
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
};

/**
 * Open a mission's pop-up the way a person does: by pressing the card.
 *
 * It used to be a Settings button. The card itself is the control now, which
 * is why every test that used to click that button goes through here.
 */
const openMission = (h: Harness, idx = 0): void => {
  const cards = [...h.doc.querySelectorAll('#missions .card')];
  assert.ok(cards[idx], 'a mission card should open its pop-up');
  (cards[idx] as HTMLElement).click();
};

/** The same pop-up, showing the other tab. */
const openMissionRuns = (h: Harness, idx = 0): void => {
  openMission(h, idx);
  const tab = [...h.doc.querySelectorAll('#detail-body .dlgtabs button')]
    .find((b) => b.textContent === 'Run history');
  assert.ok(tab, 'the pop-up should offer the history');
  (tab as HTMLButtonElement).click();
};
const openProduct = (h: Harness, idx = 0): void => {
  const btns = [...h.doc.querySelectorAll('#products button')]
    .filter((b) => b.textContent === 'Listings & details');
  assert.ok(btns[idx], 'a product card should offer its pop-up');
  (btns[idx] as HTMLButtonElement).click();
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
  // The dashboard is the landing tab now — it answers "where are we losing
  // it", which is the question you have before you have a specific mission.
  assert.equal($(h, '#tab-home').hidden, false);
  assert.equal($(h, '#tab-missions').hidden, true);
  assert.equal($(h, '#tab-products').hidden, true);

  (h.doc.querySelector('[data-tab=missions]') as any).click();
  assert.equal($(h, '#tab-home').hidden, true);
  assert.equal($(h, '#tab-missions').hidden, false);

  (h.doc.querySelector('[data-tab=products]') as any).click();
  assert.equal($(h, '#tab-missions').hidden, true);
  assert.equal($(h, '#tab-products').hidden, false);
  assert.equal($(h, '#tab-activity').hidden, true);
});

test('saving a mission sends the settings actually on screen', async () => {
  const h = await boot();
  openMission(h);
  const form = $(h, 'form[data-mission="1"]');
  assert.ok(form, 'the mission pop-up should be rendered');

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
  openMission(h);
  const form = $(h, 'form[data-mission="1"]');
  form.querySelector('[name=ceiling]').value = '';
  h.reply('POST /api/missions', { mission: {} });

  submit(form, h.dom.window);
  await h.settle();

  assert.equal(h.calls.find((c) => c.path === '/api/missions')!.body.ceiling, null);
});

test('ticking Armed warns before anything is saved', async () => {
  // With a spend cap in place — without one the tick now refuses outright,
  // which its own test covers below.
  const h = await boot({ ...DASHBOARD, settings: { taxRate: 0, shippingAllowance: 0, spendCapDay: 200 } });
  openMission(h);
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
  openProduct(h);

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
  openMission(h);
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
  // The Hub has no browser and Phantom will not jump the retailer's pacing
  // for a button click. Wording that promises otherwise is a claim neither of
  // them can keep.
  const h = await boot();
  openMission(h);
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
  openMission(h);
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
  openMission(h);
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
  openMission(h);
  assert.equal($(h, 'form[data-mission="1"]').querySelector('[name=ceiling]').value, '40');
});

test('with no MSRP the box stays empty and says why', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].ceiling = null;
  d.missions[0].msrp = null;

  const h = await boot(d);
  openMission(h);
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
  openMission(h);
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
  // "checking", not "queued". Phantom asks the Hub for these every few
  // seconds now, so the honest word is the present tense.
  assert.match(btn.textContent, /checking/i);
});

test('A PRESSED BUTTON COUNTS RATHER THAN GOING QUIET', async () => {
  // It used to become a dead pill reading "check queued" and stay that way,
  // sometimes for minutes. A button that goes quiet is indistinguishable from
  // a broken one, and this one was being pressed during drops.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].checkNow = true;
  d.missions[0].checkNowAt = new Date(Date.now() - 40_000).toISOString();
  d.agentSeenAt = new Date(Date.now() - 5_000).toISOString();

  const h = await boot(d);
  const btn = [...h.doc.querySelectorAll('#missions button')].find(
    (b: any) => /checking/i.test(b.textContent),
  ) as any;
  assert.ok(btn, 'it says what it is doing');
  assert.equal(btn.disabled, true);
  assert.match(btn.textContent, /4[0-9]s/, 'and how long it has been doing it');
});

test('a fresh press does not put a stopwatch on screen', async () => {
  // Counting from zero would make three normal seconds look like a problem.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].checkNow = true;
  d.missions[0].checkNowAt = new Date(Date.now() - 2_000).toISOString();
  d.agentSeenAt = new Date().toISOString();

  const h = await boot(d);
  const btn = [...h.doc.querySelectorAll('#missions button')].find(
    (b: any) => /checking/i.test(b.textContent),
  ) as any;
  assert.equal(btn.textContent, 'checking…');
});

test('IT NAMES THE REAL REASON WHEN THE MACHINE IS NOT RUNNING', async () => {
  // Nine times out of ten a button that never resolves is not a slow button.
  // Saying "checking…" over a dead watcher is the app lying on its behalf.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].checkNow = true;
  d.missions[0].checkNowAt = new Date(Date.now() - 60_000).toISOString();
  d.agentSeenAt = new Date(Date.now() - 40 * 60_000).toISOString();

  const h = await boot(d);
  const btn = [...h.doc.querySelectorAll('#missions button')].find(
    (b: any) => /Phantom is not running/i.test(b.textContent),
  ) as any;
  assert.ok(btn, 'it says what is actually wrong');
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
  //
  // 14, not 12: the fixture carries a per-order limit of 12, and a count that
  // lands exactly on the limit is a ceiling rather than a census (see
  // isCapped). Using the limit as the "genuine number" tested the opposite of
  // what this test is named for.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'in';
  d.missions[0].availableQuantity = 14;
  const h = await boot(d);
  assert.match($(h, '#missions').textContent, /14 available/);
});

test('A COUNT THAT LANDS ON THE ORDER LIMIT IS A FLOOR', async () => {
  // The measured rule. Every captured Target response that states both numbers
  // states the same number twice: atp 20 against limit 20, atp 10 against
  // limit 10. So the count is clamped to the limit, and "12 of 12" means at
  // least twelve. Saying "12 available" there is a claim Target never made.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'in';
  d.missions[0].availableQuantity = 12;
  d.missions[0].orderLimit = 12;
  const h = await boot(d);
  const text = $(h, '#missions').textContent;
  assert.match(text, /12\+ available/);
  assert.doesNotMatch(text, /12 available/);
});

test('a count above the order limit is not a clamp, so it is printed plainly', async () => {
  // Clamping can only bring a number down. A count sitting above the limit
  // therefore cannot be the limit showing through, whatever else it is.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].state = 'in';
  d.missions[0].availableQuantity = 31;
  d.missions[0].orderLimit = 2;
  const h = await boot(d);
  assert.match($(h, '#missions').textContent, /31 available/);
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

test('AN OUT-OF-STOCK ITEM WITH A KNOWN RELEASE DATE SAYS SO', async () => {
  // Without this, a box releasing on Tuesday and a box that sold out in March
  // render identically: one grey OUT OF STOCK pill each.
  //
  // RELEASES, not DROPS. A street date is when the product first exists; a
  // drop is a retailer putting stock up, which happens many times afterwards
  // and is never announced. Saying "drops in 18 days" promised stock on a day
  // that only promises existence.
  const h = await boot(withRelease({ releaseDate: inDays(18) }));
  assert.match(pills(h), /releases in 18 days/);
  assert.doesNotMatch(pills(h), /drops in/i, 'a street date never claims a drop');
});

test('the day itself is called out, not counted', async () => {
  const h = await boot(withRelease({ releaseDate: inDays(0) }));
  assert.match(pills(h), /RELEASES TODAY/);
  assert.ok(!pills(h).includes('releases in 0 days'));
});

test('tomorrow reads as tomorrow', async () => {
  const h = await boot(withRelease({ releaseDate: inDays(1) }));
  assert.match(pills(h), /releases tomorrow/);
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
  // Phantom and the Hub deploy separately, and an old payload with no
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
  assert.equal($(running, '#phantom-toggle').textContent, 'Turn Phantom off');

  const stopped = await boot(withSweep({}, { paused: true }));
  assert.equal($(stopped, '#phantom-toggle').textContent, 'Turn Phantom on');
});

test('turning Phantom off asks first, and then says so', async () => {
  const h = await boot(withSweep({}, { paused: false }));
  h.reply('POST /api/settings', { settings: {} });

  $(h, '#phantom-toggle').click();
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

  $(h, '#phantom-toggle').click();
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
    withSweep({ lastSweptAt: new Date(Date.now() - 3600_000).toISOString(), lastStatus: 'Phantom: 2 new' }),
  );
  const title = $(h, '#sweep-now').title;
  assert.match(title, /last swept/);
  assert.match(title, /2 new/);
});

test('a dashboard with no sweep block still renders the bar', async () => {
  // The Hub and Phantom deploy separately; an older payload must not take
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
  const h = await boot(withSweep({ queued: true, lastStatus: 'Phantom: 2 new' }));
  assert.equal($(h, '#sweep-now').textContent, 'sweep queued');
});

test('and when it is over it offers another', async () => {
  const h = await boot(withSweep({ queued: false, lastStatus: 'Phantom: 2 new' }));
  assert.equal($(h, '#sweep-now').textContent, 'Run catalogue sweep');
  assert.equal($(h, '#sweep-now').disabled, false);
});

test('NO TAB CAN RUN OFF THE EDGE OF A PHONE', async () => {
  // The original bug: six tabs are wider than a phone and the sixth was simply
  // gone — no scrollbar, no affordance, just off the right-hand side. It used
  // to be fixed by wrapping onto two rows; it is now fixed by the six of them
  // sharing the width. Either way the rule is that nothing is off-screen.
  const h = await boot();
  const style = h.doc.querySelector('style').textContent;
  const phone = /@media \(max-width: 899px\) \{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
  assert.match(phone, /\.tab \{[^}]*flex:\s*1 1 0/, 'every tab takes an equal share');
  assert.match(phone, /min-width:\s*0/, 'and none of them can refuse to shrink');
});

test('THE PHONE NAV IS AT THE BOTTOM, WHERE THE THUMB IS', async () => {
  const h = await boot();
  const style = h.doc.querySelector('style').textContent;
  const phone = /@media \(max-width: 899px\) \{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
  assert.match(phone, /\.tabs \{[^}]*position:\s*fixed/);
  assert.match(phone, /\.tabs \{[^}]*bottom:\s*0/);
  assert.match(phone, /\.tabs \{[^}]*top:\s*auto/, 'and explicitly not stuck to the top');
});

test('CONTENT CLEARS THE BOTTOM BAR, INCLUDING THE HOME INDICATOR', async () => {
  // A fixed bar with nothing reserved for it hides the last card on the page,
  // and on an iPhone the labels sit under the home indicator and read as
  // clipped. Both are the same one-line mistake.
  const h = await boot();
  const style = h.doc.querySelector('style').textContent;
  const phone = /@media \(max-width: 899px\) \{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
  assert.match(phone, /padding-bottom:\s*calc\(58px \+ env\(safe-area-inset-bottom/);
  assert.match(phone, /\.tabs \{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom/);
});

test('every nav item has an icon and a label, and the icon is not announced', async () => {
  // A bottom bar is scanned by shape. But the icon is decoration: the label
  // beside it is the accessible name, and "image, crosshair, Missions" is
  // worse than silence.
  const h = await boot();
  const tabs = [...h.doc.querySelectorAll('.tab')];
  assert.equal(tabs.length, 7);
  for (const t of tabs) {
    const ico = t.querySelector('svg.ico');
    assert.ok(ico, `${t.dataset.tab} has no icon`);
    assert.equal(ico.getAttribute('aria-hidden'), 'true');
    assert.ok(t.textContent.trim().length > 0, `${t.dataset.tab} has no label`);
  }
});

test('the wordmark survives on a phone, where the side panel is gone', async () => {
  const h = await boot();
  const inHeader = h.doc.querySelector('header .phonebrand .brand-name');
  assert.equal(inHeader?.textContent, 'Phantom by DNA');
  const style = h.doc.querySelector('style').textContent;
  assert.match(style, /\.phonebrand \{[^}]*display:\s*none/, 'hidden by default');
  assert.match(style, /@media \(max-width: 899px\) \{ \.phonebrand \{ display: flex/);
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
  openMission(h);
  const form = h.doc.querySelector('#detail-dialog form');
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
    // Genuinely older — a find first seen in the last 48h would honestly earn
    // the NEW pill, and this test is about rows with nothing left to claim.
    status: 'new', firstSeenAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    alreadyHave: false,
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
  // The dormant one is not in this list — it is behind the fold, with a count
  // on it. Order is about the ones you might act on.
  assert.deepEqual(names.slice(0, 4), [
    'A pre-order',
    'Buyable now',
    'Dated and ahead',
    'Sold out recently',
  ]);
  assert.ok(!names.includes('Dormant back-catalogue'));
  assert.match($(h, '#finds-list').textContent, /1 more from the back catalogue/);
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

// ── Filtering ninety-eight finds down to a decision ──────────────────────────

const findNames = (h: Harness): string[] =>
  [...h.doc.querySelectorAll('#finds-list .name')].map((n) => n.textContent ?? '');
const chips = (h: Harness, id: string): string[] =>
  [...h.doc.querySelectorAll('#' + id + ' .chip')].map((c) => c.textContent ?? '');
/**
 * Open the mission filter panel.
 *
 * Status and mode live behind one control now. Twelve chips in three groups
 * was six rows on a phone before any content — the shop is the lens people
 * use on every visit, and the rest are asked for occasionally, so they are
 * one tap away instead of always on screen.
 */
const openMissionFilters = (h: Harness): void => {
  const b = h.doc.getElementById('flt-missions-more') as any;
  assert.ok(b && !b.hidden, 'the way into the filters should be offered');
  if (b.getAttribute('aria-expanded') !== 'true') b.click();
};

const pressChip = (h: Harness, id: string, startsWith: string): void => {
  const c = [...h.doc.querySelectorAll('#' + id + ' .chip')]
    .find((b) => (b.textContent ?? '').startsWith(startsWith));
  assert.ok(c, 'no chip starting ' + startsWith + ' in ' + chips(h, id).join(' | '));
  (c as HTMLButtonElement).click();
};

const MIXED = [
  { ...RICH_FIND, id: 1, name: 'PC pre-order', retailer: 'Pokemon Center',
    isPreOrder: true, state: 'in', signal: 'scheduled', releaseDate: '' },
  { ...RICH_FIND, id: 2, name: 'Target in stock', retailer: 'Target',
    isPreOrder: false, state: 'in', signal: 'buyable', releaseDate: '' },
  { ...RICH_FIND, id: 3, name: 'Walmart recent', retailer: 'Walmart',
    isPreOrder: false, state: 'out', signal: 'recent', releaseDate: '' },
  { ...RICH_FIND, id: 4, name: 'Walmart Boltund V Box', retailer: 'Walmart',
    isPreOrder: false, state: 'out', signal: '', releaseDate: '', confidence: 'sealed' },
  { ...RICH_FIND, id: 5, name: 'Walmart Infernape V Box', retailer: 'Walmart',
    isPreOrder: false, state: 'out', signal: '', releaseDate: '', confidence: 'sealed' },
];

test('THE BACK CATALOGUE IS FOLDED AWAY, NOT THROWN AWAY', async () => {
  // Walmart publishes no date on a search result, so old and new cannot be
  // told apart — a filter that hid the old would hide real finds with them.
  // One click, with the count on it, is the honest version.
  const h = await boot(withFinds(MIXED));
  const names = findNames(h);
  assert.ok(names.includes('PC pre-order'));
  assert.ok(names.includes('Walmart recent'));
  assert.ok(!names.includes('Walmart Boltund V Box'), 'dormant is folded away');
  assert.match($(h, '#finds-list').textContent, /2 more from the back catalogue/);

  const show = [...h.doc.querySelectorAll('#finds-list button')]
    .find((b) => b.textContent === 'Show them');
  assert.ok(show, 'and there is a way to see it');
  (show as HTMLButtonElement).click();
  assert.ok(findNames(h).includes('Walmart Boltund V Box'), 'nothing is hidden permanently');
});

test('filtering by shop narrows the list', async () => {
  const h = await boot(withFinds(MIXED));
  pressChip(h, 'find-shops', 'Walmart');
  const names = findNames(h);
  assert.ok(names.includes('Walmart recent'));
  assert.ok(!names.includes('Target in stock'));
  assert.ok(!names.includes('PC pre-order'));
});

test('pressing the same shop again clears it', async () => {
  const h = await boot(withFinds(MIXED));
  pressChip(h, 'find-shops', 'Target');
  assert.equal(findNames(h).length, 1);
  pressChip(h, 'find-shops', 'Target');
  assert.ok(findNames(h).includes('PC pre-order'), 'back to everything');
});

test('a chip says how many pressing it would give you', async () => {
  const h = await boot(withFinds(MIXED));
  const walmart = chips(h, 'find-shops').find((c) => c.startsWith('Walmart'));
  assert.equal(walmart, 'Walmart3', 'three Walmart finds, dormant ones included');
  const pre = chips(h, 'find-states').find((c) => c.startsWith('Pre-order'));
  assert.equal(pre, 'Pre-order1');
});

test('COUNTS RESPECT THE OTHER FILTERS', async () => {
  // Otherwise a chip promises nine and delivers none, which is worse than no
  // count at all.
  const h = await boot(withFinds(MIXED));
  pressChip(h, 'find-shops', 'Walmart');
  const pre = chips(h, 'find-states').find((c) => c.startsWith('Pre-order'));
  assert.equal(pre, 'Pre-order0', 'no Walmart pre-orders, and it says so');
  const anyStatus = chips(h, 'find-states').find((c) => c.startsWith('Any status'));
  assert.equal(anyStatus, 'Any status3');
});

test('a status filter finds pre-orders without also matching in-stock', async () => {
  const h = await boot(withFinds(MIXED));
  pressChip(h, 'find-states', 'Pre-order');
  assert.deepEqual(findNames(h), ['PC pre-order']);

  const h2 = await boot(withFinds(MIXED));
  pressChip(h2, 'find-states', 'In stock');
  // The pre-order is state 'in' too, and must not answer to "in stock".
  assert.deepEqual(findNames(h2), ['Target in stock']);
});

test('searching matches every word, in any order', async () => {
  const h = await boot(withFinds(MIXED));
  const box = h.doc.getElementById('find-q') as HTMLInputElement;
  box.value = 'box boltund';
  box.dispatchEvent(new h.dom.window.Event('input'));
  assert.deepEqual(findNames(h), ['Walmart Boltund V Box']);
});

test('the search reaches the retailer and the kind, not only the name', async () => {
  const h = await boot(withFinds(MIXED));
  const box = h.doc.getElementById('find-q') as HTMLInputElement;
  box.value = 'pokemon center';
  box.dispatchEvent(new h.dom.window.Event('input'));
  assert.deepEqual(findNames(h), ['PC pre-order']);
});

test('filters that match nothing say so, and offer a way back', async () => {
  const h = await boot(withFinds(MIXED));
  const box = h.doc.getElementById('find-q') as HTMLInputElement;
  box.value = 'charizard';
  box.dispatchEvent(new h.dom.window.Event('input'));
  assert.match($(h, '#finds-list').textContent, /Nothing matches those filters/);
  assert.match($(h, '#finds-list').textContent, /5 discoveries are waiting/);

  const clear = [...h.doc.querySelectorAll('#finds-list button')]
    .find((b) => b.textContent === 'Clear filters');
  assert.ok(clear);
  (clear as HTMLButtonElement).click();
  assert.ok(findNames(h).includes('PC pre-order'));
  assert.equal(box.value, '', 'and the box is emptied with them');
});

test('the count line says what you are looking at', async () => {
  const h = await boot(withFinds(MIXED));
  assert.match($(h, '#find-count').textContent, /Showing 3 of 5/);
  pressChip(h, 'find-shops', 'Target');
  assert.match($(h, '#find-count').textContent, /Showing 1 of 5/);
});

test('a list with no dormant tail shows everything and says so', async () => {
  const h = await boot(withFinds([MIXED[0]!, MIXED[1]!]));
  assert.match($(h, '#find-count').textContent, /All 2 waiting on you/);
  assert.ok(!$(h, '#finds-list').textContent.includes('back catalogue'));
});

test('a list that is ALL back catalogue is not an empty page', async () => {
  // Folding away every single row would read as "nothing found", which is a
  // confident wrong answer.
  const h = await boot(withFinds([MIXED[3]!, MIXED[4]!]));
  assert.equal(findNames(h).length, 2);
});

test('A FIND WARNS YOU WHEN RESELLERS HOLD THE BUY BOX', async () => {
  // The find is right: Walmart's own listing, Walmart's own price, out of
  // stock. Then the link opens a page showing a marketplace seller at forty
  // times the money. Clicking through should never be a surprise.
  const h = await boot(withFinds([
    { ...RICH_FIND, retailer: 'Walmart', state: 'out', isPreOrder: false,
      releaseDate: '', signal: 'recent', price: 49.87, otherOffers: 6 },
  ]));
  assert.ok(findPills(h).includes('6 resellers have the buy box'),
    findPills(h).join(' | '));
  // And the price is labelled as the retailer's, not the page's.
  assert.match(h.doc.querySelector('#finds-list .meta')?.textContent ?? '',
    /\$49\.87 at Walmart/);
});

test('one reseller is singular', async () => {
  const h = await boot(withFinds([
    { ...RICH_FIND, retailer: 'Walmart', state: 'out', releaseDate: '', otherOffers: 1 },
  ]));
  assert.ok(findPills(h).includes('1 reseller has the buy box'));
});

test('no warning when the retailer has it in stock itself', async () => {
  // The buy box is the retailer's when the retailer has stock, whatever else
  // is listed behind it. Warning then would be crying wolf.
  const h = await boot(withFinds([
    { ...RICH_FIND, retailer: 'Walmart', state: 'in', releaseDate: '', otherOffers: 6 },
  ]));
  assert.ok(!findPills(h).some((p) => p.includes('buy box')));
  assert.match(h.doc.querySelector('#finds-list .meta')?.textContent ?? '', /\$59\.99$|\$59\.99 ·/);
});

test('a find with no offer count claims nothing about resellers', async () => {
  const h = await boot(withFinds([
    { ...RICH_FIND, retailer: 'Pokemon Center', state: 'out', releaseDate: '', otherOffers: null },
  ]));
  assert.ok(!findPills(h).some((p) => p.includes('buy box')));
});

// ── Is this price sane? ──────────────────────────────────────────────────────

test('A FIND SAYS WHAT THAT KIND OF THING USUALLY COSTS', async () => {
  // Looking at "Walmart · tin · $15.95" and wondering whether that is a good
  // price is the whole reason to open the page. Answer it on the card.
  const h = await boot(withFinds([
    { ...RICH_FIND, kind: 'mini tin', price: 15.95, retailer: 'Walmart',
      state: 'out', releaseDate: '', otherOffers: null },
  ]));
  const meta = h.doc.querySelector('#finds-list .meta')?.textContent ?? '';
  assert.match(meta, /\$15\.95/);
  assert.match(meta, /usually \$12\.99/);
});

test('a price well above the usual one is flagged with the multiple', async () => {
  const h = await boot(withFinds([
    { ...RICH_FIND, kind: 'booster box', price: 3999.99, retailer: 'Walmart',
      state: 'in', releaseDate: '', otherOffers: null },
  ]));
  assert.ok(findPills(h).some((p) => p.includes('× the usual price')), findPills(h).join(' | '));
  assert.ok(findPills(h).some((p) => p.startsWith('24.')), 'and says how far above');
});

test('AN ORDINARY FIRST-PARTY PRICE IS NOT FLAGGED', async () => {
  // $9.99 at Pokémon Center against $11.99 at Target — both honest. A flag
  // that fires here is one nobody reads by the time it matters.
  const h = await boot(withFinds([
    { ...RICH_FIND, kind: 'collection box', price: 11.99, retailer: 'Target',
      state: 'in', releaseDate: '', otherOffers: null },
  ]));
  assert.ok(!findPills(h).some((p) => p.includes('usual price')), findPills(h).join(' | '));
});

test('a kind with no typical price says nothing rather than guessing', async () => {
  const h = await boot(withFinds([
    { ...RICH_FIND, kind: '', price: 49.99, releaseDate: '', otherOffers: null },
  ]));
  const meta = h.doc.querySelector('#finds-list .meta')?.textContent ?? '';
  assert.ok(!meta.includes('usually'), meta);
  assert.ok(!findPills(h).some((p) => p.includes('usual price')));
});

test('a find with no price is not compared to anything', async () => {
  const h = await boot(withFinds([
    { ...RICH_FIND, kind: 'tin', price: null, releaseDate: '', otherOffers: null },
  ]));
  assert.ok(!findPills(h).some((p) => p.includes('usual price')));
  // The reference is still worth showing — it is about the kind, not the price.
  assert.match(h.doc.querySelector('#finds-list .meta')?.textContent ?? '', /usually \$24\.99/);
});

// ── Money on the page ────────────────────────────────────────────────────────

test('AN OPEN GRANT PUTS A BANNER AT THE TOP, WITH A RELEASE PATH', async () => {
  // A live grant is either a buy in progress or a Phantom that died between
  // add-to-cart and the button. The second one is invisible everywhere else.
  const h = await boot({
    ...DASHBOARD,
    settings: { taxRate: 0, shippingAllowance: 0, spendCapDay: 200 },
    committed: 65,
    authorisations: [
      { id: 42, missionId: 1, amount: 65, status: 'granted',
        grantedAt: new Date().toISOString(), resolvedAt: null, note: '' },
    ],
  });
  const banner = h.doc.getElementById('money-banner');
  assert.equal(banner?.hidden, false);
  assert.match($(h, '#money-banner-detail').textContent, /\$65\.00 of \$200\.00/);
  assert.match($(h, '#money-banner').textContent, /Pitch Black ETB/, 'names the mission');
  assert.ok([...banner!.querySelectorAll('button')].some((b) => b.textContent === 'Release'));
});

test('no open grants, no banner', async () => {
  const h = await boot({ ...DASHBOARD, authorisations: [], committed: 0 });
  assert.equal(h.doc.getElementById('money-banner')?.hidden, true);
});

test('releasing a grant asks for the look first, then resolves it', async () => {
  const h = await boot({
    ...DASHBOARD,
    settings: { taxRate: 0, shippingAllowance: 0, spendCapDay: 200 },
    committed: 65,
    authorisations: [
      { id: 42, missionId: 1, amount: 65, status: 'granted',
        grantedAt: new Date().toISOString(), resolvedAt: null, note: '' },
    ],
  });
  // Declining the confirm must do nothing at all.
  (h.dom.window as never as { confirm: () => boolean }).confirm = () => false;
  const release = [...h.doc.querySelectorAll('#money-banner button')]
    .find((b) => b.textContent === 'Release') as HTMLButtonElement;
  release.click();
  await h.settle();
  assert.ok(!h.calls.some((c) => c.path.includes('/resolve')), 'no confirm, no call');

  (h.dom.window as never as { confirm: () => boolean }).confirm = () => true;
  h.reply('POST /api/authorisations/42/resolve', { authorisation: { id: 42, status: 'released' } });
  release.click();
  await h.settle();
  const call = h.calls.find((c) => c.path === '/api/authorisations/42/resolve');
  assert.ok(call, 'confirmed, so the release goes through');
  assert.equal(call!.body.result, 'released');
});

test('THE ARM CHECKBOX REFUSES WITHOUT A SPEND CAP, AND SAYS WHY', async () => {
  const h = await boot({
    ...DASHBOARD,
    settings: { taxRate: 0, shippingAllowance: 0, spendCapDay: null },
  });
  // Open the first mission's pop-up and try to arm it.
  openMission(h);
  const armed = h.doc.querySelector('#detail-dialog input[name="armed"]') as HTMLInputElement;
  assert.ok(armed, 'there is an arm control');
  armed.checked = true;
  armed.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal(armed.checked, false, 'the tick does not stick');
  // The refusal renders where the tick happened — inside the pop-up.
  assert.match($(h, '#detail-dialog').textContent, /daily spend cap in Settings first/);
});

test('with a cap set, the arm checkbox warns about what arming means', async () => {
  const h = await boot({
    ...DASHBOARD,
    settings: { taxRate: 0, shippingAllowance: 0, spendCapDay: 200 },
  });
  openMission(h);
  const armed = h.doc.querySelector('#detail-dialog input[name="armed"]') as HTMLInputElement;
  armed.checked = true;
  armed.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal(armed.checked, true, 'the cap exists, so arming is a real choice');
});

// ── Filters on every list, not just the finds ────────────────────────────────
//
// Same contract the finds bar established: static search box, chips whose
// counts respect the other filters, a count line, and a way back. These tests
// drive the missions, products, and activity bars the same way a person does.

const BASE_MISSION = DASHBOARD.missions[0]!;
const missionRow = (over: Record<string, unknown>) => ({ ...BASE_MISSION, ...over });

const LISTED = {
  ...DASHBOARD,
  missions: [
    missionRow({ id: 1, listingId: 11, productName: 'Alpha ETB', retailer: 'Target',
      state: 'in', isPreOrder: false, armed: false, enabled: true }),
    missionRow({ id: 2, listingId: 12, productName: 'Bravo Booster Box', retailer: 'Target',
      state: 'out', isPreOrder: false, armed: true, enabled: true }),
    missionRow({ id: 3, listingId: 13, productName: 'Charlie Tin', retailer: 'Walmart',
      state: 'out', isPreOrder: false, armed: false, enabled: true }),
    missionRow({ id: 4, listingId: 14, productName: 'Delta UPC', retailer: 'Pokemon Center',
      state: 'in', isPreOrder: true, armed: false, enabled: true }),
    missionRow({ id: 5, listingId: 15, productName: 'Echo Bundle', retailer: 'Walmart',
      state: 'in', isPreOrder: false, armed: false, enabled: false }),
    missionRow({ id: 6, listingId: 16, productName: 'Foxtrot Collection', retailer: 'Target',
      state: 'out', isPreOrder: false, armed: false, enabled: true }),
  ],
  products: [
    { key: 'p1', name: 'Alpha ETB', releaseDate: null, msrp: 49.99, imageUrl: '', notes: '' },
    { key: 'p2', name: 'Bravo Booster Box', releaseDate: null, msrp: 161.64, imageUrl: '', notes: '' },
    { key: 'p3', name: 'Charlie Tin', releaseDate: null, msrp: 24.99, imageUrl: '', notes: '' },
    { key: 'p4', name: 'Delta UPC', releaseDate: null, msrp: 119.99, imageUrl: '', notes: '' },
    { key: 'p5', name: 'Echo Bundle', releaseDate: null, msrp: 26.94, imageUrl: '', notes: '' },
    { key: 'p6', name: 'Foxtrot Collection', releaseDate: null, msrp: 39.99, imageUrl: '', notes: '' },
  ],
  runs: [
    { startedAt: new Date(Date.now() - 60_000).toISOString(), productName: 'Alpha ETB',
      retailer: 'Target', outcome: 'in_stock', reason: 'in stock at $49.99', price: 49.99, ms: 800 },
    { startedAt: new Date(Date.now() - 120_000).toISOString(), productName: 'Charlie Tin',
      retailer: 'Walmart', outcome: 'failed', reason: 'browser has been closed', price: null, ms: 20 },
    { startedAt: new Date(Date.now() - 180_000).toISOString(), productName: 'Bravo Booster Box',
      retailer: 'Target', outcome: 'dry_run', reason: 'would have bought 1', price: 161.64, ms: 900 },
  ],
  changes: [
    { at: new Date(Date.now() - 60_000).toISOString(), productName: 'Alpha ETB',
      retailer: 'Target', state: 'in', price: 49.99 },
    { at: new Date(Date.now() - 90_000).toISOString(), productName: 'Echo Bundle',
      retailer: 'Walmart', state: 'out', price: null },
    { at: new Date(Date.now() - 120_000).toISOString(), productName: 'Delta UPC',
      retailer: 'Pokemon Center', state: 'in', price: 119.99 },
  ],
};

const missionNames = (h: Harness): string[] =>
  [...h.doc.querySelectorAll('#missions .name')].map((n) => n.textContent ?? '');
const productNames = (h: Harness): string[] =>
  [...h.doc.querySelectorAll('#products .name')].map((n) => n.textContent ?? '');
const typeInto = (h: Harness, id: string, value: string): void => {
  const box = h.doc.getElementById(id) as HTMLInputElement;
  box.value = value;
  box.dispatchEvent(new h.dom.window.Event('input'));
};

test('A SHORT LIST GETS NO FILTERS AT ALL, A LONG ONE OFFERS THEM', async () => {
  // One mission does not need a search box; the bar would be clutter that
  // says "this app is complicated" on the first screen.
  const short = await boot(DASHBOARD);
  assert.equal((short.doc.getElementById('flt-missions-more') as any).hidden, true);
  assert.equal((short.doc.getElementById('flt-missions') as any).hidden, true);
  assert.equal(short.doc.querySelectorAll('#flt-missions-shops .chip').length, 0);

  const long = await boot(LISTED);
  assert.equal((long.doc.getElementById('flt-missions-more') as any).hidden, false);
  assert.ok(long.doc.querySelectorAll('#flt-missions-shops .chip').length > 1, 'the shop lens is out');
  assert.equal((long.doc.getElementById('flt-products') as any).hidden, false);
  assert.equal((long.doc.getElementById('flt-activity') as any).hidden, false);
});

test('THE VIEW SWITCHER SURVIVES A SHORT LIST', async () => {
  // It used to sit on a row of its own, which is what made this safe. Now it
  // shares the filter row — and six cards still deserve a choice about how
  // they are laid out.
  const h = await boot(DASHBOARD);
  const vt = h.doc.querySelector('.fltrow .vt[data-list=missions]');
  assert.ok(vt, 'the switcher is still there with no filters on screen');
});

test('STOCK STATUS IS ONE TAP AWAY; ARMED AND PAUSED ARE ALWAYS ON SCREEN', async () => {
  // Mode came out from behind the button. "Which of these is switched on" is
  // asked as often as "which shop", and it was two clicks away.
  const h = await boot(LISTED);
  assert.equal((h.doc.getElementById('flt-missions') as any).hidden, true, 'panel shut to begin with');
  assert.ok(
    chips(h, 'flt-missions-modes').some((c) => c.startsWith('Any mode')),
    'mode is visible without opening anything',
  );
  openMissionFilters(h);
  assert.equal((h.doc.getElementById('flt-missions') as any).hidden, false);
  assert.ok(chips(h, 'flt-missions-chips').some((c) => c.startsWith('Any status')));
  assert.ok(
    !chips(h, 'flt-missions-chips').some((c) => c.startsWith('Any mode')),
    'and not shown twice',
  );
});

test('A FILTER LEFT ON WHILE THE PANEL IS SHUT STAYS VISIBLE', async () => {
  // The failure this prevents: rows are being hidden and the thing hiding them
  // is itself hidden. That is not a tidy interface, it is a bug report.
  const h = await boot(LISTED);
  openMissionFilters(h);
  pressChip(h, 'flt-missions-chips', 'In stock');
  (h.doc.getElementById('flt-missions-more') as any).click();

  assert.equal((h.doc.getElementById('flt-missions') as any).hidden, true, 'panel shut');
  const shown = chips(h, 'flt-missions-active');
  assert.ok(shown.some((c) => c.startsWith('In stock')), `active filter not shown: ${shown}`);
  assert.match((h.doc.getElementById('flt-missions-more') as any).textContent, /1/, 'and counted');
});

test('pressing the shown filter clears it', async () => {
  const h = await boot(LISTED);
  openMissionFilters(h);
  pressChip(h, 'flt-missions-chips', 'In stock');
  (h.doc.getElementById('flt-missions-more') as any).click();
  pressChip(h, 'flt-missions-active', 'In stock');
  assert.equal(chips(h, 'flt-missions-active').length, 0);
});

test('the missions shop chip narrows to that shop', async () => {
  const h = await boot(LISTED);
  pressChip(h, 'flt-missions-shops', 'Walmart');
  const names = missionNames(h);
  assert.ok(names.some((n) => n.includes('Charlie')));
  assert.ok(names.some((n) => n.includes('Echo')));
  assert.ok(!names.some((n) => n.includes('Alpha')));
  pressChip(h, 'flt-missions-shops', 'Walmart');
  assert.ok(missionNames(h).some((n) => n.includes('Alpha')), 'pressing again clears it');
});

test('the missions status chip tells pre-order and in-stock apart', async () => {
  const h = await boot(LISTED);
  openMissionFilters(h);
  pressChip(h, 'flt-missions-chips', 'Pre-order');
  assert.deepEqual(missionNames(h).filter((n) => n.includes('Delta')).length, 1);
  assert.equal(missionNames(h).length, 1, 'the in-stock Alpha does not answer to pre-order');

  const h2 = await boot(LISTED);
  openMissionFilters(h2);
  pressChip(h2, 'flt-missions-chips', 'In stock');
  const names = missionNames(h2);
  assert.ok(names.some((n) => n.includes('Alpha')));
  assert.ok(!names.some((n) => n.includes('Delta')), 'the pre-order is not "in stock"');
});

test('the mode chips answer armed, watching, paused', async () => {
  // No openMissionFilters(): that is the point of moving them.
  const h = await boot(LISTED);
  pressChip(h, 'flt-missions-modes', 'Armed');
  assert.equal(missionNames(h).length, 1);
  assert.ok(missionNames(h)[0]!.includes('Bravo'));

  const h2 = await boot(LISTED);
  pressChip(h2, 'flt-missions-modes', 'Paused');
  assert.equal(missionNames(h2).length, 1);
  assert.ok(missionNames(h2)[0]!.includes('Echo'));
});

test('MISSION CHIP COUNTS RESPECT THE OTHER FILTERS', async () => {
  const h = await boot(LISTED);
  pressChip(h, 'flt-missions-shops', 'Walmart');
  const paused = chips(h, 'flt-missions-modes').find((c) => c.startsWith('Paused'));
  assert.equal(paused, 'Paused1', 'counted within the shop already chosen');
  // On the always-visible row an empty option is dropped rather than dimmed.
  // Dimming is right inside the panel, where a greyed chip says the category
  // exists and is empty; out here it would be a dead chip on every screen.
  const armed = chips(h, 'flt-missions-modes').find((c) => c.startsWith('Armed'));
  assert.equal(armed, undefined, 'no armed Walmart missions, so no Armed chip');
});

test('searching missions matches name, shop, and SKU, every word any order', async () => {
  const h = await boot(LISTED);
  openMissionFilters(h);
  typeInto(h, 'flt-missions-q', 'booster bravo');
  assert.equal(missionNames(h).length, 1);
  assert.ok(missionNames(h)[0]!.includes('Bravo'));

  typeInto(h, 'flt-missions-q', 'walmart');
  assert.equal(missionNames(h).length, 2, 'the shop name is searchable too');
});

test('mission filters that match nothing say so and offer a way back', async () => {
  const h = await boot(LISTED);
  openMissionFilters(h);
  typeInto(h, 'flt-missions-q', 'charizard');
  assert.match($(h, '#missions').textContent, /Nothing matches those filters/);
  assert.match($(h, '#flt-missions-count').textContent, /Showing 0 of 6/);

  const clear = [...h.doc.querySelectorAll('#flt-missions-count button')]
    .find((b) => b.textContent === 'Clear filters');
  assert.ok(clear, 'the count line offers the way back');
  (clear as HTMLButtonElement).click();
  assert.equal(missionNames(h).length, 6);
  assert.equal((h.doc.getElementById('flt-missions-q') as HTMLInputElement).value, '',
    'and the box is emptied with it');
});

test('the filter survives the thirty-second refresh', async () => {
  // The page redraws from fresh data every thirty seconds. A filter that
  // reset each time would be unusable; one that lives in the module survives.
  const h = await boot(LISTED);
  openMissionFilters(h);
  pressChip(h, 'flt-missions-shops', 'Walmart');
  assert.equal(missionNames(h).length, 2);
  ($(h, '#refresh') as HTMLButtonElement).click();
  await h.settle();
  assert.equal(missionNames(h).length, 2, 'still narrowed after a reload');
});

test('the products search narrows the product list', async () => {
  const h = await boot(LISTED);
  typeInto(h, 'flt-products-q', 'tin');
  assert.equal(productNames(h).length, 1);
  assert.ok(productNames(h)[0]!.includes('Charlie'));
  typeInto(h, 'flt-products-q', '');
  assert.equal(productNames(h).length, 6);
});

test('THE ACTIVITY BAR FILTERS RUNS AND CHANGES TOGETHER', async () => {
  const h = await boot(LISTED);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  pressChip(h, 'flt-activity-chips', 'Walmart');
  const runsText = $(h, '#runs-card').textContent;
  const changesText = $(h, '#changes-card').textContent;
  assert.match(runsText, /Charlie/);
  assert.doesNotMatch(runsText, /Alpha/);
  assert.match(changesText, /Echo/);
  assert.doesNotMatch(changesText, /Alpha/, 'one chip, both tables');
});

test('an outcome chip narrows runs but does not blank the changes', async () => {
  // Outcome is a run word. A change has none, and hiding every change
  // because a run filter is active would look like history being erased.
  const h = await boot(LISTED);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  pressChip(h, 'flt-activity-chips', 'failed');
  const runsText = $(h, '#runs-card').textContent;
  assert.match(runsText, /Charlie/);
  assert.doesNotMatch(runsText, /Alpha/);
  assert.match($(h, '#changes-card').textContent, /Alpha/, 'changes are left alone');
});

test('searching activity reaches the reason a run gives', async () => {
  const h = await boot(LISTED);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  typeInto(h, 'flt-activity-q', 'browser closed');
  assert.match($(h, '#runs-card').textContent, /Charlie/);
  assert.doesNotMatch($(h, '#runs-card').textContent, /Bravo/);
});

test('activity filtered to nothing says so instead of going blank', async () => {
  const h = await boot(LISTED);
  (h.doc.querySelector('[data-tab=activity]') as any).click();
  typeInto(h, 'flt-activity-q', 'charizard');
  assert.match($(h, '#runs-card').textContent, /No runs match those filters/);
  assert.match($(h, '#changes-card').textContent, /No changes match those filters/);
});

test('the finds bar is untouched by the other bars', async () => {
  // The finds filter shipped first and is heavily leaned on; the new bars
  // must not reach into its state.
  const h = await boot({ ...LISTED, discoveries: MIXED });
  typeInto(h, 'flt-missions-q', 'charizard');
  assert.ok(findNames(h).length > 0, 'finds still show while missions are filtered');
});

// ── The release radar, and the NEW badge ─────────────────────────────────────

const daysAhead = (n: number): string =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('THE RELEASE RADAR GROUPS EVERY DATED ITEM BY WHEN IT DROPS', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].releaseDate = daysAhead(3);
  d.missions[0].isPreOrder = true;
  d.discoveries = [
    { ...RICH_FIND, id: 31, name: 'Drops This Morning Box', releaseDate: daysAhead(0) },
    { ...RICH_FIND, id: 32, name: 'Next Month Tin', releaseDate: daysAhead(20) },
    { ...RICH_FIND, id: 33, name: 'Already Out Box', releaseDate: '2026-07-15' },
    { ...RICH_FIND, id: 34, name: 'Undated Box', releaseDate: '' },
  ];
  const h = await boot(d);
  const radar = $(h, '#release-radar');
  assert.equal(radar.hidden, false);
  const text = radar.textContent;
  assert.match(text, /Releases today/);
  assert.match(text, /Drops This Morning Box/);
  assert.match(text, /This week/);
  assert.match(text, /Pitch Black ETB/, 'the watched mission is on the radar too');
  assert.match(text, /watching/i, 'and marked as watched');
  assert.match(text, /Later/);
  assert.match(text, /Next Month Tin/);
  assert.doesNotMatch(text, /Already Out Box/, 'past dates are not news');
  assert.doesNotMatch(text, /Undated Box/, 'no date, no radar');
});

test('the radar hides itself when nothing ahead is dated', async () => {
  const h = await boot(withFinds([{ ...RICH_FIND, releaseDate: '2026-07-15' }]));
  assert.equal(($(h, '#release-radar') as any).hidden, true);
});

test('a mission and a find for the same product appear once, as the mission', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].releaseDate = daysAhead(2);
  d.discoveries = [{ ...RICH_FIND, id: 35, name: 'Pitch Black ETB', releaseDate: daysAhead(2) }];
  const h = await boot(d);
  const rows = [...h.doc.querySelectorAll('#release-radar .rrow')];
  assert.equal(rows.length, 1, 'deduped by name');
  assert.match(rows[0]!.textContent ?? '', /watching/i);
});

test('A FIND FIRST SEEN THIS WEEK WEARS A NEW PILL, AN OLD ONE DOES NOT', async () => {
  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  const h = await boot(withFinds([
    { ...RICH_FIND, id: 41, name: 'Fresh Box', firstSeenAt: new Date().toISOString() },
    { ...RICH_FIND, id: 42, name: 'Stale Box', firstSeenAt: old },
  ]));
  const cards = [...h.doc.querySelectorAll('#finds-list .card')];
  const withNew = cards.filter((c) =>
    [...c.querySelectorAll('.pill')].some((p) => p.textContent === 'NEW'));
  assert.equal(withNew.length, 1);
  assert.match(withNew[0]!.textContent ?? '', /Fresh Box/);
});

test('the New chip narrows to the last 48 hours and unfolds the dormant', async () => {
  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  const h = await boot(withFinds([
    { ...RICH_FIND, id: 41, name: 'Fresh Box', firstSeenAt: new Date().toISOString() },
    // Fresh but dormant-banded: no signal, sealed guess, long released.
    { ...RICH_FIND, id: 43, name: 'Fresh Deep Cut', firstSeenAt: new Date().toISOString(),
      signal: '', confidence: 'sealed', releaseDate: '2021-06-01' },
    { ...RICH_FIND, id: 42, name: 'Stale Box', firstSeenAt: old },
  ]));
  const chip = chips(h, 'find-states').find((c) => c.startsWith('New (48h)'));
  assert.equal(chip, 'New (48h)2', 'the chip counts what it would show');
  pressChip(h, 'find-states', 'New (48h)');
  const names = findNames(h);
  assert.deepEqual(names.sort(), ['Fresh Box', 'Fresh Deep Cut'],
    'fresh wins over the dormant fold — news is news');
  pressChip(h, 'find-states', 'New (48h)');
  assert.ok(findNames(h).includes('Stale Box'), 'pressing again clears it');
});

test('the sweep cadence is editable in settings and rides the same save', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.settings = { taxRate: 0, shippingAllowance: 0, sweepEveryHours: 6 };
  const h = await boot(d);
  const box = $(h, '[name=sweepEveryHours]') as HTMLInputElement;
  assert.equal(box.value, '6', 'the current cadence is shown');
  box.value = '4';
  submit($(h, '#settings-form'), h.dom.window);
  await h.settle();
  const call = h.calls.find((c) => c.path === '/api/settings' && c.method === 'POST');
  assert.ok(call);
  assert.equal(call!.body.sweepEveryHours, 4);
});

test('a blank cadence box leaves the cadence alone rather than zeroing it', async () => {
  const h = await boot(DASHBOARD);
  const box = $(h, '[name=sweepEveryHours]') as HTMLInputElement;
  box.value = '';
  submit($(h, '#settings-form'), h.dom.window);
  await h.settle();
  const call = h.calls.find((c) => c.path === '/api/settings' && c.method === 'POST');
  assert.ok(call);
  assert.ok(!('sweepEveryHours' in call!.body), 'absent, not null, not zero');
});

// ── The shop switcher: chips promoted to segments, and remembered ────────────

test('THE PRODUCTS SHOP BAR NARROWS BY WHERE THE LISTINGS ARE', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.products = [
    { key: 'p1', name: 'Alpha ETB', releaseDate: null, msrp: 49.99, imageUrl: '', notes: '' },
    { key: 'p2', name: 'Charlie Tin', releaseDate: null, msrp: 24.99, imageUrl: '', notes: '' },
  ];
  d.listings = [
    { ...DASHBOARD.listings[0], id: 1, productKey: 'p1', retailer: 'Target' },
    { ...DASHBOARD.listings[0], id: 2, productKey: 'p2', retailer: 'Walmart' },
  ];
  d.missions = [];
  const h = await boot(d);
  assert.equal(($(h, '#flt-products') as any).hidden, false,
    'two products are enough for the shop bar');
  assert.equal(($(h, '#flt-products-q') as any).hidden, true,
    'but not enough to need a search box');
  const segs = chips(h, 'flt-products-shops');
  assert.ok(segs.find((c) => c === 'Target1'), segs.join(' | '));
  assert.ok(segs.find((c) => c === 'Walmart1'));

  pressChip(h, 'flt-products-shops', 'Walmart');
  assert.deepEqual(productNames(h), ['Charlie Tin']);
  assert.equal(h.dom.window.localStorage.getItem('shop:products'), 'Walmart',
    'the pick is written down for next time');
  pressChip(h, 'flt-products-shops', 'All shops');
  assert.equal(productNames(h).length, 2);
  assert.equal(h.dom.window.localStorage.getItem('shop:products'), '');
});

test('the finds shop pick is written down too, and pressing again clears it', async () => {
  const h = await boot(withFinds(MIXED));
  pressChip(h, 'find-shops', 'Target');
  assert.equal(h.dom.window.localStorage.getItem('shop:finds'), 'Target');
  pressChip(h, 'find-shops', 'Target');
  assert.equal(h.dom.window.localStorage.getItem('shop:finds'), '');
});

test('a broken storage does not take the page down with it', async () => {
  // Private windows and locked-down browsers throw on localStorage access;
  // a filter convenience must never be why the dashboard rendered nothing.
  const h = await boot(withFinds(MIXED));
  Object.defineProperty(h.dom.window, 'localStorage', {
    get() { throw new Error('denied'); },
  });
  pressChip(h, 'find-shops', 'Walmart');
  assert.ok(findNames(h).length > 0, 'filtering still works with storage refused');
});

// ── The queue alarm ──────────────────────────────────────────────────────────

test('A WAITING ROOM PUTS AN ALARM AT THE TOP OF THE APP', async () => {
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.queues = [{ retailer: 'Pokemon Center', at: new Date(Date.now() - 3 * 60000).toISOString() }];
  const h = await boot(d);
  const qb = $(h, '#queue-banner');
  assert.equal(qb.hidden, false);
  assert.match(qb.textContent, /WAITING ROOM UP AT POKEMON CENTER/);
  assert.match(qb.textContent, /drop is likely live/);
  const a = qb.querySelector('a') as HTMLAnchorElement;
  assert.ok(a, 'there is a way straight to the shop');
  assert.equal(a.href, 'https://www.pokemoncenter.com/');
});

test('no sightings, no alarm', async () => {
  const h = await boot(DASHBOARD);
  assert.equal(($(h, '#queue-banner') as any).hidden, true);
});

// ── The pop-up's two promises ────────────────────────────────────────────────

test('THE POP-UP SURVIVES THE REFRESH AND ITS CONTENT STAYS FRESH', async () => {
  const h = await boot();
  openMission(h);
  const dlg = $(h, '#detail-dialog') as any;
  assert.equal(dlg.open, true);

  const renamed = JSON.parse(JSON.stringify(DASHBOARD));
  renamed.missions[0].productName = 'Renamed By Another Device';
  h.reply('GET /api/dashboard', renamed);
  ($(h, '#refresh') as HTMLButtonElement).click();
  await h.settle();

  assert.equal(dlg.open, true, 'the refresh must not slam the pop-up shut');
  assert.match($(h, '#detail-title').textContent ?? '', /Renamed By Another Device/,
    'and what it shows is the fresh data, not a stale copy');
});

test('a hand in the pop-up form is not interrupted by the refresh', async () => {
  const h = await boot();
  openMission(h);
  const ceiling = $(h, 'form[data-mission="1"]').querySelector('[name=ceiling]');
  ceiling.focus();
  ceiling.value = '123.45';

  ($(h, '#refresh') as HTMLButtonElement).click();
  await h.settle();

  const after = $(h, 'form[data-mission="1"]').querySelector('[name=ceiling]');
  assert.equal(after.value, '123.45', 'a redraw under the cursor eats keystrokes');
});

// ── Two buttons, two questions; and the pop-up knows when it is done ─────────

test('RUN HISTORY IS A TAB IN THE SAME POP-UP, AND FETCHES WHEN OPENED', async () => {
  const h = await boot();
  h.reply('GET /api/missions/1/runs', { runs: [
    { startedAt: new Date().toISOString(), productName: 'Pitch Black ETB',
      outcome: 'in_stock', reason: 'in stock at $49.99', price: 49.99, ms: 800 },
  ]});
  openMissionRuns(h);
  await h.settle();
  assert.equal(($(h, '#detail-dialog') as any).open, true);
  assert.match($(h, '#detail-body').textContent ?? '', /in stock at \$49\.99/,
    'no second load click — choosing the tab already said what you wanted');
  assert.ok(!$(h, '#detail-body').querySelector('[name=ceiling]'),
    'and the spending controls are not along for the ride');
});

test('THE CARD IS THE CONTROL, AND PAUSE IS NOT A WAY INTO IT', async () => {
  // Pressing the tile opens it; pressing a real control on the tile does that
  // control's job and nothing else. Getting this wrong means every attempt to
  // pause something also opens a dialog over the list.
  const h = await boot();
  const labels = [...h.doc.querySelectorAll('#missions button')].map((b) => b.textContent);
  assert.ok(!labels.includes('Settings'), 'the two buttons are gone from the row');
  assert.ok(!labels.includes('Run history'));
  assert.ok(labels.includes('Pause'), 'the one that changes something stays');

  const card = $(h, '#missions .card') as any;
  assert.equal(card.getAttribute('role'), 'button', 'and it says it is pressable');
  assert.equal(card.tabIndex, 0, 'reachable by keyboard');

  h.reply('POST /api/missions', { ok: true });
  const pause = [...h.doc.querySelectorAll('#missions button')]
    .find((b) => b.textContent === 'Pause');
  (pause as HTMLButtonElement).click();
  await h.settle();
  assert.equal(($(h, '#detail-dialog') as any).open, false, 'pausing opened nothing');

  card.click();
  assert.equal(($(h, '#detail-dialog') as any).open, true, 'the card itself did');
});

test('the two tabs show two different things', async () => {
  const h = await boot();
  h.reply('GET /api/missions/1/runs', { runs: [] });
  openMission(h);
  assert.ok($(h, '#detail-body').querySelector('[name=ceiling]'), 'settings first');
  const tabs = [...h.doc.querySelectorAll('#detail-body .dlgtabs button')]
    .map((b) => b.textContent);
  assert.deepEqual(tabs, ['Settings', 'Run history']);
  openMissionRuns(h);
  await h.settle();
  assert.ok(!$(h, '#detail-body').querySelector('[name=ceiling]'), 'and then the other one');
});

test('saving mission settings closes the pop-up', async () => {
  const h = await boot();
  openMission(h);
  const form = $(h, 'form[data-mission="1"]');
  h.reply('POST /api/missions', { mission: {} });
  submit(form, h.dom.window);
  await h.settle();
  assert.equal(($(h, '#detail-dialog') as any).open, false, 'saved means done means closed');
});

test('deleting a product closes its pop-up', async () => {
  const h = await boot();
  (h.doc.querySelector('[data-tab=products]') as any).click();
  openProduct(h);
  h.reply('DELETE /api/products/prd_etb', {});
  const del = $(h, '#detail-dialog').querySelector('[data-act=delete-product]');
  assert.ok(del);
  (del as HTMLButtonElement).click();
  await h.settle();
  assert.equal(($(h, '#detail-dialog') as any).open, false);
});

// ── Phantom by DNA, the side nav, and the grid ───────────────────────────────

test('THE APP IS CALLED PHANTOM BY DNA EVERYWHERE A NAME APPEARS', async () => {
  const html = dashboardPage();
  assert.match(html, /<title>Phantom by DNA<\/title>/);
  // The home-screen label is just "Phantom" — 14 characters gets ellipsised
  // under an iOS tile, and a truncated name is worse than a short one.
  assert.match(html, /apple-mobile-web-app-title" content="Phantom"/);
  // The wordmark stacks now — the name at full weight over its origin in small
  // caps — so the check is on what the lockup SAYS, not on how it is cut up.
  // The space between the two spans is a real text node, which is what keeps
  // the accessible name a sentence rather than "Phantomby DNA".
  assert.match(html, /class="brand-name"><b>Phantom<\/b> <i>by DNA<\/i>/);
  assert.doesNotMatch(html, /<title>Hub<\/title>/);
  assert.doesNotMatch(html, /Vault Watch/);
});

test('the nav is one element with two shapes — sidebar CSS exists from 900px', async () => {
  const css = dashboardPage();
  const wide = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(wide, /flex-direction: column/, 'the tabs stack vertically on desktop');
  assert.match(wide, /border-right/, 'and read as a side panel');
});

test('THE GRID VIEW IS A TOGGLE, AND IT IS REMEMBERED', async () => {
  const h = await boot();
  const missions = $(h, '#missions');
  assert.equal(missions.classList.contains('gridded'), false, 'list is the default');

  const gridBtn = h.doc.querySelector('.vt[data-list="missions"] [data-view="grid"]') as HTMLButtonElement;
  assert.ok(gridBtn, 'the toggle exists');
  gridBtn.click();
  assert.equal(missions.classList.contains('gridded'), true);
  assert.equal(gridBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(h.dom.window.localStorage.getItem('view:missions'), 'grid',
    'how you like to look at a list is remembered');

  const listBtn = h.doc.querySelector('.vt[data-list="missions"] [data-view="list"]') as HTMLButtonElement;
  listBtn.click();
  assert.equal(missions.classList.contains('gridded'), false);
});

test('each list has its own view toggle', async () => {
  const h = await boot();
  for (const list of ['missions', 'products', 'finds']) {
    assert.ok(h.doc.querySelector('.vt[data-list="' + list + '"]'), list + ' has a toggle');
  }
});

// ── the Vault tab: review-then-send ──────────────────────────────────────────

const ACQ = {
  id: 5, missionId: 1, productKey: 'prd_etb', name: 'A cheap pack of pens',
  retailer: 'Target', quantity: 2, unitPriceCents: 1749, orderedOn: '2026-08-31',
  status: 'queued', externalKey: 'auth-3', vaultTcgId: '', sentAt: null,
  createdAt: new Date().toISOString(), imageUrl: '',
};

test('THE WINS TAB EXISTS AND BADGES THE VAULT QUEUE', async () => {
  // Wins and the vault queue are one list seen twice — everything in both is a
  // checkout the retailer confirmed. Two tabs would have been two names for
  // one event, and an eighth item in a bottom bar already tight at seven.
  const h = await boot({ ...DASHBOARD, acquisitions: [ACQ, { ...ACQ, id: 6, status: 'sent', sentAt: new Date().toISOString() }] });
  assert.ok(h.doc.querySelector('[data-tab="wins"]'), 'the tab is in the nav');
  assert.equal($(h, '#c-vault').textContent, '1', 'only QUEUED rows count — sent is done');
  const cards = h.doc.querySelectorAll('#acq-list .card');
  assert.equal(cards.length, 2, 'sent history stays visible under the queue');
});

test('a queued acquisition says what was bought and offers the review', async () => {
  const h = await boot({ ...DASHBOARD, acquisitions: [ACQ] });
  const card = $(h, '#acq-list .card');
  assert.match(card.textContent, /A cheap pack of pens/);
  assert.match(card.textContent, /qty 2/);
  assert.match(card.textContent, /\$17\.49 each/);
  const labels = [...card.querySelectorAll('button')].map((b: any) => b.textContent);
  assert.ok(labels.includes('Send to vault'));
  assert.ok(labels.includes('Not for the vault'));
  assert.ok(card.querySelector('input[type=search]'), 'and the match search');
});

test('SENDING POSTS THE PICKED MATCH AND RELOADS', async () => {
  const h = await boot({ ...DASHBOARD, acquisitions: [ACQ] });
  h.reply('GET /api/vault/search?q=A%20cheap%20pack%20of%20pens',
    { products: [{ id: '624634', name: 'Pens 8-Pack', set: 'Supplies', price: 17.99 }] });
  h.reply('POST /api/acquisitions/5/send', { acquisition: { ...ACQ, status: 'sent' } });

  const card = $(h, '#acq-list .card');
  (card.querySelector('input[type=search]') as HTMLInputElement).value = 'A cheap pack of pens';
  const search = [...card.querySelectorAll('button')].find((b: any) => b.textContent === 'Search') as HTMLButtonElement;
  search.click();
  await h.settle();

  const pick = [...card.querySelectorAll('button')].find((b: any) => b.textContent === 'This one') as HTMLButtonElement;
  assert.ok(pick, 'the catalog hit offers itself');
  pick.click();
  assert.match(card.textContent, /matched to vault product 624634/);

  const send = [...card.querySelectorAll('button')].find((b: any) => b.textContent === 'Send to vault') as HTMLButtonElement;
  send.click();
  await h.settle();
  const posted = h.calls.find((c) => c.method === 'POST' && c.path === '/api/acquisitions/5/send');
  assert.ok(posted, 'the send went to the API');
  assert.equal(posted!.body.tcgId, '624634');
});

test('a remembered match arrives pre-filled — the second buy is one click', async () => {
  const h = await boot({ ...DASHBOARD, acquisitions: [{ ...ACQ, vaultTcgId: '624634' }] });
  assert.match($(h, '#acq-list .card').textContent, /matched to vault product 624634/);
});

test('an empty vault queue explains itself', async () => {
  const h = await boot({ ...DASHBOARD, acquisitions: [] });
  assert.match($(h, '#acq-list').textContent, /Nothing has been bought yet/);
});

// ── the stock-loaded banner ──────────────────────────────────────────────────

test('A LOAD-IN PUTS THE PRE-DROP BANNER ON THE FRONT PAGE', async () => {
  const h = await boot({
    ...DASHBOARD,
    stockLoads: [{
      retailer: 'Target',
      message: 'STOCK LOADED: Chaos Rising ETB — Target shows ~31000 units ready to ship; a drop is likely near',
      at: new Date().toISOString(),
    }],
  });
  const lb = $(h, '#load-banner');
  assert.equal(lb.hidden, false);
  assert.match(lb.textContent, /STOCK IS LOADING/);
  assert.match(lb.textContent, /Chaos Rising ETB/);
  assert.match(lb.textContent, /~31000 units/);
  assert.doesNotMatch(lb.textContent, /STOCK LOADED:/, 'the prefix is plumbing, not prose');
});

test('no load-ins, no banner', async () => {
  const h = await boot(DASHBOARD);
  assert.equal(($(h, '#load-banner') as any).hidden, true);
});

// ── Shop switches and the drop window ────────────────────────────────────────

const SETTINGS = {
  taxRate: 0, shippingAllowance: 0, activeFrom: '', activeUntil: '', timezone: '',
  paused: false, sweepEveryHours: 24, spendCapDay: 200,
  pausedRetailers: [], burstSpacingSeconds: 0, dropModeUntil: '',
};

test('EVERY SHOP GETS ITS OWN SWITCH, LABELLED WITH THE STATE IT IS IN', async () => {
  const h = await boot({ ...DASHBOARD, settings: { ...SETTINGS, pausedRetailers: ['Walmart'] } });
  const chips = [...h.doc.querySelectorAll('#shop-toggles button')] as any[];
  assert.equal(chips.length, 3, 'Target, Walmart, Pokemon Center');
  const walmart = chips.find((c) => c.textContent.startsWith('Walmart'));
  const target = chips.find((c) => c.textContent.startsWith('Target'));
  assert.match(walmart.textContent, /off/);
  assert.equal(walmart.getAttribute('aria-pressed'), 'false');
  assert.match(target.textContent, /on/);
  assert.equal(target.getAttribute('aria-pressed'), 'true');
});

test('pressing a shop switch sends only that shop’s change', async () => {
  const h = await boot({ ...DASHBOARD, settings: { ...SETTINGS, pausedRetailers: ['Walmart'] } });
  const target = ([...h.doc.querySelectorAll('#shop-toggles button')] as any[])
    .find((c) => c.textContent.startsWith('Target'));
  target.click();
  await h.settle();
  const posted = h.calls.find((c) => c.method === 'POST' && c.path === '/api/settings');
  assert.ok(posted, 'the toggle saved');
  assert.deepEqual(posted!.body.pausedRetailers.sort(), ['Target', 'Walmart'],
    'Walmart stays off; Target joins it — one switch does not rewrite the others');
});

test('the drop window says what it is doing in words, and offers a way out', async () => {
  const until = new Date(Date.now() + 42 * 60000).toISOString();
  const h = await boot({
    ...DASHBOARD,
    settings: { ...SETTINGS, burstSpacingSeconds: 8, dropModeUntil: until },
  });
  const state = $(h, '#drop-state');
  assert.match(state.textContent, /DROP WINDOW OPEN/);
  assert.match(state.textContent, /every 8s/);
  assert.match(state.textContent, /closing in 42 minutes/);
  assert.equal(($(h, '#drop-close') as any).hidden, false, 'and it can be closed early');
});

test('a window with no spacing set is honest that it would change nothing', async () => {
  const h = await boot({ ...DASHBOARD, settings: SETTINGS });
  assert.match($(h, '#drop-state').textContent, /would change nothing/);
  assert.equal(($(h, '#drop-close') as any).hidden, true);
});

// ── Staged stock: counted, not sellable ──────────────────────────────────────

test('STAGED STOCK IS ITS OWN ANSWER, NOT ROUNDED TO IN OR OUT', async () => {
  // Units in the warehouse against a listing the site still refuses to sell:
  // what a scheduled drop looks like in the hours before it opens. Calling it
  // "31000 available" is a lie you could act on; calling it "0 available"
  // throws away the best warning Target gives.
  const staged = {
    ...DASHBOARD,
    missions: [{ ...DASHBOARD.missions[0], state: 'out', availableQuantity: 31000, price: 59.99 }],
  };
  const h = await boot(staged);
  const card = $(h, '#missions .card');
  assert.match(card.textContent, /31000 staged/);
  assert.match(card.textContent, /not sellable yet/);
  assert.match(card.textContent, /STOCK STAGED · DROP NEAR/);
  assert.doesNotMatch(card.textContent, /31000 available/, 'never say a staged count is available');
  assert.match(card.textContent, /out of stock/, 'and the site’s own answer still stands beside it');
});

test('sellable stock is just available, with no staged noise', async () => {
  const live = {
    ...DASHBOARD,
    missions: [{ ...DASHBOARD.missions[0], state: 'in', availableQuantity: 14 }],
  };
  const h = await boot(live);
  const card = $(h, '#missions .card');
  assert.match(card.textContent, /14 available/);
  assert.doesNotMatch(card.textContent, /staged/i);
});

test('a read zero stays "0 available" — absence is reserved for "never said"', async () => {
  const zero = {
    ...DASHBOARD,
    missions: [{ ...DASHBOARD.missions[0], state: 'out', availableQuantity: 0 }],
  };
  const h = await boot(zero);
  assert.match($(h, '#missions .card').textContent, /0 available/);
  assert.doesNotMatch($(h, '#missions .card').textContent, /staged/i);
});

test('the capped figure keeps its plus, staged or not', async () => {
  const h = await boot({
    ...DASHBOARD,
    missions: [{ ...DASHBOARD.missions[0], state: 'out', availableQuantity: 20 }],
  });
  assert.match($(h, '#missions .card').textContent, /20\+ staged/);
});

// ── The front door ───────────────────────────────────────────────────────────
//
// Every other surface on this page assumes you already know what it is for.
// Somebody arriving from the vault does not, and an empty dashboard reads as
// broken rather than new.

const NEWCOMER = {
  missions: [],
  runs: [],
  changes: [],
  products: [],
  listings: [
    {
      id: 10, productKey: 'prd_etb', productName: 'Pitch Black ETB', retailer: 'Target',
      externalId: '1012644666', url: 'https://www.target.com/p/-/A-1012644666',
      sellerKind: 'retailer', sellerName: '', isPrimary: true,
    },
    {
      id: 11, productKey: 'prd_tin', productName: 'Ascended Heroes Tin', retailer: 'Walmart',
      externalId: '5015988981', url: 'https://www.walmart.com/ip/5015988981',
      sellerKind: 'retailer', sellerName: '', isPrimary: true,
    },
  ],
  canCurate: false,
  requests: [],
  capabilities: [
    { name: 'Target', watch: 'live', blocked: null },
    { name: 'Walmart', watch: 'live', blocked: null },
    {
      name: 'Pokémon Center',
      watch: 'partial',
      blocked: { since: '2026-09-01', what: 'behind a bot wall since 1 Sep; nothing can be read' },
    },
  ],
};

test('THE FRONT DOOR OPENS WHEN THERE IS NOTHING TO SHOW', async () => {
  // The moment worth spending. A dashboard with missions on it explains
  // itself; an empty one looks broken.
  const h = await boot(NEWCOMER);
  assert.equal($(h, '#wizard').hidden, false);
  assert.match($(h, '#wiz-title').textContent, /What Phantom does/);
  assert.equal($(h, '#wiz-step').textContent, '1 / 4');
});

test('it stays out of the way of somebody who is already using it', async () => {
  const h = await boot();
  assert.equal($(h, '#wizard').hidden, true);
});

test('IT NAMES A WALLED SHOP INSTEAD OF PROMISING IT', async () => {
  // The whole reason the capability table is read here rather than a list of
  // three retailers being typed into the page: on the day a shop goes behind
  // a wall, a hard-coded line keeps selling it to every new member.
  const h = await boot(NEWCOMER);
  const text = $(h, '#wiz-body').textContent;
  assert.match(text, /Target/);
  assert.match(text, /Pokémon Center/);
  assert.match(text, /bot wall/, 'and says so where it matters');
});

test('a member is told plainly that nothing here can spend their money', async () => {
  const h = await boot(NEWCOMER);
  assert.match($(h, '#wiz-body').textContent, /never buys anything on your behalf/i);
});

test('STEP TWO IS THE PRODUCT, NOT A TOUR OF IT — the catalogue is pickable', async () => {
  // A walkthrough you cannot act inside is a brochure. The shared catalogue
  // means anything already in it is one click away, and until this existed the
  // only route in was pasting a URL for something already on the page.
  const h = await boot(NEWCOMER);
  $(h, '#wiz-next').click();
  await h.settle();

  assert.match($(h, '#wiz-title').textContent, /Pick something to watch/);
  const rows = [...h.doc.querySelectorAll('#wiz-body .pickable')];
  assert.equal(rows.length, 2, 'both catalogue listings offered');

  const watch = rows[0]!.querySelector('button');
  assert.equal(watch.textContent, 'Watch this');
  watch.click();
  await h.settle();

  const call = h.calls.find((c) => c.method === 'POST' && c.path === '/api/missions');
  assert.ok(call, 'it creates the mission');
  assert.equal((call!.body as any).listingId, 10);
  assert.equal((call!.body as any).armed, undefined, 'AND NEVER ARMS IT');
});

test('something already watched is shown as watched, not offered again', async () => {
  const h = await boot({ ...NEWCOMER, missions: [{ ...DASHBOARD.missions[0], listingId: 10 }] });
  // With a mission on file the door does not open by itself, so open it.
  $(h, '#wiz-open').click();
  $(h, '#wiz-next').click();
  await h.settle();
  const rows = [...h.doc.querySelectorAll('#wiz-body .pickable')];
  const watched = rows.find((r) => r.textContent.includes('Pitch Black'));
  assert.match(watched!.textContent, /WATCHING/);
  assert.equal(watched!.querySelector('button'), null, 'no button to press twice');
});

test('STEP THREE TELLS A MEMBER THE TRUTH ABOUT WHERE THEIR LINK GOES', async () => {
  // "Added" and "sent to somebody who may say no" are different promises, and
  // a member who thinks they added it will wonder why it never appears.
  const h = await boot(NEWCOMER);
  $(h, '#wiz-next').click();
  $(h, '#wiz-next').click();
  await h.settle();
  assert.match($(h, '#wiz-body').textContent, /goes to the catalogue owner/);
  assert.equal($(h, '#wiz-body button').textContent, 'Send it in');
});

test('the owner is told the other truth: it goes straight in', async () => {
  const h = await boot({ ...NEWCOMER, canCurate: true });
  $(h, '#wiz-next').click();
  $(h, '#wiz-next').click();
  await h.settle();
  assert.match($(h, '#wiz-body').textContent, /straight into the catalogue/);
  assert.equal($(h, '#wiz-body button').textContent, 'Add and watch');
});

test('the last step ends the wizard rather than running out of Next', async () => {
  const h = await boot(NEWCOMER);
  for (let i = 0; i < 3; i += 1) $(h, '#wiz-next').click();
  await h.settle();
  assert.equal($(h, '#wiz-step').textContent, '4 / 4');
  assert.equal($(h, '#wiz-next').textContent, 'Done');
  $(h, '#wiz-next').click();
  assert.equal($(h, '#wizard').hidden, true);
});

test('IT IS SKIPPABLE ON EVERY STEP, AND REOPENABLE AFTER', async () => {
  // A wizard you cannot get out of is one people learn to click through
  // without reading, and then it has taught them nothing twice.
  const h = await boot(NEWCOMER);
  $(h, '#wiz-close').click();
  assert.equal($(h, '#wizard').hidden, true);
  $(h, '#wiz-open').click();
  assert.equal($(h, '#wizard').hidden, false);
  assert.equal($(h, '#wiz-step').textContent, '1 / 4', 'and it starts from the beginning');
});

test('Back is offered only where there is something to go back to', async () => {
  const h = await boot(NEWCOMER);
  assert.equal($(h, '#wiz-back').hidden, true);
  $(h, '#wiz-next').click();
  assert.equal($(h, '#wiz-back').hidden, false);
  $(h, '#wiz-back').click();
  assert.equal($(h, '#wiz-step').textContent, '1 / 4');
});

// ── A member's page is a smaller page ────────────────────────────────────────

test('A MEMBER IS NOT SHOWN BUTTONS THAT ALWAYS ANSWER 403', async () => {
  // Removing a listing and adding one both write to the shared catalogue, and
  // curation is a role. A button that always fails is worse than no button.
  const h = await boot({ ...DASHBOARD, canCurate: false });
  openProduct(h);
  await h.settle();
  const panel = $(h, '#detail-body') ?? h.doc.body;
  const buttons = [...panel.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(!buttons.includes('remove'), 'no remove');
  assert.ok(!buttons.includes('Add listing and watch it'), 'no add-a-listing form');
  assert.match(panel.textContent, /goes to the catalogue owner/, 'but it says what to do instead');
});

test('the owner keeps both', async () => {
  const h = await boot();
  openProduct(h);
  await h.settle();
  const buttons = [...h.doc.querySelectorAll('#detail-body button')].map((b) => b.textContent);
  assert.ok(buttons.includes('remove'));
  assert.ok(buttons.includes('Add listing and watch it'));
});

test('ANYBODY CAN WATCH A LISTING SOMEBODY ELSE CATALOGUED', async () => {
  // The point of a shared catalogue. The listing in DASHBOARD is already
  // watched, so this proves the state is read from your OWN missions.
  const h = await boot({ ...DASHBOARD, canCurate: false, missions: [] });
  openProduct(h);
  await h.settle();
  // Scoped to the pop-up: the quick-add form has a "Watch this" submit button
  // of its own, and finding that one instead is how this test first passed
  // while proving nothing.
  const watch = [...h.doc.querySelectorAll('#detail-body button')]
    .find((b) => b.textContent === 'Watch this');
  assert.ok(watch, 'a member is offered the listing');
  watch!.click();
  await h.settle();
  const call = h.calls.find((c) => c.method === 'POST' && c.path === '/api/missions');
  assert.equal((call!.body as any).listingId, 10);
});

// ── Silence ──────────────────────────────────────────────────────────────────
//
// Phantom died at 19:14 on 1 Sep 2026 and nobody noticed for thirty-five
// minutes. Nothing looked wrong: every mission still showed its last reading
// and only the age moved, and "checked 3m ago" becoming "checked 35m ago" is
// alarming only to somebody who already knows what normal is.
//
// A watcher that is OFF looks exactly like a watcher whose products have not
// changed. That is the one failure this system cannot report by omission.

const minsAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

test('A MACHINE THAT HAS STOPPED REPORTING SAYS SO, LOUDLY', async () => {
  const h = await boot({ ...DASHBOARD, agentSeenAt: minsAgo(35) });
  const banner = $(h, '#silence-banner');
  assert.equal(banner.hidden, false);
  assert.match($(h, '#silence-detail').textContent, /Nothing is being watched/);
  assert.match($(h, '#silence-detail').textContent, /35m ago|3[0-9]m ago/);
});

test('a machine that reported a moment ago is not accused of anything', async () => {
  const h = await boot({ ...DASHBOARD, agentSeenAt: minsAgo(1) });
  assert.equal($(h, '#silence-banner').hidden, true);
});

test('the window is generous, because a banner that flickers stops being read', async () => {
  // A pass runs every 90s, the log is buffered and flushed per pass, and a
  // slow pass can run minutes long. Five minutes of quiet is not an outage.
  const h = await boot({ ...DASHBOARD, agentSeenAt: minsAgo(5) });
  assert.equal($(h, '#silence-banner').hidden, true);
});

test('AN ACCOUNT THAT HAS NEVER STARTED IT IS NOT AN OUTAGE', async () => {
  // Saying "Phantom has stopped reporting" to somebody who has never run it is
  // a lie with an exclamation mark on it — and it is the first thing a new
  // member would see.
  const h = await boot({ ...DASHBOARD, agentSeenAt: null });
  assert.equal($(h, '#silence-banner').hidden, true);
});

test('resting is not silence — the heartbeat is the log, not the readings', async () => {
  // Phantom writes an activity line when it is asleep outside watching hours,
  // which is exactly why the signal is the activity log and not the newest
  // reading. Otherwise this would cry wolf every night at the hour the
  // schedule closes, and by morning nobody would look at it.
  const h = await boot({
    ...DASHBOARD,
    settings: { ...(DASHBOARD as any).settings, activeFrom: '01:00', activeUntil: '05:00' },
    agentSeenAt: minsAgo(2),
  });
  assert.equal($(h, '#silence-banner').hidden, true);
});

test('THE TAB IS CALLED DISCOVERY', async () => {
  // Renamed 1 Sep 2026. The data key stays `finds` — the name people read and
  // the name the code uses are allowed to differ, and churning ids the night
  // of a drop is not a trade worth making.
  const h = await boot();
  const tab = [...h.doc.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'finds');
  assert.equal(tab.textContent.trim(), 'Discovery');
  assert.match(h.doc.querySelector('#tab-finds h2').textContent, /^Discovery/);
});

// ── The material ─────────────────────────────────────────────────────────────

test('GLASS IS DECIDED BEFORE THE FIRST PAINT', async () => {
  // Set from a script at the bottom of the body and the page renders flat for
  // a beat, then lights up all at once. A flash of the wrong material is worse
  // than not having one.
  const html = dashboardPage();
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /data-material/, 'the decision is made in the head');
  assert.ok(
    head.indexOf('data-material') < head.indexOf('<style>'),
    'and before the stylesheet it governs',
  );
});

test('REDUCE-TRANSPARENCY IS RESPECTED IN JS, WHICH FAILS OPEN', async () => {
  // The scar this is written from: a CSS media query on
  // prefers-reduced-transparency FAILS CLOSED. A browser that has never heard
  // of the feature treats the query as false and silently drops every rule
  // inside it — the material worked on desktop Chrome and rendered as nothing
  // at all on a phone. matchMedia fails open: unknown query, no match, glass.
  const html = dashboardPage();
  assert.match(html, /matchMedia\('\(prefers-reduced-transparency: reduce\)'\)/);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(
    style,
    /@media[^{]*prefers-reduced-transparency/,
    'never as a CSS guard — that is the version that failed',
  );
});

test('the whole material sits behind an @supports for backdrop-filter', async () => {
  const html = dashboardPage();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const at = style.indexOf('@supports ((backdrop-filter');
  assert.ok(at > 0, 'the guard exists');
  assert.ok(
    style.indexOf('data-material=glass') > at,
    'and every glass rule is inside it, so this can only ever enhance',
  );
});

test('LIST CARDS ARE NOT BLURRED — forty of them is the jank', async () => {
  // The vault blurs .card because a card there is a panel. Here a card is a
  // LIST ROW: forty missions and a hundred discoveries are forty and a hundred
  // backdrop-filters on one scroll. They get the fill and the catch-light,
  // which is the look, without the cost.
  const html = dashboardPage();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const rule = /:root\[data-material=glass\] \.card \{([^}]*)\}/.exec(style)?.[1] ?? '';
  assert.ok(rule, 'cards do get the material');
  assert.match(rule, /inset 0 1px 0 var\(--glass-hi\)/, 'the catch-light is the look');
  assert.doesNotMatch(rule, /backdrop-filter/, 'but not a per-row blur');
});

test('the few big fixed surfaces DO get the blur', async () => {
  const html = dashboardPage();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  for (const sel of ['.tabs', '.banner', '.wizard', 'dialog .card']) {
    const re = new RegExp(
      ':root\\[data-material=glass\\][^{]*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '[^{]*\\{[^}]*backdrop-filter',
    );
    assert.match(style, re, `${sel} should carry the blur`);
  }
});

test('THE POP-UP STAYS NEAR-SOLID, so the page cannot ghost through it', async () => {
  // A translucent sheet let the page's own text read up through the dialog.
  // Unreadable rather than beautiful; the vault settled this the hard way. The
  // glass lives in the edge and the dimmed, blurred page behind it.
  const html = dashboardPage();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  assert.match(style, /dialog \.card \{[^}]*var\(--panel\) 94%/);
  assert.match(style, /dialog::backdrop \{[^}]*backdrop-filter: blur\(4px\)/);
});

test('a phone gets its own light field, cut in viewport units', async () => {
  // The desktop radii are wider than a whole phone viewport, so a 390px screen
  // sits in the flat CENTRE of an 1100px gradient and the light reads as one
  // uniform tint. No bright-corner falloff, no glass.
  const html = dashboardPage();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n  \}/.exec(style)?.[1] ?? '';
  assert.match(phone, /data-material=glass\] body/);
  assert.match(phone, /\d+vw \d+vh/, 'viewport units, not pixels');
});

test('the material can be turned off, and says why when it cannot', async () => {
  const h = await boot();
  const box = $(h, '#material-toggle');
  assert.ok(box, 'there is a switch');
  assert.match($(h, '#material-note').textContent, /\S/, 'and it always explains itself');
});

test('THE ART FILLS ITS FRAME', async () => {
  // contain letterboxed every photo, and because retailer shots come on a
  // white ground what you saw was a small white rectangle inside a dark one
  // with the product smaller still inside that.
  const html = dashboardPage();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const thumb = /\n\.thumb \{([^}]*)\}/.exec(style)?.[1] ?? '';
  assert.match(thumb, /object-fit: cover/);
  assert.doesNotMatch(thumb, /object-fit: contain/);
});


// ── Staged stock on a find ───────────────────────────────────────────────────

test('A FIND WITH STAGED STOCK SAYS SO LOUDER THAN ANYTHING ELSE ON THE CARD', async () => {
  // The best thing Discovery can tell you: units counted in a warehouse behind
  // a listing NOBODY IS WATCHING YET. The sweep has been reading this number
  // all along and dropping it at the database boundary.
  const staged = [{
    id: 9, sourceId: 'target-tcg', externalId: '1012644666',
    name: 'Pokemon TCG: Pitch Black Elite Trainer Box',
    url: 'https://www.target.com/p/-/A-1012644666', price: 49.99,
    kind: 'elite trainer box', confidence: 'sealed', foundBy: 'pokemon elite trainer box',
    status: 'new', firstSeenAt: new Date().toISOString(), alreadyHave: false,
    retailer: 'Target', state: 'out', availableQuantity: 31000, orderLimit: 12,
  }];
  const h = await boot(withFinds(staged));
  const text = $(h, '#finds-list').textContent;
  assert.match(text, /STOCK STAGED · DROP NEAR/);
  assert.match(text, /31000 staged/);
  assert.match(text, /not sellable yet/);
  assert.doesNotMatch(text, /31000 available/, 'staged is never available');
});

test('a find with ordinary shelf stock gets no drop warning', async () => {
  const ordinary = [{
    id: 10, sourceId: 'target-tcg', externalId: '1012644667', name: 'A box',
    url: 'https://www.target.com/p/-/A-1012644667', price: 49.99,
    kind: 'elite trainer box', confidence: 'sealed', foundBy: 'q',
    status: 'new', firstSeenAt: new Date().toISOString(), alreadyHave: false,
    retailer: 'Target', state: 'in', availableQuantity: 10, orderLimit: 10,
  }];
  const h = await boot(withFinds(ordinary));
  const text = $(h, '#finds-list').textContent;
  assert.doesNotMatch(text, /STOCK STAGED/);
  assert.match(text, /10\+ available/, 'and the count still wears its ceiling');
});

test('a find from a retailer that states no count says nothing about one', async () => {
  const h = await boot(withFinds());
  const text = $(h, '#finds-list').textContent;
  assert.doesNotMatch(text, /available/);
  assert.doesNotMatch(text, /staged/);
});

// ── Alerts ───────────────────────────────────────────────────────────────────

test('SETTINGS SAYS WHETHER ALERTS HAVE ANYWHERE TO GO', async () => {
  // "Nothing appeared in Discord" has four causes and a person cannot tell them
  // apart. The page states the one it knows.
  const off = await boot({ ...DASHBOARD, discord: false });
  assert.match($(off, '#discord-state').textContent, /Not connected/);
  assert.equal(($(off, '#discord-test') as any).disabled, true, 'no point testing a webhook that is not there');

  const on = await boot({ ...DASHBOARD, discord: true });
  assert.match($(on, '#discord-state').textContent, /Connected/);
  assert.equal(($(on, '#discord-test') as any).disabled, false);
});

test('the webhook URL never reaches the page', async () => {
  // A Discord webhook is a credential: anyone holding it can post as Phantom,
  // and a settings screen is a thing people screenshot. Configured or not is
  // the whole of what this screen needs.
  const h = await boot({ ...DASHBOARD, discord: true });
  assert.doesNotMatch(h.doc.body.innerHTML, /discord\.com\/api\/webhooks/i);
  assert.doesNotMatch(h.doc.body.innerHTML, /DISCORD_WEBHOOK_URL=/);
});

// ── Controls on the card itself ──────────────────────────────────────────────

test('A MISSION CAN BE PAUSED FROM THE LIST, WITHOUT OPENING ANYTHING', async () => {
  // The most-changed boolean in the app was two clicks and a dialog away, and
  // that dialog is full of decisions about money.
  const h = await boot(DASHBOARD);
  const labels = [...h.doc.querySelectorAll('#missions button')].map((b) => b.textContent);
  assert.ok(labels.includes('Pause'), 'an enabled mission offers Pause');

  const paused = JSON.parse(JSON.stringify(DASHBOARD));
  paused.missions[0].enabled = false;
  const h2 = await boot(paused);
  const labels2 = [...h2.doc.querySelectorAll('#missions button')].map((b) => b.textContent);
  assert.ok(labels2.includes('Resume'), 'a paused one offers Resume');
  assert.ok(!labels2.includes('Pause'));
});

test('pausing sends the whole mission, so nothing else is quietly reset', async () => {
  // The endpoint takes a whole mission. A partial POST would wipe a ceiling
  // somebody set, which is the kind of helpfulness that costs money.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].ceiling = 55.5;
  d.missions[0].quantity = 2;
  const h = await boot(d);
  h.reply('POST /api/missions', { ok: true });
  const btn = [...h.doc.querySelectorAll('#missions button')].find((b) => b.textContent === 'Pause');
  (btn as HTMLButtonElement).click();
  await h.settle();
  const call = h.calls.find((c) => c.path === '/api/missions' && c.method === 'POST');
  assert.ok(call, 'it posted');
  assert.equal(call.body.enabled, false);
  assert.equal(call.body.ceiling, 55.5, 'the ceiling survived');
  assert.equal(call.body.quantity, 2);
});

test('DISARMING IS ONE CLICK; ARMING IS NOT OFFERED HERE', async () => {
  // Taking away permission to spend can never be wrong by accident. Granting
  // it beside Pause, on a list you scroll with your thumb, is a misclick that
  // buys something.
  const armed = JSON.parse(JSON.stringify(DASHBOARD));
  armed.missions[0].armed = true;
  armed.missions[0].ceiling = 60;
  const h = await boot(armed);
  const labels = [...h.doc.querySelectorAll('#missions button')].map((b) => b.textContent);
  assert.ok(labels.includes('Disarm'));
  assert.ok(!labels.includes('Arm'), 'arming stays where the ceiling is visible');

  const h2 = await boot(DASHBOARD);
  const labels2 = [...h2.doc.querySelectorAll('#missions button')].map((b) => b.textContent);
  assert.ok(!labels2.includes('Disarm'), 'nothing to disarm on a watching-only mission');
});

test('THE MONEY BAR DOES NOT SHARE A CLASS WITH EVERY FORM', async () => {
  // It did, for one afternoon. `form.stack` won on display and gap, so the
  // forms still laid out — while height 14px and overflow hidden came through
  // untouched and clipped every input in the app out of existence.
  const h = await boot(DASHBOARD);
  const css = h.doc.querySelector('style').textContent;
  assert.match(css, /\.moneybar \{[^}]*height: 14px/);
  assert.doesNotMatch(css, /\n\.stack \{[^}]*height: 14px/, 'never again');
  assert.match(css, /\.stack, form\.stack \{[^}]*display: grid/);
});


test('MOVING REFRESH OUT OF THE TOOLBAR KEEPS IT WORKING', async () => {
  // The controls moved into Settings and kept their ids, so the auto-refresh
  // timer and the click handler bind to the same elements they always did.
  const h = await boot(DASHBOARD);
  const auto = h.doc.getElementById('auto') as any;
  const refresh = h.doc.getElementById('refresh') as any;
  assert.ok(auto, 'the auto-refresh tick still exists');
  assert.ok(refresh, 'and the button');
  assert.ok(
    h.doc.getElementById('tab-settings').contains(auto),
    'both now live in Settings rather than above every list',
  );
  assert.ok(h.doc.getElementById('tab-settings').contains(refresh));
  assert.ok(!h.doc.querySelector('.bar').contains(refresh), 'and not in the toolbar');
});

test('A MISSION CAN BE MUTED FROM ITS SETTINGS, WITHOUT PAUSING IT', async () => {
  // Muting is a question about the channel, not about the machine. The two
  // switches sit next to each other and mean different things.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  d.missions[0].alerts = false;
  const h = await boot(d);
  openMission(h);
  const box = h.doc.querySelector('#detail-body [name=alerts]') as any;
  assert.ok(box, 'the switch exists');
  assert.equal(box.checked, false, 'and reflects the muted mission');
  assert.equal((h.doc.querySelector('#detail-body [name=enabled]') as any).checked, true,
    'still being watched');
});

test('a mission from an older Hub shows as announcing, not silenced', async () => {
  // An unticked box on a mission that has been posting all along would mute it
  // on the next save, silently, because somebody opened the dialog.
  const d = JSON.parse(JSON.stringify(DASHBOARD));
  delete d.missions[0].alerts;
  const h = await boot(d);
  openMission(h);
  assert.equal((h.doc.querySelector('#detail-body [name=alerts]') as any).checked, true);
});

test('THE POP-UP DOES NOT RESIZE WHEN YOU CHANGE TABS', async () => {
  // A settings form is a fixed set of fields; a run history is however long the
  // history is. Sizing the window to its contents made it jump under the
  // pointer — on a long history the tab you just pressed moved away from where
  // you pressed it. The frame is fixed and the content scrolls instead.
  const h = await boot();
  h.reply('GET /api/missions/1/runs', { runs: [] });
  openMission(h);
  const settingsBox = $(h, '#detail-body .dlgbody');
  assert.ok(settingsBox, 'the settings tab lives in the fixed box');

  openMissionRuns(h);
  await h.settle();
  const runsBox = $(h, '#detail-body .dlgbody');
  assert.ok(runsBox, 'and so does the history');

  const css = h.doc.querySelector('style').textContent;
  assert.match(css, /\.dlgbody \{[^}]*height: min\(/, 'one height for both');
  assert.match(css, /\.dlgbody \{[^}]*overflow-y: auto/, 'and the content moves, not the window');
});
