/**
 * The pages, as strings.
 *
 * No framework and no build step — the whole app is two HTML documents this
 * file returns. That is a deliberate ceiling: the moment this needs a bundler
 * it should become a real front end, and until then every dependency added here
 * is a thing that can break a deploy of a page that shows six rows.
 *
 * Data arrives as JSON from /api/dashboard and renders client-side, so the page
 * can refresh itself without a reload.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8; --panel: #ffffff; --line: #e6e2dc; --line-soft: #f0ede8;
  --ink: #1c1a17; --muted: #6d675e;
  --in: #1c6b45; --in-bg: #e6f4ec;
  --out: #7a736a; --out-bg: #f1efec;
  --warn: #8a5a10; --warn-bg: #fdf1dd;
  --alert: #a3341f; --alert-bg: #fbeae6;
  --accent: #2a5db0; --accent-soft: #eaf0fb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16150f; --panel: #1e1d17; --line: #33312a; --line-soft: #26251e;
    --ink: #edeae4; --muted: #a09a90;
    --in: #6fd39d; --in-bg: #14301f;
    --out: #8f887e; --out-bg: #242219;
    --warn: #e0b060; --warn-bg: #33270f;
    --alert: #f0907a; --alert-bg: #3a1d16;
    --accent: #8fb4f5; --accent-soft: #1a2740;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1040px; margin: 0 auto; padding: 26px 20px 96px; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 21px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.07em;
     color: var(--muted); margin: 30px 0 10px; }
h3 { font-size: 14px; margin: 0 0 8px; }
.sub { color: var(--muted); font-size: 13px; }
a { color: var(--accent); }

.tabs { display: flex; gap: 2px; margin: 16px 0 14px; border-bottom: 1px solid var(--line); }
.tab { padding: 9px 15px; cursor: pointer; border: none; background: none; font: inherit;
       color: var(--muted); border-bottom: 2px solid transparent; border-radius: 0; }
.tab:hover { color: var(--ink); }
.tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.tab .count { font-variant-numeric: tabular-nums; opacity: .7; margin-left: 5px; }

.bar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
button, .btn {
  font: inherit; padding: 7px 13px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  text-decoration: none; display: inline-block; line-height: 1.4;
}
button:hover:not(:disabled) { border-color: var(--muted); }
button:disabled { opacity: .5; cursor: progress; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover:not(:disabled) { filter: brightness(1.08); }
button.danger { color: var(--alert); border-color: var(--alert); }
button.small { padding: 3px 9px; font-size: 12px; }
button.link { border: none; background: none; color: var(--accent); padding: 0; }

.card { background: var(--panel); border: 1px solid var(--line);
        border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; }
.card.flat { background: none; }
.row { display: flex; gap: 14px; align-items: flex-start; }
.grow { flex: 1 1 240px; min-width: 0; }
.name { font-weight: 600; line-height: 1.35; }
.meta { color: var(--muted); font-size: 13px; }
.meta + .meta { margin-top: 3px; }
.price { font-variant-numeric: tabular-nums; font-size: 19px; font-weight: 600; white-space: nowrap; }
.price.over { color: var(--alert); }
.price.under { color: var(--in); }
.right { text-align: right; flex: 0 0 auto; }

.pill { display: inline-block; padding: 2px 9px; border-radius: 999px;
        font-size: 12px; font-weight: 600; letter-spacing: .02em; white-space: nowrap; }
.pill + .pill { margin-left: 4px; }
.s-in { background: var(--in-bg); color: var(--in); }
.s-out { background: var(--out-bg); color: var(--out); }
.s-unknown, .s-unchecked, .s-queue { background: var(--warn-bg); color: var(--warn); }
.flag { background: var(--alert-bg); color: var(--alert); }
.info { background: var(--accent-soft); color: var(--accent); }
.stale { color: var(--alert); font-weight: 600; }

.thumb { width: 60px; height: 60px; border-radius: 8px; object-fit: contain;
         background: var(--out-bg); flex: 0 0 auto; }
.thumb.ph { display: flex; align-items: center; justify-content: center;
            color: var(--muted); font-size: 20px; }
.thumb.lg { width: 84px; height: 84px; }

form.stack { display: grid; gap: 10px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
label.f { display: grid; gap: 3px; font-size: 13px; color: var(--muted); }
label.f .hint { font-weight: 400; opacity: .75; }
label.check { display: flex; gap: 7px; align-items: center; font-size: 14px;
              color: var(--ink); cursor: pointer; }
input[type=text], input[type=url], input[type=number], input[type=date],
select, textarea, input[type=password] {
  font: inherit; padding: 8px 10px; border-radius: 8px; width: 100%;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
textarea { min-height: 62px; resize: vertical; }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.msg { font-size: 13px; min-height: 18px; }
.msg.bad { color: var(--alert); }
.msg.good { color: var(--in); }
.empty { color: var(--muted); padding: 34px 14px; text-align: center;
         border: 1px dashed var(--line); border-radius: 12px; }
.empty strong { color: var(--ink); display: block; margin-bottom: 4px; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { padding: 7px 8px; border-top: 1px solid var(--line-soft); vertical-align: top;
         text-align: left; }
th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase;
     letter-spacing: .05em; border-top: none; }
tr:first-child td { border-top: none; }
.nowrap { white-space: nowrap; }
.o-bought { color: var(--in); font-weight: 600; }
.o-failed, .o-blocked { color: var(--alert); font-weight: 600; }
.o-declined, .o-running { color: var(--warn); }
.o-in_stock { color: var(--in); }

details { margin-top: 10px; border-top: 1px solid var(--line-soft); padding-top: 10px; }
details > summary { cursor: pointer; color: var(--muted); font-size: 13px; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: '▸ '; }
details[open] > summary::before { content: '▾ '; }
details > summary:hover { color: var(--ink); }
.off { opacity: .55; }
.login { max-width: 340px; margin: 16vh auto; }
.err { color: var(--alert); font-size: 13px; min-height: 20px; }
`;

export function loginPage(message = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub</title><style>${STYLE}</style></head>
<body><main class="login">
  <h1>Hub</h1>
  <p class="sub">Sign in to see what's being watched.</p>
  <form method="POST" action="/login" style="margin-top:18px">
    <input type="password" name="password" placeholder="Password" autofocus required
           autocomplete="current-password">
    <div class="err" style="margin:8px 0">${esc(message)}</div>
    <button type="submit" style="width:100%">Sign in</button>
  </form>
</main></body></html>`;
}

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub</title><style>${STYLE}</style></head>
<body><main>
  <header>
    <h1>Hub</h1>
    <span class="sub" id="summary">loading…</span>
  </header>

  <div class="tabs">
    <button class="tab on" data-tab="missions">Missions<span class="count" id="c-missions"></span></button>
    <button class="tab" data-tab="products">Products<span class="count" id="c-products"></span></button>
    <button class="tab" data-tab="activity">Activity<span class="count" id="c-activity"></span></button>
  </div>

  <div class="bar">
    <button id="refresh">Refresh</button>
    <label class="check sub"><input type="checkbox" id="auto" checked> auto every 30s</label>
    <span class="grow"></span>
    <a class="btn" href="/logout">Sign out</a>
  </div>

  <section id="tab-missions"><div id="missions"></div></section>

  <section id="tab-products" hidden>
    <div class="card">
      <h3>Add a product</h3>
      <p class="sub" style="margin:-4px 0 12px">
        The thing itself. Only the name is needed — everything else can wait,
        or be filled in from the page once the Watcher reads it.
      </p>
      <form class="stack" id="product-form" novalidate>
        <label class="f">Name
          <input type="text" name="name" placeholder="Pokémon TCG: Pitch Black Elite Trainer Box">
        </label>
        <div class="grid2">
          <label class="f">Release date <span class="hint">optional</span>
            <input type="date" name="releaseDate">
          </label>
          <label class="f">MSRP <span class="hint">optional — what it should cost</span>
            <input type="number" name="msrp" step="0.01" min="0.01" placeholder="49.99">
          </label>
        </div>
        <label class="f">Image URL <span class="hint">optional — filled in automatically otherwise</span>
          <input type="url" name="imageUrl" placeholder="https://…">
        </label>
        <label class="f">Notes <span class="hint">optional</span>
          <textarea name="notes" placeholder="Anything you want to remember about this one."></textarea>
        </label>
        <div class="actions">
          <button type="submit" class="primary">Add product</button>
          <span class="msg" id="product-msg"></span>
        </div>
      </form>
    </div>
    <div id="products"></div>
  </section>

  <section id="tab-activity" hidden>
    <h2 style="margin-top:0">Mission runs</h2>
    <p class="sub" style="margin:-6px 0 10px">
      Written when a mission acted, or could not. Routine checks that found
      nothing are not runs — otherwise the four that matter drown in ten
      thousand that don't.
    </p>
    <div class="card" id="runs-card"></div>

    <h2>Stock and price changes</h2>
    <div class="card" id="changes-card"></div>
  </section>
</main>
<script>
const money = (n) => n === null || n === undefined ? '—' : '$' + Number(n).toFixed(2);

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// Anything older than five minutes is not a live reading. Say so loudly rather
// than showing a stale price as though it were current.
const STALE_MS = 5 * 60 * 1000;

let DATA = { missions: [], runs: [], changes: [], products: [], listings: [] };
const OPEN = new Set();   // which detail panels are expanded, kept across refreshes

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Read a form.
 *
 * FormData, never form.fieldName. A form's own "name" property is its name
 * attribute, not the input called "name" — so the add-product form sent an empty
 * name on every submission and came back "a product needs a name". The only field
 * left to suspect was the date, which is why it looked required when it never was.
 */
function fields(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? v.trim() : v;
  for (const input of form.querySelectorAll('input[type=checkbox]')) out[input.name] = input.checked;
  return out;
}

const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  // The API answers failures in sentences. Show the sentence, not the status.
  if (!res.ok) throw new Error(data.error || (method + ' ' + path + ' failed'));
  return data;
}

function say(node, text, ok) {
  if (!node) return;
  node.textContent = text;
  node.className = 'msg ' + (ok ? 'good' : 'bad');
  if (ok) setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, 4000);
}

/**
 * Run an action attached to a button.
 *
 * The button says what it is doing and cannot be pressed twice while it does
 * it. Double-submitting a mission edit is harmless; double-submitting a buy
 * would not be, and the habit should be the same in both places.
 */
async function withButton(button, busyText, msgNode, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    const result = await fn();
    say(msgNode, result || 'saved', true);
    return true;
  } catch (err) {
    say(msgNode, err.message, false);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function thumb(url, alt, big) {
  const cls = 'thumb' + (big ? ' lg' : '');
  if (!url) {
    const ph = el('div', cls + ' ph', '▦');
    ph.title = 'no image yet — the Watcher fills this in on its first read';
    return ph;
  }
  const img = el('img', cls);
  img.src = url;
  img.alt = alt || '';
  img.loading = 'lazy';
  // A dead CDN URL should degrade to the placeholder, not a broken-image icon.
  img.addEventListener('error', () => img.replaceWith(thumb('', alt, big)));
  return img;
}

function panel(key, summaryText, build) {
  const d = el('details');
  d.open = OPEN.has(key);
  d.addEventListener('toggle', () => { d.open ? OPEN.add(key) : OPEN.delete(key); });
  d.appendChild(el('summary', null, summaryText));
  d.appendChild(build());
  return d;
}

function emptyBlock(title, detail) {
  const box = el('div', 'empty');
  box.appendChild(el('strong', null, title));
  box.append(detail);
  return box;
}

/* ── missions ───────────────────────────────────────────────────────────── */

function missionCard(m) {
  const card = el('div', 'card' + (m.enabled ? '' : ' off'));
  const row = el('div', 'row');
  row.appendChild(thumb(m.imageUrl, m.productName));

  const left = el('div', 'grow');
  left.appendChild(el('div', 'name', m.productName));

  const where = el('div', 'meta');
  where.append(m.retailer + ' · ' + (m.externalId || '—') + ' · ');
  const a = el('a', null, 'open page');
  a.href = m.url; a.target = '_blank'; a.rel = 'noreferrer';
  where.appendChild(a);
  left.appendChild(where);

  const flags = el('div', 'meta');
  flags.style.marginTop = '7px';
  const label = m.state === 'in' ? 'IN STOCK'
    : m.state === 'out' ? 'out of stock'
    : m.state === 'unchecked' ? 'never checked' : m.state;
  flags.appendChild(el('span', 'pill s-' + m.state, label));

  if (!m.enabled) flags.appendChild(el('span', 'pill s-out', 'paused'));
  if (m.armed) {
    flags.appendChild(el('span', 'pill flag',
      'ARMED · ' + m.quantity + ' @ ' + money(m.ceiling)));
  } else if (m.enabled) {
    flags.appendChild(el('span', 'pill info', 'watching only'));
  }
  // The Walmart trap, made visible rather than buried in a note nobody reads.
  if (m.sellerKind === 'marketplace') {
    flags.appendChild(el('span', 'pill flag', 'marketplace: ' + (m.sellerName || 'third party')));
  }
  if (m.confidence !== 'exact' && m.state !== 'unchecked') {
    flags.appendChild(el('span', 'pill s-unknown', m.confidence + ' read'));
  }
  if (m.isPreOrder) {
    flags.appendChild(el('span', 'pill s-queue',
      'preorder' + (m.releaseDate ? ' · ' + m.releaseDate : '')));
  }
  left.appendChild(flags);
  if (m.note) {
    const note = el('div', 'meta', m.note);
    note.style.marginTop = '7px';
    left.appendChild(note);
  }

  const right = el('div', 'right');
  // Against MSRP, a price is either a restock or a scalper. Say which.
  let priceClass = 'price';
  if (m.price !== null && m.msrp !== null) {
    priceClass += m.price > m.msrp * 1.05 ? ' over' : ' under';
  }
  right.appendChild(el('div', priceClass, money(m.price)));
  if (m.msrp !== null) {
    const vs = m.price === null ? 'MSRP ' + money(m.msrp)
      : m.price > m.msrp * 1.05
        ? money(m.price - m.msrp) + ' over MSRP'
        : 'at or under MSRP';
    right.appendChild(el('div', 'meta', vs));
  }
  const stale = m.lastCheckedAt && (Date.now() - new Date(m.lastCheckedAt).getTime()) > STALE_MS;
  right.appendChild(el('div', (stale || !m.lastCheckedAt) ? 'meta stale' : 'meta',
    'checked ' + ago(m.lastCheckedAt)));
  if (m.state === 'in' && m.lastChangedAt) {
    right.appendChild(el('div', 'meta', 'in stock since ' + ago(m.lastChangedAt)));
  }
  if (m.availableQuantity !== null && m.availableQuantity !== undefined) {
    right.appendChild(el('div', 'meta', m.availableQuantity + ' available'));
  }

  row.append(left, right);
  card.appendChild(row);
  card.appendChild(panel('m' + m.id, 'Settings and run history', () => missionPanel(m)));
  return card;
}

function missionPanel(m) {
  const wrap = el('div');
  wrap.style.marginTop = '10px';

  const form = el('form', 'stack');
  form.dataset.mission = String(m.id);
  form.innerHTML = \`
    <div class="grid2">
      <label class="f">Price ceiling <span class="hint">per unit</span>
        <input type="number" name="ceiling" step="0.01" min="0.01" placeholder="none set">
      </label>
      <label class="f">Quantity
        <input type="number" name="quantity" min="1" max="20">
      </label>
      <label class="f">Check every
        <select name="checkEverySeconds">
          <option value="30">30 seconds</option>
          <option value="60">1 minute</option>
          <option value="300">5 minutes</option>
          <option value="1800">30 minutes</option>
          <option value="3600">1 hour</option>
        </select>
      </label>
      <label class="f">Sellers
        <select name="sellerPolicy">
          <option value="retailer_only">The retailer only</option>
          <option value="any">Any seller, under the ceiling</option>
        </select>
      </label>
    </div>
    <label class="check"><input type="checkbox" name="enabled"> Watching — check this listing on schedule</label>
    <label class="check"><input type="checkbox" name="armed"> Armed — may buy without asking me</label>
    <div class="actions">
      <button type="submit" class="primary">Save changes</button>
      <button type="button" class="danger" data-act="delete">Delete mission</button>
      <span class="msg"></span>
    </div>\`;

  const q = (n) => form.querySelector('[name=' + n + ']');
  q('ceiling').value = m.ceiling ?? '';
  q('quantity').value = m.quantity;
  q('checkEverySeconds').value = String(m.checkEverySeconds);
  q('sellerPolicy').value = m.sellerPolicy;
  q('enabled').checked = m.enabled;
  q('armed').checked = m.armed;
  const msg = form.querySelector('.msg');

  // Say what arming means before it is saved, not after.
  const armed = q('armed');
  const warn = el('div', 'msg');
  armed.addEventListener('change', () => {
    warn.textContent = armed.checked
      ? 'This mission will buy on its own. It needs a price ceiling.'
      : '';
    warn.className = 'msg bad';
  });
  form.insertBefore(warn, form.querySelector('.actions'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fields(form);
    await withButton(e.submitter || form.querySelector('button[type=submit]'), 'Saving…', msg,
      async () => {
        await api('POST', '/api/missions', {
          listingId: m.listingId,
          label: m.label,
          enabled: f.enabled,
          armed: f.armed,
          ceiling: num(f.ceiling),
          quantity: Number(f.quantity),
          sellerPolicy: f.sellerPolicy,
          checkEverySeconds: Number(f.checkEverySeconds),
        });
        load();
        return 'saved';
      });
  });

  form.querySelector('[data-act=delete]').addEventListener('click', async (e) => {
    if (!confirm('Delete this mission?\\n\\nThe product and its listing stay. Run history goes.')) return;
    await withButton(e.target, 'Deleting…', msg, async () => {
      await api('DELETE', '/api/missions/' + m.id);
      load();
      return 'deleted';
    });
  });

  wrap.appendChild(form);

  const runs = el('div');
  runs.style.marginTop = '12px';
  const btn = el('button', 'small', 'Load this mission’s runs');
  btn.addEventListener('click', async () => {
    await withButton(btn, 'Loading…', null, async () => {
      const data = await api('GET', '/api/missions/' + m.id + '/runs');
      btn.remove();
      runs.appendChild(runTable(data.runs, 'This mission has not run yet.'));
    });
  });
  runs.appendChild(btn);
  wrap.appendChild(runs);
  return wrap;
}

function runTable(runs, emptyText) {
  if (!runs.length) return el('div', 'meta', emptyText);
  const table = el('table');
  const head = el('tr');
  for (const h of ['When', 'Product', 'Outcome', 'Reason', '']) head.appendChild(el('th', null, h));
  const body = el('tbody');
  body.appendChild(head);
  for (const r of runs) {
    const tr = el('tr');
    tr.appendChild(el('td', 'meta nowrap', ago(r.startedAt)));
    tr.appendChild(el('td', null, r.productName));
    tr.appendChild(el('td', 'o-' + r.outcome + ' nowrap', r.outcome.replace('_', ' ')));
    // Every non-success carries a reason. Showing it is the point of recording it.
    tr.appendChild(el('td', 'meta', r.reason || ''));
    const right = el('td', 'meta nowrap',
      [r.price !== null ? money(r.price) : '', r.ms !== null ? r.ms + 'ms' : '']
        .filter(Boolean).join(' · '));
    right.style.textAlign = 'right';
    tr.appendChild(right);
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

/* ── products ───────────────────────────────────────────────────────────── */

function productCard(p) {
  const card = el('div', 'card');
  const row = el('div', 'row');
  row.appendChild(thumb(p.imageUrl, p.name, true));

  const left = el('div', 'grow');
  left.appendChild(el('div', 'name', p.name));

  const facts = [];
  if (p.msrp !== null) facts.push('MSRP ' + money(p.msrp));
  facts.push(p.releaseDate ? 'releases ' + p.releaseDate : 'no release date');
  const mine = DATA.listings.filter((l) => l.productKey === p.key);
  facts.push(mine.length === 1 ? '1 listing' : mine.length + ' listings');
  left.appendChild(el('div', 'meta', facts.join(' · ')));

  if (p.notes) left.appendChild(el('div', 'meta', p.notes));

  const missions = DATA.missions.filter((m) => m.productKey === p.key);
  if (missions.length) {
    const states = el('div', 'meta');
    states.style.marginTop = '7px';
    for (const m of missions) {
      states.appendChild(el('span', 'pill s-' + m.state, m.retailer + ': ' + m.state));
    }
    left.appendChild(states);
  }

  row.append(left);
  card.appendChild(row);
  card.appendChild(panel('p' + p.key, 'Listings and details', () => productPanel(p, mine)));
  return card;
}

function productPanel(p, listings) {
  const wrap = el('div');
  wrap.style.marginTop = '10px';

  // ── where to buy it
  wrap.appendChild(el('h3', null, 'Where to buy it'));
  if (!listings.length) {
    wrap.appendChild(el('div', 'meta', 'No listings yet. Paste a product URL below.'));
  } else {
    const table = el('table');
    const body = el('tbody');
    for (const l of listings) {
      const tr = el('tr');
      tr.appendChild(el('td', 'nowrap', l.retailer));
      tr.appendChild(el('td', 'meta', l.externalId));
      const linkCell = el('td');
      const a = el('a', null, 'open');
      a.href = l.url; a.target = '_blank'; a.rel = 'noreferrer';
      linkCell.appendChild(a);
      tr.appendChild(linkCell);
      const seller = el('td', 'meta',
        l.sellerKind === 'marketplace' ? 'marketplace · ' + (l.sellerName || 'third party')
        : l.sellerKind === 'retailer' ? 'sold by the retailer' : 'seller unknown');
      tr.appendChild(seller);
      const actions = el('td');
      actions.style.textAlign = 'right';
      const del = el('button', 'small danger', 'remove');
      del.addEventListener('click', async () => {
        if (!confirm('Remove the ' + l.retailer + ' listing?\\n\\nIts mission and run history go with it.')) return;
        await withButton(del, 'removing…', msg, async () => {
          await api('DELETE', '/api/listings/' + l.id);
          load();
          return 'removed';
        });
      });
      actions.appendChild(del);
      tr.appendChild(actions);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
  }

  // ── add a listing
  const addForm = el('form', 'stack');
  addForm.style.marginTop = '10px';
  addForm.dataset.product = p.key;
  addForm.innerHTML = \`
    <label class="f">Add a listing
      <input type="url" name="url" placeholder="Paste a Target, Pokémon Center or Walmart product URL">
    </label>
    <div class="actions">
      <button type="submit">Add listing and watch it</button>
      <span class="sub">the retailer and SKU are read from the URL</span>
    </div>\`;
  const msg = el('span', 'msg');
  addForm.querySelector('.actions').appendChild(msg);
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fields(addForm);
    await withButton(addForm.querySelector('button[type=submit]'), 'Adding…', msg, async () => {
      const { listing } = await api('POST', '/api/listings', { productKey: p.key, url: f.url });
      // A listing with no mission is a thing you meant to watch and didn't.
      await api('POST', '/api/missions', { listingId: listing.id, label: p.name, enabled: true });
      addForm.reset();
      load();
      return 'added ' + listing.retailer + ' ' + listing.externalId + ', now watching';
    });
  });
  wrap.appendChild(addForm);

  // ── edit the product
  const edit = el('form', 'stack');
  edit.style.marginTop = '14px';
  edit.dataset.editProduct = p.key;
  edit.innerHTML = \`
    <h3 style="margin-top:6px">Details</h3>
    <label class="f">Name<input type="text" name="name"></label>
    <div class="grid2">
      <label class="f">Release date<input type="date" name="releaseDate"></label>
      <label class="f">MSRP<input type="number" name="msrp" step="0.01" min="0.01"></label>
    </div>
    <label class="f">Image URL<input type="url" name="imageUrl"></label>
    <label class="f">Notes<textarea name="notes"></textarea></label>
    <div class="actions">
      <button type="submit" class="primary">Save details</button>
      <button type="button" class="danger" data-act="delete-product">Delete product</button>
      <span class="msg"></span>
    </div>\`;
  const eq = (n) => edit.querySelector('[name=' + n + ']');
  eq('name').value = p.name;
  eq('releaseDate').value = p.releaseDate ?? '';
  eq('msrp').value = p.msrp ?? '';
  eq('imageUrl').value = p.imageUrl ?? '';
  eq('notes').value = p.notes ?? '';
  const editMsg = edit.querySelector('.msg');

  edit.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fields(edit);
    await withButton(edit.querySelector('button[type=submit]'), 'Saving…', editMsg, async () => {
      await api('POST', '/api/products', {
        key: p.key,
        name: f.name,
        releaseDate: f.releaseDate || null,
        msrp: num(f.msrp),
        imageUrl: f.imageUrl,
        notes: f.notes,
      });
      load();
      return 'saved';
    });
  });

  edit.querySelector('[data-act=delete-product]').addEventListener('click', async (e) => {
    if (!confirm('Delete "' + p.name + '"?\\n\\nEvery listing, mission and run for it goes too.')) return;
    await withButton(e.target, 'Deleting…', editMsg, async () => {
      await api('DELETE', '/api/products/' + encodeURIComponent(p.key));
      load();
      return 'deleted';
    });
  });
  wrap.appendChild(edit);
  return wrap;
}

/* ── rendering ──────────────────────────────────────────────────────────── */

function render() {
  const missions = document.getElementById('missions');
  missions.textContent = '';
  if (!DATA.missions.length) {
    missions.appendChild(emptyBlock('Nothing is being watched yet.',
      'Add a product on the Products tab, paste a listing URL, and a mission is created for you.'));
  }
  for (const m of DATA.missions) missions.appendChild(missionCard(m));

  const products = document.getElementById('products');
  products.textContent = '';
  if (!DATA.products.length) {
    products.appendChild(emptyBlock('No products yet.', 'Add one with the form above.'));
  }
  for (const p of DATA.products) products.appendChild(productCard(p));

  const runsCard = document.getElementById('runs-card');
  runsCard.textContent = '';
  runsCard.appendChild(runTable(DATA.runs, 'Nothing has run yet.'));

  const changesCard = document.getElementById('changes-card');
  changesCard.textContent = '';
  if (!DATA.changes.length) {
    changesCard.appendChild(el('div', 'meta', 'Nothing has changed yet.'));
  } else {
    const table = el('table');
    const body = el('tbody');
    const head = el('tr');
    for (const h of ['When', 'Product', 'Retailer', 'Now']) head.appendChild(el('th', null, h));
    body.appendChild(head);
    for (const o of DATA.changes) {
      const tr = el('tr');
      tr.appendChild(el('td', 'meta nowrap', ago(o.at)));
      tr.appendChild(el('td', null, o.productName));
      tr.appendChild(el('td', 'meta', o.retailer));
      const td = el('td', 'nowrap');
      td.style.textAlign = 'right';
      td.append(o.state + ' · ' + money(o.price));
      tr.appendChild(td);
      body.appendChild(tr);
    }
    table.appendChild(body);
    changesCard.appendChild(table);
  }

  const inStock = DATA.missions.filter((m) => m.state === 'in').length;
  const armed = DATA.missions.filter((m) => m.armed).length;
  const never = DATA.missions.filter((m) => m.state === 'unchecked').length;
  const parts = [];
  if (inStock) parts.push(inStock + ' in stock');
  if (armed) parts.push(armed + ' armed');
  if (never) parts.push(never + ' never checked');
  document.getElementById('summary').textContent =
    parts.length ? parts.join(' · ') : 'nothing in stock';

  document.getElementById('c-missions').textContent = DATA.missions.length || '';
  document.getElementById('c-products').textContent = DATA.products.length || '';
  document.getElementById('c-activity').textContent = DATA.runs.length || '';
}

async function load() {
  try {
    DATA = await api('GET', '/api/dashboard');
  } catch (err) {
    document.getElementById('summary').textContent = err.message;
    return;
  }
  render();
}

document.getElementById('product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = fields(form);
  const msg = document.getElementById('product-msg');
  await withButton(form.querySelector('button[type=submit]'), 'Adding…', msg, async () => {
    const { product } = await api('POST', '/api/products', {
      name: f.name,
      releaseDate: f.releaseDate || null,
      msrp: num(f.msrp),
      imageUrl: f.imageUrl,
      notes: f.notes,
    });
    form.reset();
    OPEN.add('p' + product.key);   // open it, so the next step is in front of you
    load();
    return 'added — now give it a listing URL below';
  });
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === tab);
    for (const name of ['missions', 'products', 'activity']) {
      document.getElementById('tab-' + name).hidden = name !== tab.dataset.tab;
    }
  });
}

document.getElementById('refresh').addEventListener('click', (e) =>
  withButton(e.target, 'Refreshing…', null, load));

let timer = setInterval(load, 30000);
document.getElementById('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 30000);
});
load();
</script>
</body></html>`;
}
