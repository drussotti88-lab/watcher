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
    <h1>Watching</h1>
    <span class="sub" id="summary">loading…</span>
  </header>

  <div class="bar">
    <button id="refresh">Refresh</button>
    <label class="sub"><input type="checkbox" id="auto" checked> auto every 30s</label>
    <span class="grow"></span>
    <a class="btn" href="/logout">Sign out</a>
  </div>

  <div id="watches"></div>

  <h2>Recent changes</h2>
  <div class="card"><table id="feed"><tbody></tbody></table></div>
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

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function watchCard(w) {
  const card = el('div', 'card');
  const row = el('div', 'row');

  const left = el('div', 'grow');
  const name = el('div', 'name', w.productName);
  left.appendChild(name);

  const meta = el('div', 'meta');
  meta.append(w.retailer + ' · ' + (w.externalId || '—'));
  if (w.url) {
    meta.append(' · ');
    const a = el('a', null, 'open');
    a.href = w.url; a.target = '_blank'; a.rel = 'noreferrer';
    meta.appendChild(a);
  }
  left.appendChild(meta);

  const flags = el('div', 'meta');
  flags.style.marginTop = '6px';

  const pill = el('span', 'pill s-' + w.state,
    w.state === 'in' ? 'IN STOCK' :
    w.state === 'out' ? 'out of stock' :
    w.state === 'unchecked' ? 'never checked' : w.state);
  flags.appendChild(pill);

  // A marketplace seller at any price is not a restock at retail. This is the
  // Walmart trap made visible rather than left in a note nobody reads.
  if (w.sellerKind === 'marketplace') {
    flags.append(' ');
    const s = el('span', 'pill flag', 'marketplace: ' + (w.sellerName || 'third party'));
    flags.appendChild(s);
  }
  if (w.confidence !== 'exact' && w.state !== 'unchecked') {
    flags.append(' ');
    flags.appendChild(el('span', 'pill s-unknown', w.confidence + ' read'));
  }
  if (w.isPreOrder) {
    flags.append(' ');
    flags.appendChild(el('span', 'pill s-queue',
      'preorder' + (w.releaseDate ? ' · ' + w.releaseDate : '')));
  }
  left.appendChild(flags);

  if (w.note) {
    const note = el('div', 'meta', w.note);
    note.style.marginTop = '6px';
    left.appendChild(note);
  }

  const right = el('div');
  right.style.textAlign = 'right';
  right.appendChild(el('div', 'price', money(w.price)));

  const checked = el('div', 'meta');
  const stale = w.lastCheckedAt && (Date.now() - new Date(w.lastCheckedAt).getTime()) > STALE_MS;
  checked.textContent = 'checked ' + ago(w.lastCheckedAt);
  if (stale || !w.lastCheckedAt) checked.className = 'meta stale';
  right.appendChild(checked);

  if (w.state === 'in' && w.lastChangedAt) {
    right.appendChild(el('div', 'meta', 'since ' + ago(w.lastChangedAt)));
  }
  if (w.availableQuantity !== null && w.availableQuantity !== undefined) {
    right.appendChild(el('div', 'meta', w.availableQuantity + ' available'));
  }

  row.append(left, right);
  card.appendChild(row);
  return card;
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/dashboard', { headers: { 'Accept': 'application/json' } });
    if (res.status === 401) { location.href = '/login'; return; }
    data = await res.json();
  } catch (err) {
    document.getElementById('summary').textContent = 'could not reach the hub';
    return;
  }

  const list = document.getElementById('watches');
  list.textContent = '';

  if (!data.watches.length) {
    list.appendChild(el('div', 'empty', 'Nothing is being watched yet. Run the seed.'));
  } else {
    for (const w of data.watches) list.appendChild(watchCard(w));
  }

  const inStock = data.watches.filter((w) => w.state === 'in').length;
  const never = data.watches.filter((w) => w.state === 'unchecked').length;
  const parts = [data.watches.length + ' watched'];
  if (inStock) parts.push(inStock + ' in stock');
  if (never) parts.push(never + ' never checked');
  document.getElementById('summary').textContent = parts.join(' · ');

  const feed = document.querySelector('#feed tbody');
  feed.textContent = '';
  if (!data.recent.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'meta', 'Nothing has changed yet.');
    td.colSpan = 4; tr.appendChild(td); feed.appendChild(tr);
  }
  for (const o of data.recent) {
    const tr = document.createElement('tr');
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
