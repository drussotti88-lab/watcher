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
  --bg: #fbfaf8; --panel: #ffffff; --line: #e6e2dc;
  --ink: #1c1a17; --muted: #6d675e;
  --in: #1c6b45; --in-bg: #e6f4ec;
  --out: #7a736a; --out-bg: #f1efec;
  --warn: #8a5a10; --warn-bg: #fdf1dd;
  --alert: #a3341f; --alert-bg: #fbeae6;
  --accent: #2a5db0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16150f; --panel: #1e1d17; --line: #33312a;
    --ink: #edeae4; --muted: #a09a90;
    --in: #6fd39d; --in-bg: #14301f;
    --out: #8f887e; --out-bg: #242219;
    --warn: #e0b060; --warn-bg: #33270f;
    --alert: #f0907a; --alert-bg: #3a1d16;
    --accent: #8fb4f5;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1000px; margin: 0 auto; padding: 28px 20px 80px; }
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
h1 { font-size: 21px; margin: 0; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
.bar { display: flex; gap: 10px; align-items: center; margin: 18px 0 20px; flex-wrap: wrap; }
button, .btn {
  font: inherit; padding: 7px 13px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
button:hover { border-color: var(--muted); }
.card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 12px; padding: 14px 16px; margin-bottom: 10px;
}
.row { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.grow { flex: 1 1 260px; min-width: 0; }
.name { font-weight: 600; margin-bottom: 2px; }
.meta { color: var(--muted); font-size: 13px; }
.price { font-variant-numeric: tabular-nums; font-size: 19px; font-weight: 600; white-space: nowrap; }
.pill {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap;
}
.s-in { background: var(--in-bg); color: var(--in); }
.s-out { background: var(--out-bg); color: var(--out); }
.s-unknown, .s-unchecked, .s-queue { background: var(--warn-bg); color: var(--warn); }
.flag { background: var(--alert-bg); color: var(--alert); }
a { color: var(--accent); }
.empty { color: var(--muted); padding: 30px 0; text-align: center; }
.stale { color: var(--alert); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td { padding: 6px 8px; border-top: 1px solid var(--line); vertical-align: top; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em;
     color: var(--muted); margin: 34px 0 10px; }

/* ── mission management ─────────────────────────────────────────────────── */
.tabs { display: flex; gap: 4px; margin: 18px 0 16px; border-bottom: 1px solid var(--line); }
.tab {
  padding: 8px 14px; cursor: pointer; border: none; background: none;
  color: var(--muted); border-bottom: 2px solid transparent; border-radius: 0;
  font: inherit;
}
.tab:hover { color: var(--ink); border-color: var(--line); }
.tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.thumb {
  width: 56px; height: 56px; border-radius: 8px; object-fit: contain;
  background: var(--out-bg); flex: 0 0 auto;
}
.thumb.ph { display: flex; align-items: center; justify-content: center;
            color: var(--muted); font-size: 20px; }
form.stack { display: grid; gap: 8px; max-width: 560px; }
label.f { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input[type=text], input[type=url], input[type=number], input[type=date], select, textarea {
  font: inherit; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink); width: 100%;
}
.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
.inline > * { flex: 1 1 160px; }
.inline > button { flex: 0 0 auto; }
.danger { color: var(--alert); border-color: var(--alert); }
.armed { background: var(--alert-bg); color: var(--alert); }
.off { opacity: 0.55; }
.msg { font-size: 13px; min-height: 18px; }
.msg.bad { color: var(--alert); }
.msg.good { color: var(--in); }
details > summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.runs td:first-child { white-space: nowrap; }
.o-bought { color: var(--in); font-weight: 600; }
.o-failed, .o-blocked { color: var(--alert); font-weight: 600; }
.o-declined { color: var(--warn); }
.login { max-width: 340px; margin: 16vh auto; }
input[type=password] {
  font: inherit; width: 100%; padding: 9px 11px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
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
    <button class="tab on" data-tab="missions">Missions</button>
    <button class="tab" data-tab="products">Products</button>
    <button class="tab" data-tab="activity">Activity</button>
  </div>

  <div class="bar">
    <button id="refresh">Refresh</button>
    <label class="sub"><input type="checkbox" id="auto" checked> auto every 30s</label>
    <span class="grow"></span>
    <a class="btn" href="/logout">Sign out</a>
  </div>

  <section id="tab-missions"><div id="missions"></div></section>

  <section id="tab-products" hidden>
    <div class="card">
      <div class="name">Add a product</div>
      <p class="meta">The thing itself. Where to buy it comes next.</p>
      <form class="stack" id="product-form" style="margin-top:10px">
        <label class="f">Name
          <input type="text" name="name" required placeholder="Pokémon TCG: Pitch Black Elite Trainer Box">
        </label>
        <label class="f">Release date <span style="opacity:.7">(optional)</span>
          <input type="date" name="releaseDate">
        </label>
        <div class="inline">
          <button type="submit">Add product</button>
          <span class="msg" id="product-msg"></span>
        </div>
      </form>
    </div>
    <div id="products"></div>
  </section>

  <section id="tab-activity" hidden>
    <h2 style="margin-top:0">Mission runs</h2>
    <p class="meta" style="margin:-6px 0 10px">
      Only written when a mission did something, or could not. Routine checks
      that found nothing are not runs.
    </p>
    <div class="card"><table class="runs" id="runs"><tbody></tbody></table></div>

    <h2>Stock and price changes</h2>
    <div class="card"><table id="feed"><tbody></tbody></table></div>
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

// Anything older than five minutes is not a live reading. Say so loudly
// rather than showing a stale price as though it were current.
const STALE_MS = 5 * 60 * 1000;

let DATA = { missions: [], runs: [], changes: [], products: [], listings: [] };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

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

function say(id, text, ok) {
  const n = document.getElementById(id);
  n.textContent = text;
  n.className = 'msg ' + (ok ? 'good' : 'bad');
  if (ok) setTimeout(() => { n.textContent = ''; }, 4000);
}

function thumb(url, alt) {
  if (!url) {
    const ph = el('div', 'thumb ph', '▦');
    ph.title = 'no image yet — the Watcher fills this in on its first read';
    return ph;
  }
  const img = el('img', 'thumb');
  img.src = url;
  img.alt = alt || '';
  img.loading = 'lazy';
  // A dead CDN URL should degrade to the placeholder, not a broken-image icon.
  img.addEventListener('error', () => img.replaceWith(thumb('', alt)));
  return img;
}

/* ── missions ───────────────────────────────────────────────────────────── */

function missionCard(m) {
  const card = el('div', 'card' + (m.enabled ? '' : ' off'));
  const row = el('div', 'row');
  row.appendChild(thumb(m.imageUrl, m.productName));

  const left = el('div', 'grow');
  left.appendChild(el('div', 'name', m.productName));

  const meta = el('div', 'meta');
  meta.append(m.retailer + ' · ' + (m.externalId || '—') + ' · ');
  const a = el('a', null, 'open');
  a.href = m.url; a.target = '_blank'; a.rel = 'noreferrer';
  meta.appendChild(a);
  left.appendChild(meta);

  const flags = el('div', 'meta');
  flags.style.marginTop = '6px';
  const label = m.state === 'in' ? 'IN STOCK'
    : m.state === 'out' ? 'out of stock'
    : m.state === 'unchecked' ? 'never checked' : m.state;
  flags.appendChild(el('span', 'pill s-' + m.state, label));

  if (!m.enabled) { flags.append(' '); flags.appendChild(el('span', 'pill s-out', 'paused')); }
  if (m.armed) {
    flags.append(' ');
    flags.appendChild(el('span', 'pill armed', 'ARMED · ' + m.quantity + ' @ ' + money(m.ceiling)));
  }
  // The Walmart trap, made visible rather than buried in a note nobody reads.
  if (m.sellerKind === 'marketplace') {
    flags.append(' ');
    flags.appendChild(el('span', 'pill flag', 'marketplace: ' + (m.sellerName || 'third party')));
  }
  if (m.confidence !== 'exact' && m.state !== 'unchecked') {
    flags.append(' ');
    flags.appendChild(el('span', 'pill s-unknown', m.confidence + ' read'));
  }
  if (m.isPreOrder) {
    flags.append(' ');
    flags.appendChild(el('span', 'pill s-queue',
      'preorder' + (m.releaseDate ? ' · ' + m.releaseDate : '')));
  }
  left.appendChild(flags);
  if (m.note) {
    const note = el('div', 'meta', m.note);
    note.style.marginTop = '6px';
    left.appendChild(note);
  }

  const right = el('div');
  right.style.textAlign = 'right';
  right.appendChild(el('div', 'price', money(m.price)));
  const stale = m.lastCheckedAt && (Date.now() - new Date(m.lastCheckedAt).getTime()) > STALE_MS;
  const checked = el('div', (stale || !m.lastCheckedAt) ? 'meta stale' : 'meta',
    'checked ' + ago(m.lastCheckedAt));
  right.appendChild(checked);
  if (m.state === 'in' && m.lastChangedAt) {
    right.appendChild(el('div', 'meta', 'since ' + ago(m.lastChangedAt)));
  }
  if (m.availableQuantity !== null && m.availableQuantity !== undefined) {
    right.appendChild(el('div', 'meta', m.availableQuantity + ' available'));
  }

  row.append(left, right);
  card.appendChild(row);
  card.appendChild(missionControls(m));
  return card;
}

function missionControls(m) {
  const wrap = el('details');
  wrap.style.marginTop = '10px';
  wrap.appendChild(el('summary', null, 'Settings and history'));

  const form = el('form', 'stack');
  form.style.marginTop = '10px';
  form.innerHTML = \`
    <div class="inline">
      <label class="f">Price ceiling
        <input type="number" name="ceiling" step="0.01" min="0.01" placeholder="none">
      </label>
      <label class="f">Quantity
        <input type="number" name="quantity" min="1" max="20" value="1">
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
    <div class="inline">
      <label class="f" style="flex:0 0 auto">
        <span><input type="checkbox" name="enabled"> Watching</span>
      </label>
      <label class="f" style="flex:0 0 auto">
        <span><input type="checkbox" name="armed"> Armed — may buy</span>
      </label>
      <span class="grow"></span>
      <button type="submit">Save</button>
      <button type="button" class="danger" data-del="\${m.id}">Delete</button>
    </div>
    <span class="msg" id="m-msg-\${m.id}"></span>\`;

  form.ceiling.value = m.ceiling ?? '';
  form.quantity.value = m.quantity;
  form.checkEverySeconds.value = String(m.checkEverySeconds);
  form.sellerPolicy.value = m.sellerPolicy;
  form.enabled.checked = m.enabled;
  form.armed.checked = m.armed;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/missions', {
        listingId: m.listingId,
        label: m.label,
        enabled: form.enabled.checked,
        armed: form.armed.checked,
        ceiling: form.ceiling.value === '' ? null : Number(form.ceiling.value),
        quantity: Number(form.quantity.value),
        sellerPolicy: form.sellerPolicy.value,
        checkEverySeconds: Number(form.checkEverySeconds.value),
      });
      say('m-msg-' + m.id, 'saved', true);
      load();
    } catch (err) {
      say('m-msg-' + m.id, err.message, false);
    }
  });

  form.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm('Delete this mission? The product and its listing stay.')) return;
    try {
      await api('DELETE', '/api/missions/' + m.id);
      load();
    } catch (err) { say('m-msg-' + m.id, err.message, false); }
  });

  wrap.appendChild(form);

  const runs = el('div');
  runs.style.marginTop = '10px';
  const btn = el('button', null, 'Show this mission’s runs');
  btn.addEventListener('click', async () => {
    btn.remove();
    try {
      const data = await api('GET', '/api/missions/' + m.id + '/runs');
      runs.appendChild(runTable(data.runs, 'This mission has not run yet.'));
    } catch (err) {
      runs.appendChild(el('div', 'msg bad', err.message));
    }
  });
  runs.appendChild(btn);
  wrap.appendChild(runs);
  return wrap;
}

function runTable(runs, emptyText) {
  const table = el('table', 'runs');
  const body = el('tbody');
  if (!runs.length) {
    const tr = el('tr');
    const td = el('td', 'meta', emptyText);
    td.colSpan = 5; tr.appendChild(td); body.appendChild(tr);
  }
  for (const r of runs) {
    const tr = el('tr');
    tr.appendChild(el('td', 'meta', ago(r.startedAt)));
    tr.appendChild(el('td', null, r.productName));
    tr.appendChild(el('td', 'o-' + r.outcome, r.outcome));
    // Every non-success carries a reason. Showing it here is the whole point
    // of recording it.
    tr.appendChild(el('td', 'meta', r.reason || ''));
    const right = el('td', 'meta',
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
  row.appendChild(thumb(p.imageUrl, p.name));

  const left = el('div', 'grow');
  left.appendChild(el('div', 'name', p.name));
  const meta = el('div', 'meta',
    p.releaseDate ? 'releases ' + p.releaseDate : 'no release date set');
  left.appendChild(meta);

  const mine = DATA.listings.filter((l) => l.productKey === p.key);
  const list = el('div', 'meta');
  list.style.marginTop = '6px';
  if (!mine.length) {
    list.textContent = 'No listings yet — paste a product URL below.';
  } else {
    for (const l of mine) {
      const line = el('div');
      line.append(l.retailer + ' · ' + l.externalId + ' ');
      const del = el('button', 'danger');
      del.textContent = 'remove';
      del.style.padding = '0 6px';
      del.style.fontSize = '12px';
      del.addEventListener('click', async () => {
        if (!confirm('Remove this listing? Its mission and history go with it.')) return;
        try { await api('DELETE', '/api/listings/' + l.id); load(); }
        catch (err) { say('p-msg-' + p.key, err.message, false); }
      });
      line.appendChild(del);
      list.appendChild(line);
    }
  }
  left.appendChild(list);

  const form = el('form', 'inline');
  form.style.marginTop = '8px';
  form.innerHTML = \`
    <input type="url" name="url" required placeholder="Paste a Target / Pokémon Center / Walmart product URL">
    <button type="submit">Add listing</button>\`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { listing } = await api('POST', '/api/listings',
        { productKey: p.key, url: form.url.value });
      // A listing with no mission is a thing you meant to watch and didn't.
      await api('POST', '/api/missions', { listingId: listing.id, label: p.name, enabled: true });
      form.reset();
      say('p-msg-' + p.key, 'added ' + listing.retailer + ' ' + listing.externalId, true);
      load();
    } catch (err) { say('p-msg-' + p.key, err.message, false); }
  });
  left.appendChild(form);
  left.appendChild(Object.assign(el('span', 'msg'), { id: 'p-msg-' + p.key }));

  const right = el('div');
  right.style.textAlign = 'right';
  const del = el('button', 'danger', 'Delete product');
  del.addEventListener('click', async () => {
    if (!confirm('Delete "' + p.name + '"? Every listing, mission and run for it goes too.')) return;
    try { await api('DELETE', '/api/products/' + encodeURIComponent(p.key)); load(); }
    catch (err) { say('p-msg-' + p.key, err.message, false); }
  });
  right.appendChild(del);

  row.append(left, right);
  card.appendChild(row);
  return card;
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

function render() {
  const missions = document.getElementById('missions');
  missions.textContent = '';
  if (!DATA.missions.length) {
    missions.appendChild(el('div', 'empty',
      'No missions yet. Add a product, paste a listing URL, and one is created for you.'));
  }
  for (const m of DATA.missions) missions.appendChild(missionCard(m));

  const products = document.getElementById('products');
  products.textContent = '';
  for (const p of DATA.products) products.appendChild(productCard(p));

  const inStock = DATA.missions.filter((m) => m.state === 'in').length;
  const armed = DATA.missions.filter((m) => m.armed).length;
  const never = DATA.missions.filter((m) => m.state === 'unchecked').length;
  const parts = [DATA.missions.length + ' missions'];
  if (inStock) parts.push(inStock + ' in stock');
  if (armed) parts.push(armed + ' armed');
  if (never) parts.push(never + ' never checked');
  document.getElementById('summary').textContent = parts.join(' · ');

  const runs = document.getElementById('runs');
  runs.replaceWith(Object.assign(runTable(DATA.runs, 'Nothing has run yet.'), { id: 'runs' }));

  const feed = document.querySelector('#feed tbody');
  feed.textContent = '';
  if (!DATA.changes.length) {
    const tr = el('tr');
    const td = el('td', 'meta', 'Nothing has changed yet.');
    td.colSpan = 4; tr.appendChild(td); feed.appendChild(tr);
  }
  for (const o of DATA.changes) {
    const tr = el('tr');
    tr.appendChild(el('td', 'meta', ago(o.at)));
    tr.appendChild(el('td', null, o.productName));
    tr.appendChild(el('td', 'meta', o.retailer));
    const td = el('td');
    td.style.textAlign = 'right';
    td.append(o.state + ' · ' + money(o.price));
    tr.appendChild(td);
    feed.appendChild(tr);
  }
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
  const f = e.target;
  try {
    await api('POST', '/api/products',
      { name: f.name.value, releaseDate: f.releaseDate.value || null });
    f.reset();
    say('product-msg', 'added — now give it a listing URL below', true);
    load();
  } catch (err) { say('product-msg', err.message, false); }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === tab);
    for (const name of ['missions', 'products', 'activity']) {
      document.getElementById('tab-' + name).hidden = name !== tab.dataset.tab;
    }
  });
}

document.getElementById('refresh').addEventListener('click', load);
let timer = setInterval(load, 30000);
document.getElementById('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 30000);
});
load();
</script>
</body></html>`;
}
