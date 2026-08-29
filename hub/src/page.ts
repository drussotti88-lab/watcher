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
 *
 * ── One trap, which has now bitten three times ──────────────────────────────
 *
 * The whole script lives inside a TypeScript template literal, so it eats a
 * layer of backslashes before a browser ever sees it. A regex written the
 * obvious way arrives mangled and usually still *parses*:
 *
 *   in this file      what the browser gets    what it does
 *   /^https?:\/\//     /^https?://              SyntaxError, page dead
 *   /\.$/              /.$/                     matches any char, ate a digit
 *
 * Double every backslash, or avoid the regex. The jsdom tests catch these
 * because they press the real buttons; nothing else does.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Themed to match dnacardvault.com.
 *
 * Palette, type and shape lifted from the live site rather than approximated:
 * near-black #09080E ground, #17161F surfaces, a periwinkle #7F77DD accent,
 * hairline borders at 7% white, 18px cards on a soft drop shadow, and
 * Syne / DM Sans / DM Mono.
 *
 * Dark only, because the site is dark only. A light mode here would be a second
 * design nobody asked for and nothing to check it against.
 */
const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  'family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&' +
  'family=DM+Mono:wght@400;500&display=swap">';

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #09080e;
  --panel: #17161f;
  --panel-2: rgba(237, 235, 245, .04);
  --line: rgba(237, 235, 245, .07);
  --line-strong: rgba(237, 235, 245, .13);
  --ink: #edebf5;
  --muted: #9b97b0;
  --dim: #6e6a85;

  --accent: #7f77dd;
  --accent-soft: rgba(127, 119, 221, .14);

  --in: #5fd3a0;      --in-bg: rgba(95, 211, 160, .13);
  --out: #9b97b0;     --out-bg: rgba(237, 235, 245, .07);
  --warn: #e0b060;    --warn-bg: rgba(224, 176, 96, .13);
  --alert: #f0836b;   --alert-bg: rgba(240, 131, 107, .13);

  --shadow: 0 8px 24px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.3);
  --r-card: 18px;
  --r-ctl: 13px;
  --r-sm: 9px;

  --sans: "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --display: Syne, var(--sans);
  --mono: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
main { max-width: 1040px; margin: 0 auto; padding: 28px 20px 96px; }

header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font: 800 26px/1.2 var(--display); margin: 0; letter-spacing: -0.02em; }
h2 { font: 700 12px/1.4 var(--display); text-transform: uppercase; letter-spacing: .1em;
     color: var(--dim); margin: 32px 0 10px; }
h3 { font: 700 14px/1.4 var(--display); margin: 0 0 8px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
a { color: var(--accent); text-underline-offset: 2px; }

.tabs { display: flex; gap: 2px; margin: 18px 0 16px; border-bottom: 1px solid var(--line); }
.tab { padding: 9px 16px; cursor: pointer; border: none; background: none;
       font: 500 14px/1.4 var(--sans); color: var(--muted);
       border-bottom: 2px solid transparent; border-radius: 0; }
.tab:hover { color: var(--ink); }
.tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.tab .count { font-family: var(--mono); font-size: 12px; opacity: .6; margin-left: 6px; }

.bar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
button, .btn {
  font: 600 14px/1.4 var(--sans); padding: 8px 15px; border-radius: var(--r-ctl);
  cursor: pointer; border: 1px solid var(--line-strong); background: var(--panel-2);
  color: var(--ink); text-decoration: none; display: inline-block;
  transition: border-color .12s, background .12s, opacity .12s;
}
button:hover:not(:disabled), .btn:hover { border-color: var(--accent); background: var(--accent-soft); }
button:disabled { opacity: .45; cursor: progress; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover:not(:disabled) { filter: brightness(1.1); background: var(--accent); }
button.danger { color: var(--alert); border-color: rgba(240,131,107,.35); }
button.danger:hover:not(:disabled) { background: var(--alert-bg); border-color: var(--alert); }
button.small { padding: 4px 10px; font-size: 12px; border-radius: var(--r-sm); }

.card { background: var(--panel); border: 1px solid var(--line);
        border-radius: var(--r-card); padding: 16px 18px; margin-bottom: 12px;
        box-shadow: var(--shadow); }
.row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.grow { flex: 1 1 260px; min-width: 0; }
.name { font: 600 15px/1.35 var(--sans); letter-spacing: -0.01em; }
.meta { color: var(--muted); font-size: 13px; }
.meta + .meta { margin-top: 3px; }
.price { font: 500 21px/1.2 var(--mono); letter-spacing: -0.02em; white-space: nowrap; }
.price.over { color: var(--alert); }
.price.under { color: var(--in); }
/* A fixed column, so prices line up down the page instead of each card
   deciding its own right edge. */
.right { text-align: right; flex: 0 0 auto; min-width: 152px; }
@media (max-width: 560px) { .right { text-align: left; min-width: 0; } }

/*
 * Tags.
 *
 * inline-flex with an explicit line-height, not inline-block: an inline-block
 * pill inherits the body's 1.55 line-height, so the text sits high in a box
 * that is taller than it needs to be, and each pill baseline-aligns against its
 * neighbours instead of centring in its own pill.
 *
 * text-indent cancels the letter-spacing. Letter-spacing adds its gap *after*
 * every character including the last, so the glyphs drift left of centre by
 * exactly one gap; indenting by the same amount puts them back.
 */
.pill {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 3px 11px; border-radius: 999px; min-height: 22px;
  font: 600 11.5px/1.2 var(--sans);
  letter-spacing: .04em; text-indent: .04em; text-transform: uppercase;
  white-space: nowrap; vertical-align: middle;
}
/* A flex row with a gap, so spacing never depends on stray text nodes. */
.tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 10px; }
.s-in { background: var(--in-bg); color: var(--in); }
.s-out { background: var(--out-bg); color: var(--out); }
.s-unknown, .s-unchecked, .s-queue { background: var(--warn-bg); color: var(--warn); }
.flag { background: var(--alert-bg); color: var(--alert); }
.info { background: var(--accent-soft); color: var(--accent); }
.stale { color: var(--alert); font-weight: 600; }

.thumb { width: 60px; height: 60px; border-radius: var(--r-ctl); object-fit: contain;
         background: var(--panel-2); border: 1px solid var(--line); flex: 0 0 auto; }
.thumb.ph { display: flex; align-items: center; justify-content: center;
            color: var(--dim); font-size: 20px; }
.thumb.lg { width: 88px; height: 88px; }

form.stack { display: grid; gap: 11px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 11px; }
label.f { display: grid; gap: 4px; font-size: 12px; color: var(--muted);
          font-weight: 500; letter-spacing: .01em; }
label.f .hint { font-weight: 400; color: var(--dim); }
label.check { display: flex; gap: 8px; align-items: center; font-size: 14px;
              color: var(--ink); cursor: pointer; }
input[type=text], input[type=url], input[type=number], input[type=date],
select, textarea, input[type=password] {
  font: 400 14px/1.5 var(--sans); padding: 9px 11px; border-radius: var(--r-ctl); width: 100%;
  border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink);
}
input::placeholder, textarea::placeholder { color: var(--dim); }
input:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
}
textarea { min-height: 64px; resize: vertical; }
.actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

.msg { font-size: 13px; min-height: 18px; }
.msg.bad { color: var(--alert); }
.msg.good { color: var(--in); }
.empty { color: var(--muted); padding: 38px 16px; text-align: center;
         border: 1px dashed var(--line-strong); border-radius: var(--r-card); }
.empty strong { color: var(--ink); display: block; margin-bottom: 5px;
                font: 700 15px/1.4 var(--display); }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { padding: 8px; border-top: 1px solid var(--line); vertical-align: top; text-align: left; }
th { color: var(--dim); font: 600 10.5px/1.4 var(--sans); text-transform: uppercase;
     letter-spacing: .09em; border-top: none; }
tr:first-child td { border-top: none; }
.nowrap { white-space: nowrap; }
.mono { font-family: var(--mono); }
.o-bought { color: var(--in); font-weight: 600; }
.o-failed, .o-blocked { color: var(--alert); font-weight: 600; }
.o-declined, .o-running { color: var(--warn); }
.o-in_stock { color: var(--in); }

details { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
details > summary { cursor: pointer; color: var(--muted); font-size: 13px; list-style: none;
                    font-weight: 500; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: '▸ '; color: var(--dim); }
details[open] > summary::before { content: '▾ '; }
details > summary:hover { color: var(--ink); }
.off { opacity: .5; }

header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.quickadd { margin-bottom: 14px; border-color: var(--accent); }
.quickadd h2 { margin: 0; font: 700 17px/1.3 var(--display); color: var(--ink); }
#install { flex: none; }

/* Room for the notch and the home indicator once it is installed. */
body { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
main { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }

.login { max-width: 350px; margin: 15vh auto; }
.login .card { padding: 26px 24px; }
.err { color: var(--alert); font-size: 13px; min-height: 20px; }
`;

export function loginPage(message = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub</title>${FONTS}<style>${STYLE}</style></head>
<body><main class="login">
  <div class="card">
    <h1>Hub</h1>
    <p class="sub" style="margin:6px 0 0">Sign in to see what's being watched.</p>
    <form method="POST" action="/login" style="margin-top:20px">
      <input type="password" name="password" placeholder="Password" autofocus required
             autocomplete="current-password">
      <div class="err" style="margin:9px 0">${esc(message)}</div>
      <button type="submit" class="primary" style="width:100%">Sign in</button>
    </form>
  </div>
</main></body></html>`;
}

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hub</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#09080e">
<link rel="icon" href="/icon-192.png" sizes="192x192" type="image/png">
<!-- iOS ignores the manifest for the home-screen icon and the status bar. -->
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Hub">
${FONTS}<style>${STYLE}</style></head>
<body><main>
  <header>
    <div>
      <h1>Hub</h1>
      <span class="sub" id="summary">loading…</span>
    </div>
    <button id="install" class="small" hidden>Install</button>
  </header>

  <div class="card quickadd" id="quickadd" hidden>
    <h2>Add a listing</h2>
    <p class="sub">Paste a Target, Pokémon Center or Walmart product link. It
      starts watching straight away — never armed, never with a ceiling.</p>
    <form class="stack" id="quick-form" style="margin-top:12px">
      <input type="url" name="url" id="quick-url" required
             placeholder="https://www.target.com/p/…/A-1012644666"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="actions">
        <button type="submit" class="primary">Watch this</button>
        <button type="button" class="small" data-act="quick-close">Close</button>
        <span class="msg" id="quick-msg"></span>
      </div>
    </form>
  </div>

  <div class="tabs">
    <button class="tab on" data-tab="missions">Missions<span class="count" id="c-missions"></span></button>
    <button class="tab" data-tab="products">Products<span class="count" id="c-products"></span></button>
    <button class="tab" data-tab="activity">Activity<span class="count" id="c-activity"></span></button>
    <button class="tab" data-tab="settings">Settings</button>
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
        <label class="f">First listing URL
          <span class="hint">optional — starts watching it straight away</span>
          <input type="url" name="url" autocomplete="off" autocapitalize="off" spellcheck="false"
                 placeholder="https://www.target.com/p/…/A-1012644666">
          <span class="hint">The product is not tied to this link. It is the first
            place to watch, and you can add the same product at another retailer
            afterwards.</span>
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

  <section id="tab-settings" hidden>
    <h2 style="margin-top:0">What is true of every mission</h2>
    <p class="sub" style="margin:-6px 0 14px">
      A price ceiling is per unit and covers the item and the tax on it.
      Shipping is charged per order, not per unit, so it has its own allowance
      here rather than being folded into the ceiling — adding it there would
      turn a $30 limit into $45 while the log still said $30.
    </p>
    <div class="card">
      <form class="stack" id="settings-form">
        <div class="grid2">
          <label class="f">Sales tax rate
            <span class="hint">as a percentage — 9.75 for 9.75%</span>
            <input type="number" name="taxRatePercent" step="0.001" min="0" max="25"
                   placeholder="0">
          </label>
          <label class="f">Shipping allowance
            <span class="hint">per order, on top of the ceiling</span>
            <input type="number" name="shippingAllowance" step="0.01" min="0" placeholder="0.00">
          </label>
        </div>
        <p class="sub" style="margin:0">
          A tax rate of 0 means no estimate is made: a listed price is judged as
          it stands and tax is only checked in the cart, where it is a real
          number rather than a guess. A shipping allowance of 0 means postage
          has to be free.
        </p>
        <div class="actions">
          <button type="submit" class="primary">Save settings</button>
          <span class="msg" id="settings-msg"></span>
        </div>
      </form>
    </div>
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
  where.append(m.retailer + ' · ');
  where.appendChild(el('span', 'mono', m.externalId || '—'));
  where.append(' · ');
  const a = el('a', null, 'open page');
  a.href = m.url; a.target = '_blank'; a.rel = 'noreferrer';
  where.appendChild(a);
  left.appendChild(where);

  const flags = el('div', 'tags');
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
  if (m.note) {
    const note = el('div', 'meta', m.note);
    note.style.marginTop = '6px';
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
  // Tags go below the whole row, full width. Nested inside the title column
  // they were competing with the price for space and wrapping at odd points.
  card.appendChild(flags);
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
      <label class="f">Price ceiling <span class="hint">per unit, including tax</span>
        <input type="number" name="ceiling" step="0.01" min="0.01" placeholder="none set">
        <span class="hint" data-hint="ceiling"></span>
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
      <button type="button" data-act="check-now">Test run</button>
      <button type="button" class="danger" data-act="delete">Delete mission</button>
      <span class="msg"></span>
    </div>\`;

  const q = (n) => form.querySelector('[name=' + n + ']');
  // Suggest a ceiling from MSRP when there isn't one, and say that is what it
  // is. A suggestion you can see and overwrite; never a limit that appeared on
  // its own. Arming stays a separate, explicit tick.
  const hint = form.querySelector('[data-hint=ceiling]');
  if (m.ceiling !== null) {
    q('ceiling').value = m.ceiling;
  } else if (m.msrp !== null) {
    const rate = (DATA.settings && DATA.settings.taxRate) || 0;
    const suggested = Math.round(m.msrp * (1 + rate) * 100) / 100;
    q('ceiling').value = suggested;
    hint.textContent = rate > 0
      ? 'suggested: MSRP ' + money(m.msrp) + ' + ' + (rate * 100).toFixed(2) + '% tax — change it'
      : 'suggested from MSRP ' + money(m.msrp) + ' — no tax rate set, so tax is only checked in the cart';
  } else {
    q('ceiling').value = '';
    hint.textContent = 'no MSRP on this product to suggest one from';
  }
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

  // "Test run" — ask for this one to be checked next pass.
  //
  // The wording on the button and in the reply both say *queued*, deliberately.
  // The Hub has no browser, and the Watcher will not jump the retailer's
  // pacing for a button click, so anything promising "checking now" would be
  // making a claim neither of them can keep.
  const checkNow = form.querySelector('[data-act=check-now]');
  if (m.checkNow) checkNow.textContent = 'Test run queued';
  checkNow.addEventListener('click', async (e) => {
    const ok = await withButton(e.target, 'Queueing…', msg, async () => {
      await api('POST', '/api/missions/' + m.id + '/check-now');
      return 'queued — the Watcher will check this on its next pass';
    });
    // withButton restores the label it started with, which is right for every
    // other button on this page and wrong for this one: the request outlives
    // the click, and the button is the only thing showing that.
    if (ok) e.target.textContent = 'Test run queued';
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
    const right = el('td', 'meta nowrap mono',
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
    const states = el('div', 'tags');
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
      tr.appendChild(el('td', 'meta mono', l.externalId));
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

  const st = DATA.settings || { taxRate: 0, shippingAllowance: 0 };
  const sf = document.getElementById('settings-form');
  // Percent in the box, fraction on the wire. 9.75 typed where 0.0975 was
  // meant would decline every mission you own, so the form only ever speaks
  // percent and the conversion happens in one place.
  if (document.activeElement !== sf.querySelector('[name=taxRatePercent]')) {
    // Number(...) rather than a regex to trim the zeros. Every backslash in
    // this file has to survive the template literal, and /\\.$/ written the
    // obvious way reaches the browser as /.$/ — which matches any character
    // and silently turned 9.75 into 9.7.
    sf.querySelector('[name=taxRatePercent]').value =
      st.taxRate ? String(Number((st.taxRate * 100).toFixed(3))) : '';
  }
  if (document.activeElement !== sf.querySelector('[name=shippingAllowance]')) {
    sf.querySelector('[name=shippingAllowance]').value = st.shippingAllowance || '';
  }

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
    const details = {
      name: f.name,
      releaseDate: f.releaseDate || null,
      msrp: num(f.msrp),
      imageUrl: f.imageUrl,
      notes: f.notes,
    };

    // With a URL this is one call: the product, its first listing and the
    // mission to watch it. Without one it is just the product, and the listing
    // comes later — the product is never tied to a single link either way.
    const url = (f.url || '').trim();
    if (url) {
      const r = await api('POST', '/api/quick-add', { ...details, url });
      form.reset();
      OPEN.add('p' + (r.product ? r.product.key : r.listing.productKey));
      load();
      return r.alreadyTracked
        ? 'already watching that listing — the product details were saved'
        : 'added, and watching ' + r.listing.retailer + ' ' + r.listing.externalId;
    }

    const { product } = await api('POST', '/api/products', details);
    form.reset();
    OPEN.add('p' + product.key);   // open it, so the next step is in front of you
    load();
    return 'added — now give it a listing URL below';
  });
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === tab);
    for (const name of ['missions', 'products', 'activity', 'settings']) {
      document.getElementById('tab-' + name).hidden = name !== tab.dataset.tab;
    }
  });
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = fields(form);
  const msg = document.getElementById('settings-msg');
  await withButton(form.querySelector('button[type=submit]'), 'Saving…', msg, async () => {
    const percent = Number(f.taxRatePercent || 0);
    await api('POST', '/api/settings', {
      taxRate: Math.round(percent * 1000) / 100000,
      shippingAllowance: Number(f.shippingAllowance || 0),
    });
    load();
    return 'saved — applies to every mission';
  });
});

document.getElementById('refresh').addEventListener('click', (e) =>
  withButton(e.target, 'Refreshing…', null, load));

// ── Installing, and quick adds ───────────────────────────────────────────────

navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').catch(() => {});

const installBtn = document.getElementById('install');
let installPrompt = null;

// Chrome and Edge fire this when the app is installable. Safari never does, so
// the button below falls back to telling you where the button is on iOS rather
// than pretending it can do it for you.
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = false;
});
addEventListener('appinstalled', () => { installBtn.hidden = true; installPrompt = null; });

// typeof, not a bare reference: one missing global must not take the whole
// page script down with it. Everything below this line is the reason the
// dashboard renders at all.
const standalone =
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
  navigator.standalone === true;
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (iOS && !standalone) installBtn.hidden = false;

installBtn.addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installBtn.hidden = true;
    return;
  }
  // No prompt available: say what to press rather than doing nothing.
  say(document.getElementById('summary'),
    iOS ? 'Share → Add to Home Screen' : 'Use your browser menu → Install',
    true);
});

const quick = document.getElementById('quickadd');
const quickUrl = document.getElementById('quick-url');
const quickMsg = document.getElementById('quick-msg');

function openQuickAdd(url) {
  quick.hidden = false;
  if (url) quickUrl.value = url;
  quickUrl.focus();
}
quick.querySelector('[data-act=quick-close]').addEventListener('click', () => {
  quick.hidden = true;
  history.replaceState(null, '', '/');
});

/**
 * Pull a product link out of whatever the share sheet handed us.
 *
 * Android puts it in "url" from some apps and buried in "text" from others —
 * usually with a title in front of it — so take the first http(s) run of
 * characters from either rather than trusting the field name.
 */
function sharedUrl() {
  const q = new URLSearchParams(location.search);
  const direct = (q.get('url') || '').trim();
  if (/^https?:\\/\\//i.test(direct)) return direct;
  const m = ((q.get('text') || '') + ' ' + (q.get('title') || '')).match(/https?:\\/\\/\\S+/);
  return m ? m[0] : '';
}

document.getElementById('quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await withButton(form.querySelector('button[type=submit]'), 'Adding…', quickMsg, async () => {
    const r = await api('POST', '/api/quick-add', { url: quickUrl.value.trim() });
    form.reset();
    history.replaceState(null, '', '/');
    load();
    return r.alreadyTracked
      ? 'already watching that one — nothing changed'
      : 'watching “' + r.product.name + '” — set a ceiling before arming it';
  });
});

if (location.pathname === '/add' || sharedUrl()) openQuickAdd(sharedUrl());

let timer = setInterval(load, 30000);
document.getElementById('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 30000);
});
load();
</script>
</body></html>`;
}
