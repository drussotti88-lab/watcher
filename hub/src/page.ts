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
import { TYPICAL_PRICE, FLAG_ABOVE } from './msrp.ts';

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
body { margin: 0; color: var(--ink); font: 15px/1.55 var(--sans);
  /* The flat ground, with one quiet pool of the accent bleeding down from the
     top. Costs nothing, and it is most of the difference between "web page"
     and "app". */
  background:
    radial-gradient(1100px 460px at 50% -180px, rgba(127, 119, 221, .16), transparent 60%),
    var(--bg);
}
::selection { background: rgba(127, 119, 221, .35); }
main { max-width: 1040px; margin: 0 auto; padding: 28px 20px 96px; }

header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
/* The mark: the creature's eye from the dnacardvault logo, redrawn as SVG —
   the same drawing the PWA icons are rendered from. */
.mark { width: 34px; height: 34px; border-radius: 10px; flex: none;
        background: #0b0817 url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20512%20512%22%3E%0A%20%20%3Cdefs%3E%0A%20%20%20%20%3CradialGradient%20id%3D%22bg%22%20cx%3D%2250%25%22%20cy%3D%2242%25%22%20r%3D%2275%25%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%231b1230%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%230b0817%22%2F%3E%0A%20%20%20%20%3C%2FradialGradient%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22lidTop%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%23552f8e%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%2255%25%22%20stop-color%3D%22%2343257a%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%232a1650%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%20%20%3CradialGradient%20id%3D%22iris%22%20cx%3D%2242%25%22%20cy%3D%2238%25%22%20r%3D%2270%25%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%23bff3ff%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%2230%25%22%20stop-color%3D%22%235fd7ff%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%2262%25%22%20stop-color%3D%22%232f7ff2%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%231b3fa8%22%2F%3E%0A%20%20%20%20%3C%2FradialGradient%3E%0A%20%20%20%20%3CradialGradient%20id%3D%22glow%22%20cx%3D%2250%25%22%20cy%3D%2250%25%22%20r%3D%2250%25%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%2359c8ff%22%20stop-opacity%3D%22.5%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%2359c8ff%22%20stop-opacity%3D%220%22%2F%3E%0A%20%20%20%20%3C%2FradialGradient%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22dna%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%238fe5ff%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%2255%25%22%20stop-color%3D%22%233f9cf7%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%232f5fe0%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%20%20%3CclipPath%20id%3D%22eyecut%22%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%2028%20252%20C%20100%20158%2C%20250%20134%2C%20372%20178%20L%20494%20272%20C%20420%20352%2C%20288%20384%2C%20178%20358%20C%2098%20338%2C%2048%20302%2C%2028%20252%20Z%22%2F%3E%0A%20%20%20%20%3C%2FclipPath%3E%0A%20%20%3C%2Fdefs%3E%0A%0A%20%20%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22url(%23bg)%22%2F%3E%0A%20%20%3Cg%20transform%3D%22translate(20%2C-34)%20scale(0.92)%22%3E%0A%20%20%3Ccircle%20cx%3D%22240%22%20cy%3D%22268%22%20r%3D%22205%22%20fill%3D%22url(%23glow)%22%2F%3E%0A%0A%20%20%3C!--%20the%20open%20eye%20--%3E%0A%20%20%3Cg%20clip-path%3D%22url(%23eyecut)%22%3E%0A%20%20%20%20%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22%23120b22%22%2F%3E%0A%20%20%20%20%3Ccircle%20cx%3D%22234%22%20cy%3D%22266%22%20r%3D%22122%22%20fill%3D%22url(%23iris)%22%2F%3E%0A%20%20%20%20%3Ccircle%20cx%3D%22234%22%20cy%3D%22266%22%20r%3D%22122%22%20fill%3D%22none%22%20stroke%3D%22%230c1e56%22%20stroke-width%3D%2214%22%20opacity%3D%22.7%22%2F%3E%0A%20%20%20%20%3Cellipse%20cx%3D%22236%22%20cy%3D%22268%22%20rx%3D%2240%22%20ry%3D%2262%22%20fill%3D%22%2305070f%22%20transform%3D%22rotate(-8%20236%20268)%22%2F%3E%0A%20%20%20%20%3Ccircle%20cx%3D%22196%22%20cy%3D%22224%22%20r%3D%2224%22%20fill%3D%22%23eafcff%22%20opacity%3D%22.9%22%2F%3E%0A%20%20%20%20%3Ccircle%20cx%3D%22274%22%20cy%3D%22318%22%20r%3D%2211%22%20fill%3D%22%23bff3ff%22%20opacity%3D%22.5%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%0A%20%20%3C!--%20the%20angular%20brow%2C%20diving%20to%20a%20sharp%20inner%20corner%20like%20the%20logo%20--%3E%0A%20%20%3Cpath%20d%3D%22M%2028%20252%20C%20100%20158%2C%20250%20134%2C%20372%20178%20L%20494%20272%20L%20512%2034%20L%200%2034%20Z%22%20fill%3D%22url(%23lidTop)%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M%2028%20252%20C%20100%20158%2C%20250%20134%2C%20372%20178%20L%20494%20272%22%0A%20%20%20%20%20%20%20%20fill%3D%22none%22%20stroke%3D%22%23e35bd8%22%20stroke-width%3D%2211%22%20stroke-linecap%3D%22round%22%20opacity%3D%22.9%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M%2028%20252%20C%20100%20158%2C%20250%20134%2C%20372%20178%20L%20494%20272%20C%20420%20352%2C%20288%20384%2C%20178%20358%20C%2098%20338%2C%2048%20302%2C%2028%20252%20Z%22%0A%20%20%20%20%20%20%20%20fill%3D%22none%22%20stroke%3D%22%23241143%22%20stroke-width%3D%2210%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%0A%20%20%3C!--%20DNA%2C%20drawn%20as%20geometry%20so%20it%20renders%20identically%20everywhere%20an%20icon%0A%20%20%20%20%20%20%20lives%20-%20no%20font%20can%20go%20missing%20from%20a%20path.%20--%3E%0A%20%20%3Cg%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20fill%3D%22none%22%3E%0A%20%20%20%20%3Cg%20stroke%3D%22%230e1c4e%22%20stroke-width%3D%2238%22%20opacity%3D%22.9%22%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%20122%20382%20L%20122%20472%20M%20122%20382%20L%20152%20382%20C%20200%20382%20200%20472%20152%20472%20L%20122%20472%22%2F%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%20224%20472%20L%20224%20382%20L%20294%20472%20L%20294%20382%22%2F%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%20330%20472%20L%20366%20382%20L%20402%20472%20M%20344%20442%20L%20388%20442%22%2F%3E%0A%20%20%20%20%3C%2Fg%3E%0A%20%20%20%20%3Cg%20stroke%3D%22url(%23dna)%22%20stroke-width%3D%2224%22%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%20122%20382%20L%20122%20472%20M%20122%20382%20L%20152%20382%20C%20200%20382%20200%20472%20152%20472%20L%20122%20472%22%2F%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%20224%20472%20L%20224%20382%20L%20294%20472%20L%20294%20382%22%2F%3E%0A%20%20%20%20%20%20%3Cpath%20d%3D%22M%20330%20472%20L%20366%20382%20L%20402%20472%20M%20344%20442%20L%20388%20442%22%2F%3E%0A%20%20%20%20%3C%2Fg%3E%0A%20%20%3C%2Fg%3E%0A%3C%2Fsvg%3E%0A") center / cover no-repeat;
        box-shadow: 0 4px 14px rgba(127, 119, 221, .4);
        display: inline-flex; vertical-align: -9px; margin-right: 10px; }
h1 { font: 800 26px/1.2 var(--display); margin: 0; letter-spacing: -0.02em; }
h2 { font: 700 12px/1.4 var(--display); text-transform: uppercase; letter-spacing: .1em;
     color: var(--dim); margin: 32px 0 10px;
     display: flex; align-items: center; gap: 12px; }
/* Section headings carry their own hairline, so the page reads as chapters
   instead of one long scroll. */
h2::after { content: ''; flex: 1; height: 1px; background: var(--line); }
h3 { font: 700 14px/1.4 var(--display); margin: 0 0 8px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
a { color: var(--accent); text-underline-offset: 2px; }

/*
 * Tabs wrap rather than run off the edge.
 *
 * Five tabs with their counts are wider than a phone, and the fifth was simply
 * gone — not scrolled, not clipped with an affordance, just off the right-hand
 * side with nothing to say it was there. Horizontal scrolling would hide it
 * just as well for anyone who does not think to swipe a tab strip, so they
 * wrap: two short rows beat one row with a secret.
 */
/*
 * The nav. One element, two shapes: on a phone it is the sticky, blurred,
 * WRAPPING tab bar (five tabs and their counts are wider than a phone, and a
 * tab that is silently off-screen is a tab that does not exist); from 900px
 * up it becomes the side panel, with the brand at the top.
 */
.shell { display: flex; align-items: stretch; min-height: 100vh; }
.shell > main { flex: 1; min-width: 0; }
.tabs { display: flex; flex-wrap: wrap; gap: 2px; align-items: center;
        border-bottom: 1px solid var(--line);
        position: sticky; top: env(safe-area-inset-top, 0px); z-index: 30;
        background: rgba(9, 8, 14, .8);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.shell { flex-direction: column; }
.brand { display: flex; align-items: center; gap: 4px; padding: 8px 10px 8px 14px;
         font: 800 16px/1.2 var(--display); letter-spacing: -0.01em; white-space: nowrap; }
@media (max-width: 520px) {
  .tab { padding: 10px 11px; font-size: 13.5px; }
  .tab .count { margin-left: 4px; }
  .brand-name { display: none; }
}
.tab { padding: 10px 16px; cursor: pointer; border: none; background: none;
       font: 500 14px/1.4 var(--sans); color: var(--muted);
       border-bottom: 2px solid transparent; border-radius: 0;
       transition: color .12s, border-color .12s, background .12s; }
.tab:hover { color: var(--ink); }
.tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.tab .count { font-family: var(--mono); font-size: 12px; opacity: .6; margin-left: 6px; }
@media (min-width: 900px) {
  .shell { flex-direction: row; }
  .tabs { flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 3px;
          width: 218px; flex: none; height: 100vh; top: 0; padding: 16px 12px;
          border-bottom: none; border-right: 1px solid var(--line);
          background: rgba(9, 8, 14, .55); }
  .brand { padding: 6px 8px 18px; font-size: 18px; }
  .tab { display: flex; align-items: center; text-align: left; width: 100%;
         padding: 10px 12px; border-bottom: none; border-radius: 10px; }
  .tab.on { background: var(--accent-soft); border-bottom-color: transparent; }
  .tab .count { margin-left: auto; }
}

.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
/* flex-basis 0, not the card column's 260px: with a 260px floor the spacer
   itself is what pushed Sign out onto a second row on a laptop. */
.bar .grow { flex: 1 1 0; min-width: 0; }
/* On a phone the toolbar was four rows of buttons before any content. The
   spacer goes, and the buttons drop a size — they are chrome, not content. */
@media (max-width: 520px) {
  .bar { gap: 6px; margin-bottom: 14px; }
  .bar .grow { display: none; }
  .bar button, .bar .btn { padding: 7px 11px; font-size: 13px; }
  .bar .check { font-size: 13px; }
}
button, .btn {
  font: 600 14px/1.4 var(--sans); padding: 8px 15px; border-radius: var(--r-ctl);
  cursor: pointer; border: 1px solid var(--line-strong); background: var(--panel-2);
  color: var(--ink); text-decoration: none; display: inline-block;
  transition: border-color .12s, background .12s, opacity .12s, transform .06s;
}
button:hover:not(:disabled), .btn:hover { border-color: var(--accent); background: var(--accent-soft); }
button:active:not(:disabled), .btn:active { transform: translateY(1px); }
button:focus-visible, .btn:focus-visible, .chip:focus-visible, .tab:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: progress; }
button.primary { background: linear-gradient(180deg, #8b84e4, #7269d6);
                 border-color: var(--accent); color: #fff;
                 box-shadow: 0 2px 12px rgba(127, 119, 221, .35); }
button.primary:hover:not(:disabled) { filter: brightness(1.08);
                 background: linear-gradient(180deg, #8b84e4, #7269d6); }
button.danger { color: var(--alert); border-color: rgba(240,131,107,.35); }
button.danger:hover:not(:disabled) { background: var(--alert-bg); border-color: var(--alert); }
button.small { padding: 4px 10px; font-size: 12px; border-radius: var(--r-sm); box-shadow: none; }

/* The filter bar.
   Ninety-eight finds is a wall, and the answer is not to throw any of them
   away — Walmart publishes no date to judge age by, so a filter that hid the
   old would hide real ones too. It is to let you narrow, and to say what you
   are looking at. */
.filters { display: grid; gap: 9px; margin-bottom: 14px; }
.filters input[type=search] { width: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chipgroups { display: grid; gap: 6px; }
/* The shop switcher: the chips, promoted. Same behaviour, tab-sized targets,
   because "which shop am I looking at" is the first question on these pages. */
/* List/grid switcher, and the grid it switches to. The grid restyles the
   SAME cards CSS-only: image on top, facts under it, actions at the foot —
   nothing about what a card says changes with how it is laid out. */
.listtools { display: flex; justify-content: flex-end; margin: 0 0 10px; }
.vt { display: flex; gap: 4px; }
.vt button { font-size: 15px; line-height: 1; padding: 6px 10px; border-radius: var(--r-sm);
             border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
             cursor: pointer; }
.vt button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent);
                                  color: var(--accent); }
.seg { gap: 8px; }
.seg .chip { padding: 9px 18px; min-height: 36px; font-size: 13px;
             border-radius: 10px; }
.chip {
  font: 500 12px/1 var(--sans); letter-spacing: .01em;
  padding: 7px 12px; border-radius: 999px; cursor: pointer;
  background: var(--panel-2); border: 1px solid var(--line); color: var(--muted);
  white-space: nowrap; min-height: 28px;
  transition: border-color .12s, color .12s, background .12s;
}
.chip:hover { border-color: var(--accent); color: var(--ink); }
.chip[aria-pressed="true"] {
  background: var(--accent-soft); border-color: var(--accent); color: var(--accent);
  font-weight: 600;
}
.chip .n { opacity: .6; margin-left: 5px; font-variant-numeric: tabular-nums; }
.chip:disabled { opacity: .35; cursor: default; }
.chip:disabled:hover { border-color: var(--line); color: var(--muted); }

.card { border: 1px solid var(--line);
        border-radius: var(--r-card); padding: 16px 18px; margin-bottom: 12px;
        box-shadow: var(--shadow);
        /* A one-per-cent sheen across the top edge. Imperceptible on its own;
           the difference between a panel and a printout in aggregate. */
        background: linear-gradient(180deg, rgba(237, 235, 245, .03), rgba(237, 235, 245, 0) 46%),
                    var(--panel); }
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
.fresh { background: var(--accent); color: #fff; }
/* The grid restyles the same cards; it lives below the rules it overrides so
   the pinned .pill/.right definitions stay the first (and canonical) ones. */
.gridded { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
           gap: 12px; align-items: start; }
.gridded .card { margin-bottom: 0; }
.gridded .row { display: block; }
.gridded .thumb, .gridded .thumb.lg { width: 100%; height: 150px; margin-bottom: 10px; }
.gridded .right { text-align: left; min-width: 0; margin-top: 8px; }
.gridded .empty, .gridded > .card.foldnote { grid-column: 1 / -1; }
/* A pill that is wider than its grid column trims itself rather than
   escaping the card. */
.gridded .pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; display: inline-block; line-height: 22px; }
/* The release radar: a compact calendar of what drops when. */
.radar { margin-bottom: 14px; }
.radar h3 { margin: 12px 0 2px; font-size: 12px; letter-spacing: .08em;
            text-transform: uppercase; color: var(--muted);
            display: flex; align-items: center; gap: 10px; }
.radar h3::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.radar h3.today { color: var(--accent); }
.radar .rrow { display: flex; gap: 8px; align-items: baseline; padding: 6px 0;
               border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.radar .rrow:last-child { border-bottom: 0; }
.radar .rrow a { text-decoration: none; font-weight: 600; color: var(--ink); }
.radar .rrow a:hover { color: var(--accent); text-decoration: underline; }
.radar .rgroup { margin-bottom: 8px; }
.stale { color: var(--alert); font-weight: 600; }
/* The "why you are seeing this" line. Quieter than the facts above it, because
   it explains rather than informs. */
.meta.dim { color: var(--dim); margin-top: 6px; }

.thumb { width: 60px; height: 60px; border-radius: var(--r-ctl); object-fit: contain;
         background: var(--panel-2); border: 1px solid var(--line); flex: 0 0 auto; }
.thumb.ph { display: flex; align-items: center; justify-content: center;
            color: var(--dim); font-size: 20px; }
/* Refused by the retailer, as opposed to never fetched. Different problem. */
.thumb.broken { color: var(--warn); border-color: var(--warn); }
.thumb.lg { width: 88px; height: 88px; }

form.stack { display: grid; gap: 11px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 11px; }
label.f { display: grid; gap: 4px; font-size: 12px; color: var(--muted);
          font-weight: 500; letter-spacing: .01em; }
label.f .hint { font-weight: 400; color: var(--dim); }
label.check { display: flex; gap: 8px; align-items: center; font-size: 14px;
              color: var(--ink); cursor: pointer; }
input[type=text], input[type=url], input[type=number], input[type=date],
input[type=search], select, textarea, input[type=password] {
  font: 400 14px/1.5 var(--sans); padding: 9px 12px; border-radius: var(--r-ctl); width: 100%;
  border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink);
  -webkit-appearance: none; appearance: none;
  transition: border-color .12s, box-shadow .12s;
}
input::placeholder, textarea::placeholder { color: var(--dim); }
input:hover:not(:focus), select:hover:not(:focus), textarea:hover:not(:focus) {
  border-color: rgba(237, 235, 245, .2); }
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

/*
 * Below 640px a five-column table becomes one word per line — the product name
 * wrapping down the screen while "when" and "outcome" sit in slivers beside it.
 * Each row becomes a block instead, with the headers hidden and the labels
 * carried on the cells themselves.
 */
@media (max-width: 640px) {
  table, tbody, tr, td { display: block; width: 100%; }
  table th { display: none; }
  tr { border-top: 1px solid var(--line); padding: 10px 0; }
  tr:first-child { border-top: none; }
  td { border: none; padding: 1px 0; text-align: left !important; }
  td[data-label]::before {
    content: attr(data-label) ' ';
    color: var(--dim); text-transform: uppercase;
    font: 600 10.5px/1.4 var(--sans); letter-spacing: .09em;
  }
  td.nowrap { white-space: normal; }
}
td, th { padding: 8px; border-top: 1px solid var(--line); vertical-align: top; text-align: left; }
/* Only where a pointer exists — on touch this paints rows on scroll. */
@media (hover: hover) and (min-width: 641px) {
  tr:hover td { background: rgba(237, 235, 245, .025); }
}
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
/* Whose dashboard this is. Small and quiet, but always present: the browser
   door used to hand every visitor the owner's account, and the fix is only
   trustworthy if you can see which one you are in. */
.who { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
       color: var(--muted); border: 1px solid var(--line); border-radius: 999px;
       padding: 2px 8px; vertical-align: middle; margin-left: 8px; }
.who:empty { display: none; }

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
.quickadd h2::after { display: none; }
#install { flex: none; }

/* The three warnings that outrank every tab: money committed, a queue up, and
   everything paused. One shape — a stripe down the left edge in the colour of
   how bad it is — instead of three hand-rolled tints. */
.banner { border-left: 4px solid var(--alert); }
.banner.warn { border-left-color: var(--warn);
               border-color: rgba(240, 197, 107, .35); border-left: 4px solid var(--warn);
               background: linear-gradient(180deg, rgba(237,235,245,.02), transparent 46%),
                           rgba(224, 176, 96, .07); }
.banner.alert { border-color: rgba(240, 131, 107, .4); border-left: 4px solid var(--alert);
                background: linear-gradient(180deg, rgba(237,235,245,.02), transparent 46%),
                            rgba(240, 131, 107, .09); }

/* A thin dark scrollbar; the stock one is a grey slab on this ground. */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(237, 235, 245, .14); border-radius: 5px;
                            border: 2px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background: rgba(237, 235, 245, .22); }
::-webkit-scrollbar-track { background: transparent; }

/* Room for the notch and the home indicator once it is installed. */
body { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
main { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }

dialog {
  border: none; background: transparent; padding: 0; color: var(--ink);
  max-width: 560px; width: calc(100% - 28px);
}
dialog::backdrop { background: rgba(4, 3, 8, .72); }
dialog .card { margin: 0; max-height: 86vh; overflow-y: auto; }
/* The detail pop-up carries run tables, so it earns more width. */
#detail-dialog { max-width: 720px; }
.dlg-head { display: flex; justify-content: space-between; align-items: center;
            gap: 12px; margin-bottom: 6px; }
.dlg-head h3 { margin: 0; }

.login { max-width: 350px; margin: 15vh auto; }
.login .card { padding: 26px 24px; }
.err { color: var(--alert); font-size: 13px; min-height: 20px; }
`;

export function loginPage(message = '', handle = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault Watch</title>${FONTS}<style>${STYLE}</style></head>
<body><main class="login">
  <div class="card">
    <h1><span class="mark"></span>Vault Watch</h1>
    <p class="sub" style="margin:6px 0 0">Sign in to see what you're watching.</p>
    <form method="POST" action="/login" style="margin-top:20px" class="stack">
      <!-- Blank name means the owner and the deployment password, which is how
           this page worked before there were accounts and how it still works
           for Roberto. Everyone else types the name they were given. -->
      <input type="text" name="handle" placeholder="Name (leave blank if it's yours)"
             value="${esc(handle)}" autocomplete="username" autocapitalize="off"
             autocorrect="off" spellcheck="false">
      <input type="password" name="password" placeholder="Password" required
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
<title>Vault Watch</title>
<link rel="manifest" href="/manifest.webmanifest?v=3">
<meta name="theme-color" content="#09080e">
<link rel="icon" href="/icon-192.png?v=3" sizes="192x192" type="image/png">
<!-- iOS ignores the manifest for the home-screen icon and the status bar. -->
<!-- The version tag is load-bearing: the icons are served immutable, so a
     new drawing under the old URL is a new drawing nobody's phone will ever
     fetch. Bump ?v= whenever the art changes. -->
<link rel="apple-touch-icon" href="/icon-192.png?v=3">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Vault Watch">
${FONTS}<style>${STYLE}</style></head>
<body><div class="shell">
  <nav class="tabs" aria-label="Sections">
    <div class="brand"><span class="mark"></span><span class="brand-name">Vault Watch</span></div>
    <button class="tab on" data-tab="missions">Missions<span class="count" id="c-missions"></span></button>
    <button class="tab" data-tab="products">Products<span class="count" id="c-products"></span></button>
    <button class="tab" data-tab="activity">Activity<span class="count" id="c-activity"></span></button>
    <button class="tab" data-tab="finds">Finds<span class="count" id="c-finds"></span></button>
    <button class="tab" data-tab="settings">Settings</button>
  </nav>
<main>
  <header>
    <div>
      <span class="sub" id="summary">loading…</span> <span class="who" id="who"></span>
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

  <!-- A live grant is money committed: a buy in progress, or a Watcher that
       died mid-checkout. Both deserve the top of the page. Releasing is the
       recovery path for the second one — after a look at the orders page,
       because a grant nobody resolved means nobody knows whether money moved. -->
  <div class="card banner warn" id="money-banner" hidden>
    <div class="name">Money is committed</div>
    <div class="meta" id="money-banner-detail"></div>
    <div id="money-banner-list"></div>
  </div>

  <div class="card banner alert" id="paused-banner" hidden>
    <div class="name">Everything is paused</div>
    <div class="meta">
      The Watcher is looking at nothing. Turn it back on under Settings → When to watch.
    </div>
  </div>

  <div class="card banner alert" id="queue-banner" hidden></div>


  <div class="bar">
    <button id="add-open" class="primary">Add product</button>
    <button id="sweep-now">Run catalogue sweep</button>
    <button id="watcher-toggle">Turn watcher off</button>
    <button id="refresh">Refresh</button>
    <label class="check sub"><input type="checkbox" id="auto" checked> auto every 30s</label>
    <span class="grow"></span>
    <a class="btn" href="/logout">Sign out</a>
  </div>

  <section id="tab-missions">
  <div class="listtools"><div class="vt" data-list="missions"><button type="button" data-view="list" title="List view">☰</button><button type="button" data-view="grid" title="Grid view">▦</button></div></div>
    <div class="filters" id="flt-missions" hidden>
      <input type="search" id="flt-missions-q" placeholder="Search missions"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="chipgroups" id="flt-missions-chips"></div>
      <div class="sub" id="flt-missions-count"></div>
    </div>
    <div id="missions"></div>
  </section>

  <section id="tab-products" hidden>
  <div class="listtools"><div class="vt" data-list="products"><button type="button" data-view="list" title="List view">☰</button><button type="button" data-view="grid" title="Grid view">▦</button></div></div>
    <div class="filters" id="flt-products" hidden>
      <div class="chips seg" id="flt-products-shops"></div>
      <input type="search" id="flt-products-q" placeholder="Search products"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="sub" id="flt-products-count"></div>
    </div>
    <div id="products"></div>
  </section>

  <section id="tab-activity" hidden>
    <div class="filters" id="flt-activity" hidden>
      <input type="search" id="flt-activity-q" placeholder="Search runs and changes"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="chipgroups" id="flt-activity-chips"></div>
      <div class="sub" id="flt-activity-count"></div>
    </div>
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

  <section id="tab-finds" hidden>
    <h2 style="margin-top:0">What the sweep turned up</h2>
    <p class="sub" style="margin:-6px 0 14px">
      A sweep proposes; you decide. <strong>Keep</strong> starts watching it —
      a product, a listing, and a mission with eyes on the page. It does not
      arm anything, and it never will: a machine's guess and a decision about
      money are two different things.
      <strong>Forget</strong> means never offer this again, and is remembered,
      so the next sweep will not re-suggest it.
    </p>
    <div class="card radar" id="release-radar" hidden></div>
  <div class="listtools"><div class="vt" data-list="finds"><button type="button" data-view="list" title="List view">☰</button><button type="button" data-view="grid" title="Grid view">▦</button></div></div>
    <div class="filters" id="finds-filters">
      <div class="chips seg" id="find-shops"></div>
      <input type="search" id="find-q" placeholder="Search these finds"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="chips" id="find-states"></div>
      <div class="sub" id="find-count"></div>
    </div>
    <div id="finds-list"></div>
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
          <label class="f">Most to spend in 24 hours
            <span class="hint">in dollars — nothing can be armed without this</span>
            <input type="number" name="spendCapDay" step="0.01" min="0" placeholder="unset">
          </label>
          <label class="f">Sweep for new products every
            <span class="hint">hours — how often the catalogues are re-read</span>
            <input type="number" name="sweepEveryHours" step="1" min="1" placeholder="24">
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

    <h2>When to watch</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Target runs its scheduled drops in the small hours, so polling all
      afternoon is traffic spent on a page that will not change — and traffic is
      the one thing that earns a challenge, which would take the Watcher off the
      air at three in the morning when it matters. Leave both blank to watch
      around the clock.
    </p>
    <div class="card">
      <form class="stack" id="hours-form">
        <label class="f" style="flex-direction:row; align-items:center; gap:9px">
          <input type="checkbox" name="paused" style="width:auto; margin:0">
          <span>Pause everything</span>
        </label>
        <p class="sub" style="margin:-6px 0 4px">
          The master switch. Stops all watching without unpicking a single
          mission, which is the honest way to switch a system off.
        </p>
        <div class="grid2">
          <label class="f">Watch from
            <span class="hint">24-hour, e.g. 02:30</span>
            <input type="text" name="activeFrom" placeholder="" maxlength="5">
          </label>
          <label class="f">Until
            <span class="hint">a window may cross midnight</span>
            <input type="text" name="activeUntil" placeholder="" maxlength="5">
          </label>
        </div>
        <label class="f">Timezone
          <span class="hint">e.g. America/Chicago — blank uses the Watcher's own clock</span>
          <input type="text" name="timezone" placeholder="">
        </label>
        <p class="sub" style="margin:0">
          Two things always wake it regardless: pressing <strong>Check now</strong>
          on a card, and a product whose release date is today. A quiet-hours
          rule that swallowed either would make the button a liar.
        </p>
        <div class="actions">
          <button type="submit" class="primary">Save hours</button>
          <span class="msg" id="hours-msg"></span>
        </div>
      </form>
    </div>

    <h2>Diagnostics</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Every check the Watcher makes is written down — the ones that worked as
      well as the ones that did not, because a failure only means something
      next to the checks around it. This is how "it's failing a lot" turns
      into which retailer, how often, and with what error.
    </p>
    <div class="card">
      <div class="grid2">
        <label class="f">How much history
          <span class="hint">seven days is all that is kept</span>
          <select id="diag-hours">
            <option value="6">the last 6 hours</option>
            <option value="24" selected>the last 24 hours</option>
            <option value="72">the last 3 days</option>
            <option value="168">everything kept (7 days)</option>
          </select>
        </label>
      </div>
      <div class="actions">
        <button class="primary" id="diag-download">Download activity log</button>
        <span class="msg" id="diag-msg"></span>
      </div>
      <p class="sub" style="margin:0">
        <strong>In it:</strong> what was checked, when, what the page said, how
        long it took, and every error in full.
        <strong>Not in it:</strong> your token, your password, your address or
        postcode, your email, your account name, or the visitor id Target puts
        in its URLs — those are taken out on your own machine before the line is
        written down, and taken out again here on the way out. Nothing leaves
        until you press the button.
      </p>
    </div>
  </section>
  <dialog id="add-dialog">
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
      <div class="actions" style="margin-top:2px">
        <button type="button" class="small" data-act="add-close">Cancel</button>
      </div>
    </div>
  </dialog>

  <!-- One pop-up serves every card's details and edit forms. Its content is
       rebuilt from fresh data on each refresh, unless a hand is in a form. -->
  <dialog id="detail-dialog">
    <div class="card">
      <div class="dlg-head">
        <h3 id="detail-title"></h3>
        <button type="button" class="small" data-act="detail-close">Close</button>
      </div>
      <div id="detail-body"></div>
    </div>
  </dialog>
</main>
</div>
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

/**
 * Days until this drops, or null when that is not a question worth asking.
 *
 * Null for no date, and null once the date has passed — a countdown that has
 * gone negative is worse than no countdown, because it still looks like news.
 *
 * Deliberately regex-free: split on the dashes and check the parts. See the
 * backslash trap at the top of this file — a date-matching regex is exactly
 * the shape that arrives here mangled and still parses. Writing this comment
 * is in fact how it caught me for the fifth time, since the escaped regex I
 * put in the prose was eaten the same way the real one would have been.
 */
function dropsIn(m) {
  if (!m.releaseDate || m.state === 'in') return null;
  const parts = String(m.releaseDate).slice(0, 10).split('-');
  if (parts.length !== 3) return null;
  const at = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (!isFinite(at)) return null;
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((at - midnight) / 86400000);
  return days >= 0 && days <= 120 ? days : null;
}

/**
 * Has the last check failed to read the page?
 *
 * State and confidence both unknown, on a mission that has actually been
 * checked, means the Watcher looked and came back with nothing. That is a
 * different thing from "out of stock" and a different thing from "not looked
 * at yet", and the card has to say so rather than shrugging twice.
 */
function notReading(m) {
  return !!m.lastCheckedAt && m.state === 'unknown' && m.confidence === 'unknown';
}

/**
 * The name, minus the part every product here shares.
 *
 * Everything in this system is Pokémon TCG, so leading with it on every row
 * spends the first third of the line saying nothing. The stored name keeps the
 * prefix — this is a display choice, and the Products tab shows the real one.
 */
function shortName(name) {
  // No regex, deliberately. Every backslash in this file has to survive the
  // template literal, and getting that wrong has already cost four bugs. Plain
  // string work cannot be mangled on the way to the browser.
  const full = String(name || '').trim();
  const lower = full.toLowerCase();
  const prefixes = [
    'pok 233 mon trading card game',
    'pokémon trading card game',
    'pokemon trading card game',
    'pok 233 mon tcg',
    'pokémon tcg',
    'pokemon tcg',
    'pok 233 mon',
    'pokémon',
    'pokemon',
  ];
  let out = full;
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) { out = full.slice(prefix.length); break; }
  }
  while (out && ':\u2014\u2013- '.indexOf(out[0]) >= 0) out = out.slice(1);
  return out.trim() || full;
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
  // A dead CDN URL should degrade to a placeholder, not a broken-image icon.
  // But a *distinguishable* one: "the retailer refused the picture" and "we
  // never had one" look identical otherwise, and only one of them is a bug.
  img.addEventListener('error', () => {
    const ph = el('div', cls + ' ph broken', '⊘');
    ph.title = 'the retailer would not serve this image to the app';
    img.replaceWith(ph);
  });
  return img;
}

/**
 * The detail pop-up: one dialog serves every card.
 *
 * Replaced the expand/collapse panels (Roberto's call — pop-ups read better
 * than cards that grow). Module state rather than DOM state so the
 * thirty-second refresh REFILLS the open dialog instead of closing it —
 * and skips the refill entirely while a hand is inside a form, because a
 * redraw under a cursor eats keystrokes.
 */
let DETAIL = null;

function openDetail(kind, key) {
  DETAIL = { kind: kind, key: key };
  renderDetail(true);
  const d = document.getElementById('detail-dialog');
  if (d.showModal) { if (!d.open) d.showModal(); }
  else d.open = true;
}

function closeDetail() {
  DETAIL = null;
  const d = document.getElementById('detail-dialog');
  if (d.close) d.close();
  else d.open = false;
}

function renderDetail(force) {
  if (!DETAIL) return;
  const d = document.getElementById('detail-dialog');
  if (!force && d.contains(document.activeElement)) return;
  // The run history is a snapshot: it fetches once when opened, and the
  // thirty-second refresh leaves it be. Everything else refills from DATA.
  if (!force && DETAIL.kind === 'mission-runs') return;
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');
  if (DETAIL.kind === 'mission-runs') {
    const m = DATA.missions.find((x) => x.id === DETAIL.key);
    if (!m) { closeDetail(); return; }
    title.textContent = shortName(m.productName) + ' — runs';
    body.textContent = '';
    body.appendChild(missionRunsPanel(m));
  } else if (DETAIL.kind === 'mission') {
    const m = DATA.missions.find((x) => x.id === DETAIL.key);
    // The thing this pop-up was about can vanish under it — deleted from
    // another device, say. A dialog about nothing closes rather than lying.
    if (!m) { closeDetail(); return; }
    title.textContent = shortName(m.productName);
    body.textContent = '';
    body.appendChild(missionPanel(m));
  } else {
    const p = DATA.products.find((x) => x.key === DETAIL.key);
    if (!p) { closeDetail(); return; }
    const mine = (DATA.listings || []).filter((l) => l.productKey === p.key);
    title.textContent = p.name;
    body.textContent = '';
    body.appendChild(productPanel(p, mine));
  }
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
  const nameEl = el('div', 'name', shortName(m.productName));
  nameEl.title = m.productName;
  left.appendChild(nameEl);

  const where = el('div', 'meta');
  where.append(m.retailer + ' · ');
  where.appendChild(el('span', 'mono', m.externalId || '—'));
  where.append(' · ');
  const a = el('a', null, 'open page');
  a.href = m.url; a.target = '_blank'; a.rel = 'noreferrer';
  where.appendChild(a);
  left.appendChild(where);

  const flags = el('div', 'tags');

  // ── What the pills are for ────────────────────────────────────────────────
  //
  // Three questions, in the order a person asks them: is it in stock, would it
  // buy, and can I trust what I am looking at. A pill that answers none of
  // those is noise.
  //
  // This used to render UNKNOWN and UNKNOWN READ side by side for a mission
  // whose checks were failing — the same fact twice, in the colour that means
  // "hmm", while the actual news was that nothing had been read for hours.
  if (notReading(m)) {
    flags.appendChild(el('span', 'pill flag', 'not reading'));
  } else {
    const label = m.state === 'in' ? 'IN STOCK'
      : m.state === 'out' ? 'out of stock'
      : m.state === 'unchecked' ? 'never checked' : m.state;
    // A pre-order is orderable, not in stock, and those call for different
    // decisions — one is a race, the other is a queue. Saying IN STOCK on a
    // box that ships in November is the single most misleading thing this
    // card could say.
    if (m.isPreOrder && m.state === 'in') {
      flags.appendChild(el('span', 'pill s-queue', 'PRE-ORDER'));
    } else {
      flags.appendChild(el('span', 'pill s-' + m.state, label));
    }
  }

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
  // Only 'inferred' is worth a pill. 'exact' is the norm and needs no badge,
  // and 'unknown' is already said by the state above.
  if (m.confidence === 'inferred' && !notReading(m)) {
    flags.appendChild(el('span', 'pill s-unknown', 'inferred read'));
  }
  if (m.isPreOrder && m.releaseDate) {
    flags.appendChild(el('span', 'pill info', 'ships ' + m.releaseDate));
  }
  // What an armed mission would actually do about it. Worth saying on the card
  // rather than only inside the settings panel, because it decides whether
  // money moves.
  if (m.isPreOrder && m.armed) {
    flags.appendChild(el('span', 'pill ' + (m.preOrderPolicy === 'allow' ? 'flag' : 'info'),
      m.preOrderPolicy === 'allow' ? 'will buy pre-orders' : 'stock only — will not buy'));
  }
  // The one thing on this card that looks forwards.
  //
  // Target publishes an on-sale date weeks ahead, on an item that is plainly
  // out of stock. Nothing else here answers "is this about to happen" — the
  // stock count cannot, it is zero until the moment it is not — so a bare OUT
  // OF STOCK pill on something dropping on Tuesday reads exactly like one on
  // something that sold out in March.
  const drop = dropsIn(m);
  if (drop !== null) {
    flags.appendChild(el('span', 'pill flag',
      drop === 0 ? 'DROPS TODAY' :
      drop === 1 ? 'drops tomorrow' :
      'drops in ' + drop + ' days · ' + m.releaseDate));
  }
  if (m.note) {
    const note = el('div', 'meta', m.note);
    note.style.marginTop = '6px';
    left.appendChild(note);
  }

  // "Check now" belongs on the card. Buried inside the settings panel it was
  // three clicks away from the thing it acts on.
  const actions = el('div', 'actions');
  actions.style.marginTop = '10px';
  if (m.enabled) {
    const now = el('button', 'small', m.checkNow ? 'check queued' : 'Check now');
    now.disabled = !!m.checkNow;
    now.addEventListener('click', async (e) => {
      const ok = await withButton(e.target, 'Queueing…', null, async () => {
        await api('POST', '/api/missions/' + m.id + '/check-now');
        return 'queued — the Watcher will check this on its next pass';
      });
      if (ok) { e.target.textContent = 'check queued'; e.target.disabled = true; }
    });
    actions.appendChild(now);
  }

  if (actions.childNodes.length) left.appendChild(actions);

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
  // How many the retailer says it can ship. Target states a real number in its
  // fulfillment API; Pokémon Center and Walmart do not.
  //
  // Zero is shown, deliberately. It was hidden for an afternoon as "the same
  // fact as OUT OF STOCK", and that was wrong: "0 available" is evidence the
  // count was actually read, and a listing where we read zero is not the same
  // as one where the retailer never said. Absence is the only thing that means
  // nothing was stated, so absence has to be reserved for it.
  //
  // ── Why the number sometimes wears a plus ────────────────────────────────
  //
  // Target's available_to_promise_quantity is a real figure below a ceiling and
  // a ceiling above it. Across every reading taken so far the values are 0, 8,
  // 9, 10, 14, 18 and 20 — never anything above 20, and 10 and 20 recur far
  // too often to be coincidence. So "20" means *at least* twenty and possibly
  // a pallet, while "9" means nine.
  //
  // Which makes it precise exactly when it matters: as a drop is eaten the
  // number falls under the ceiling and starts telling the truth.
  if (m.availableQuantity !== null && m.availableQuantity !== undefined) {
    const q = m.availableQuantity;
    // The plus carries the whole meaning. A sentence underneath explaining
    // that "10+" means at least ten is the interface apologising for itself.
    const capped = q === 10 || q === 20;
    right.appendChild(el('div', 'meta', capped ? q + '+ available' : q + ' available'));
  }
  // The number you can actually walk away with, which is not the one above.
  // A limit of 2 against 10 available is two, and burying that in the note
  // line while the headline says 10 is the wrong way round.
  if (m.orderLimit !== null && m.orderLimit !== undefined && m.orderLimit > 0) {
    right.appendChild(el('div', 'meta', 'limit ' + m.orderLimit + ' per order'));
  }

  row.append(left, right);
  card.appendChild(row);
  // Tags go below the whole row, full width. Nested inside the title column
  // they were competing with the price for space and wrapping at odd points.
  card.appendChild(flags);
  // Two buttons, two questions: "change how this is watched" and "what has
  // it done". Bundled they made every look at the history walk past the
  // spending controls.
  const settingsBtn = el('button', 'small', 'Settings');
  settingsBtn.addEventListener('click', () => openDetail('mission', m.id));
  const runsBtn = el('button', 'small', 'Run history');
  runsBtn.addEventListener('click', () => openDetail('mission-runs', m.id));
  const acts = el('div', 'actions');
  acts.style.marginTop = '12px';
  acts.append(settingsBtn, runsBtn);
  card.appendChild(acts);
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
      <label class="f">Pre-orders
        <span class="hint">orderable now, ships on release day</span>
        <select name="preOrderPolicy">
          <option value="skip">Skip — buy stock only</option>
          <option value="allow">Buy pre-orders too</option>
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
  q('preOrderPolicy').value = m.preOrderPolicy || 'skip';
  q('enabled').checked = m.enabled;
  q('armed').checked = m.armed;
  const msg = form.querySelector('.msg');

  // Say what arming means before it is saved, not after.
  const armed = q('armed');
  const warn = el('div', 'msg');
  armed.addEventListener('change', () => {
    const noCap = !(DATA.settings && DATA.settings.spendCapDay);
    if (armed.checked && noCap) {
      armed.checked = false;
      warn.textContent = 'set a daily spend cap in Settings first — ' +
        'the cap is what bounds a night, and nothing arms without one';
      return;
    }
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
          preOrderPolicy: f.preOrderPolicy,
          checkEverySeconds: Number(f.checkEverySeconds),
        });
        load();
        // Saving is the end of the errand; the pop-up closing is the ack.
        closeDetail();
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
      closeDetail();
      return 'deleted';
    });
  });

  wrap.appendChild(form);
  return wrap;
}

/**
 * The run history, in its own pop-up. Fetched on open rather than behind a
 * second "load" click — pressing the Run history button already said what
 * you wanted. A snapshot on purpose: renderDetail leaves it alone on the
 * thirty-second refresh, because a history that rewrites itself under your
 * eyes reads as a glitch, and Close/reopen is the natural "refresh".
 */
function missionRunsPanel(m) {
  const wrap = el('div');
  wrap.style.marginTop = '10px';
  wrap.appendChild(el('div', 'meta', 'Loading…'));
  api('GET', '/api/missions/' + m.id + '/runs')
    .then((data) => {
      wrap.textContent = '';
      wrap.appendChild(runTable(data.runs, 'This mission has not run yet.', m.lastCheckedAt));
    })
    .catch((err) => {
      wrap.textContent = '';
      wrap.appendChild(el('div', 'msg bad', err.message));
    });
  return wrap;
}

/**
 * Has anything succeeded since the newest recorded problem?
 *
 * Runs are only written when a mission acted or could not, so a routine check
 * that found nothing leaves no trace. That is right — it keeps the four rows
 * that matter out of ten thousand that don't — but it has a cost: after an
 * outage the log is nothing but failures, for ever, and a system that
 * recovered an hour ago still reads as broken.
 *
 * A check newer than the newest failure is the proof that it isn't.
 */
function recoveredSince(runs, lastCheckedAt) {
  if (!runs.length || !lastCheckedAt) return null;
  const newestBad = runs.find((r) => r.outcome === 'failed' || r.outcome === 'blocked');
  if (!newestBad) return null;
  const checked = new Date(lastCheckedAt).getTime();
  const failed = new Date(newestBad.startedAt).getTime();
  return checked > failed ? { failed: newestBad.startedAt, checked: lastCheckedAt } : null;
}

function runTable(runs, emptyText, lastCheckedAt) {
  if (!runs.length) return el('div', 'meta', emptyText);

  const wrap = el('div');
  const good = recoveredSince(runs, lastCheckedAt);
  if (good) {
    const note = el('div', 'msg good');
    note.style.marginBottom = '8px';
    note.textContent =
      'Checked successfully ' + ago(good.checked) + ' — nothing has failed since ' +
      ago(good.failed) + '. Routine checks that find nothing are not recorded, ' +
      'so the newest rows below are older than they look.';
    wrap.appendChild(note);
  }
  const table = el('table');
  const head = el('tr');
  for (const h of ['When', 'Product', 'Outcome', 'Reason', '']) head.appendChild(el('th', null, h));
  const body = el('tbody');
  body.appendChild(head);
  for (const r of runs) {
    const tr = el('tr');
    const when = el('td', 'meta nowrap', ago(r.startedAt));
    when.dataset.label = 'when';
    tr.appendChild(when);

    const what = el('td', null, shortName(r.productName));
    what.title = r.productName;
    tr.appendChild(what);

    const outcome = el('td', 'o-' + r.outcome + ' nowrap', r.outcome.replace('_', ' '));
    outcome.dataset.label = 'outcome';
    tr.appendChild(outcome);

    // Every non-success carries a reason. Showing it is the point of recording it.
    const why = el('td', 'meta', r.reason || '');
    why.dataset.label = 'why';
    tr.appendChild(why);
    const right = el('td', 'meta nowrap mono',
      [r.price !== null ? money(r.price) : '', r.ms !== null ? r.ms + 'ms' : '']
        .filter(Boolean).join(' · '));
    right.style.textAlign = 'right';
    tr.appendChild(right);
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
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
  const more = el('button', 'small', 'Listings & details');
  more.addEventListener('click', () => openDetail('product', p.key));
  const acts = el('div', 'actions');
  acts.style.marginTop = '12px';
  acts.appendChild(more);
  card.appendChild(acts);
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
      closeDetail();
      return 'saved';
    });
  });

  edit.querySelector('[data-act=delete-product]').addEventListener('click', async (e) => {
    if (!confirm('Delete "' + p.name + '"?\\n\\nEvery listing, mission and run for it goes too.')) return;
    await withButton(e.target, 'Deleting…', editMsg, async () => {
      await api('DELETE', '/api/products/' + encodeURIComponent(p.key));
      load();
      closeDetail();
      return 'deleted';
    });
  });
  wrap.appendChild(edit);
  return wrap;
}

/* ── rendering ──────────────────────────────────────────────────────────── */

/* ── filters for the other lists ──────────────────────────────────────────
 *
 * Same shape as the finds filter below, for the same reasons: the search
 * boxes are static in the markup (the page redraws every thirty seconds,
 * and a rebuilt input steals your cursor mid-word), only chips and lists
 * are redrawn, and the state is module-level — a hard refresh clears it,
 * which is the right amount of memory for something set while looking at
 * a list. One bar per tab; the activity bar covers runs and changes both.
 */
/**
 * The remembered shop pick, one per page.
 *
 * The only filter that survives a hard refresh, on purpose: "I mostly look at
 * Target here" is a fact about the person, not about today's list, so it is
 * the one worth keeping. Everything else stays module state and dies with the
 * tab, which is the right lifetime for a narrowing set mid-look. try/catch
 * because storage can be absent or refused, and a filter must never be the
 * reason the page did not render.
 */
function savedShop(key) {
  try { return localStorage.getItem('shop:' + key) || ''; } catch (e) { return ''; }
}
function saveShop(key, value) {
  try { localStorage.setItem('shop:' + key, value); } catch (e) { /* fine */ }
}

/**
 * List or grid, per page, remembered like the shop pick: how you like to look
 * at a list is a fact about you, not about today's list.
 */
function savedView(key) {
  try { return localStorage.getItem('view:' + key) === 'grid' ? 'grid' : 'list'; }
  catch (e) { return 'list'; }
}
const VIEWS = {
  missions: savedView('missions'),
  products: savedView('products'),
  finds: savedView('finds'),
};
function applyViews() {
  const hosts = { missions: 'missions', products: 'products', finds: 'finds-list' };
  for (const key in hosts) {
    const host = document.getElementById(hosts[key]);
    if (host) host.classList.toggle('gridded', VIEWS[key] === 'grid');
  }
  for (const box of document.querySelectorAll('.vt')) {
    for (const b of box.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', VIEWS[box.dataset.list] === b.dataset.view ? 'true' : 'false');
    }
  }
}

const LIST_FILTERS = {
  missions: { q: '', shop: '', status: '', mode: '' },
  products: { q: '', shop: savedShop('products') },
  activity: { q: '', shop: '', outcome: '' },
};

/** Below this many rows a filter bar is clutter, not help. */
const FILTER_FROM = 6;

/** Every word, in any order. Typing two words should narrow, not fail. */
function wordsMatch(q, hay) {
  const h = hay.toLowerCase();
  for (const word of q.toLowerCase().split(' ')) {
    if (word && h.indexOf(word) === -1) return false;
  }
  return true;
}

function missionMatchesFilter(m) {
  const f = LIST_FILTERS.missions;
  if (f.shop && m.retailer !== f.shop) return false;
  if (f.status === 'pre' && !m.isPreOrder) return false;
  if (f.status === 'in' && (m.isPreOrder || m.state !== 'in')) return false;
  if (f.status === 'out' && (m.isPreOrder || m.state !== 'out')) return false;
  if (f.status === 'blind' && !notReading(m)) return false;
  if (f.mode === 'armed' && !m.armed) return false;
  if (f.mode === 'watching' && !(m.enabled && !m.armed)) return false;
  if (f.mode === 'off' && m.enabled) return false;
  if (f.q) {
    return wordsMatch(f.q,
      (m.productName || '') + ' ' + (m.retailer || '') + ' ' + (m.externalId || ''));
  }
  return true;
}

function productMatchesFilter(p) {
  const f = LIST_FILTERS.products;
  const mine = (DATA.listings || []).filter((l) => l.productKey === p.key);
  // A product is "at" a shop when any of its listings is. One with no
  // listings answers to no shop segment except All — which is honest: it is
  // not buyable anywhere yet.
  if (f.shop && !mine.some((l) => l.retailer === f.shop)) return false;
  if (!f.q) return true;
  return wordsMatch(f.q,
    (p.name || '') + ' ' + (p.notes || '') + ' ' + mine.map((l) => l.retailer).join(' '));
}

function runMatchesFilter(r) {
  const f = LIST_FILTERS.activity;
  if (f.shop && r.retailer !== f.shop) return false;
  if (f.outcome && r.outcome !== f.outcome) return false;
  if (f.q) {
    return wordsMatch(f.q, (r.productName || '') + ' ' + (r.retailer || '') + ' ' +
      (r.outcome || '') + ' ' + (r.reason || ''));
  }
  return true;
}

function changeMatchesFilter(o) {
  const f = LIST_FILTERS.activity;
  if (f.shop && o.retailer !== f.shop) return false;
  // Outcome is a run word; a change has none, so that chip leaves changes alone.
  if (f.q) {
    return wordsMatch(f.q,
      (o.productName || '') + ' ' + (o.retailer || '') + ' ' + (o.state || ''));
  }
  return true;
}

function listChip(label, n, active, onClick, disabled) {
  const b = el('button', 'chip', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (n !== null) b.appendChild(el('span', 'n', String(n)));
  if (disabled) b.disabled = true;
  else b.addEventListener('click', onClick);
  return b;
}

/**
 * One row of chips for one field of one filter. Counts are of what the
 * *other* filters allow — the finds rule — so a chip always tells the
 * truth about what pressing it would give you.
 */
function chipGroup(filter, field, rows, matches, options, allLabel, onSet) {
  const row = el('div', 'chips');
  const set = (value) => {
    filter[field] = value;
    if (onSet) onSet(value);
    render();
  };
  const countFor = (value) => {
    const was = filter[field];
    filter[field] = value;
    let n = 0;
    for (const r of rows) if (matches(r)) n++;
    filter[field] = was;
    return n;
  };
  row.appendChild(listChip(allLabel, countFor(''), !filter[field], () => set('')));
  for (const o of options) {
    const n = countFor(o.value);
    row.appendChild(listChip(o.label, n, filter[field] === o.value, () => {
      set(filter[field] === o.value ? '' : o.value);
    }, n === 0 && filter[field] !== o.value));
  }
  return row;
}

function shopOptions(rows) {
  const names = [];
  for (const r of rows) {
    if (r.retailer && names.indexOf(r.retailer) === -1) names.push(r.retailer);
  }
  names.sort();
  return names.map((name) => ({ value: name, label: name }));
}

function clearListFilter(key) {
  const f = LIST_FILTERS[key];
  for (const k in f) f[k] = '';
  if (key === 'products') saveShop('products', '');
  const box = document.getElementById('flt-' + key + '-q');
  if (box) box.value = '';
  render();
}

function filterCountLine(id, shown, total, anyActive, key) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = '';
  if (!total) return;
  node.append(shown === total ? 'All ' + total : 'Showing ' + shown + ' of ' + total);
  if (anyActive) {
    const b = el('button', 'small', 'Clear filters');
    b.style.marginLeft = '8px';
    b.addEventListener('click', () => clearListFilter(key));
    node.appendChild(b);
  }
}

/**
 * Draw one tab's filter bar and hand back the rows that pass it.
 *
 * A short list hides the bar and resets its filter — a filter you can
 * neither see nor clear must not be allowed to hide anything.
 */
function renderMissionsBar(all) {
  const bar = document.getElementById('flt-missions');
  const f = LIST_FILTERS.missions;
  if (all.length < FILTER_FROM) {
    bar.hidden = true;
    f.shop = ''; f.status = ''; f.mode = ''; f.q = '';
    const box = document.getElementById('flt-missions-q');
    if (box) box.value = '';
    return all;
  }
  bar.hidden = false;
  const chips = document.getElementById('flt-missions-chips');
  chips.textContent = '';
  chips.appendChild(chipGroup(f, 'shop', all, missionMatchesFilter,
    shopOptions(all), 'All shops'));
  chips.appendChild(chipGroup(f, 'status', all, missionMatchesFilter, [
    { value: 'pre', label: 'Pre-order' },
    { value: 'in', label: 'In stock' },
    { value: 'out', label: 'Out of stock' },
    { value: 'blind', label: 'Not reading' },
  ], 'Any status'));
  chips.appendChild(chipGroup(f, 'mode', all, missionMatchesFilter, [
    { value: 'armed', label: 'Armed' },
    { value: 'watching', label: 'Watching' },
    { value: 'off', label: 'Paused' },
  ], 'Any mode'));
  const shown = all.filter(missionMatchesFilter);
  filterCountLine('flt-missions-count', shown.length, all.length,
    !!(f.shop || f.status || f.mode || f.q), 'missions');
  return shown;
}

function renderProductsBar(all) {
  const bar = document.getElementById('flt-products');
  const f = LIST_FILTERS.products;
  const box = document.getElementById('flt-products-q');
  // The shop switcher earns its place as soon as there are two products; the
  // search box waits for a list long enough to need searching. Different
  // thresholds because they answer different questions.
  if (all.length < 2) {
    bar.hidden = true;
    f.q = '';
    if (box) box.value = '';
    return all;
  }
  bar.hidden = false;
  if (box) box.hidden = all.length < FILTER_FROM;
  if (box && box.hidden && f.q) { f.q = ''; box.value = ''; }
  const shops = document.getElementById('flt-products-shops');
  shops.textContent = '';
  shops.appendChild(chipGroup(f, 'shop', all, productMatchesFilter,
    shopOptions(DATA.listings || []), 'All shops',
    (v) => saveShop('products', v)));
  const shown = all.filter(productMatchesFilter);
  filterCountLine('flt-products-count', shown.length, all.length, !!(f.q || f.shop), 'products');
  return shown;
}

function renderActivityBar(runs, changes) {
  const bar = document.getElementById('flt-activity');
  const f = LIST_FILTERS.activity;
  if (runs.length + changes.length < FILTER_FROM) {
    bar.hidden = true;
    f.shop = ''; f.outcome = ''; f.q = '';
    const box = document.getElementById('flt-activity-q');
    if (box) box.value = '';
    return { runs: runs, changes: changes };
  }
  bar.hidden = false;
  const chips = document.getElementById('flt-activity-chips');
  chips.textContent = '';
  // Runs have an outcome; changes never do. That is how one bar tells the
  // two kinds of row apart without either table having to say.
  const activityMatches = (x) =>
    x.outcome !== undefined ? runMatchesFilter(x) : changeMatchesFilter(x);
  const everything = runs.concat(changes);
  chips.appendChild(chipGroup(f, 'shop', everything, activityMatches,
    shopOptions(everything), 'All shops'));
  const outcomes = [];
  for (const r of runs) {
    if (r.outcome && outcomes.indexOf(r.outcome) === -1) outcomes.push(r.outcome);
  }
  outcomes.sort();
  if (outcomes.length > 1) {
    chips.appendChild(chipGroup(f, 'outcome', runs, runMatchesFilter,
      outcomes.map((o) => ({ value: o, label: o.split('_').join(' ') })), 'Any outcome'));
  }
  const shownRuns = runs.filter(runMatchesFilter);
  const shownChanges = changes.filter(changeMatchesFilter);
  filterCountLine('flt-activity-count', shownRuns.length + shownChanges.length,
    everything.length, !!(f.shop || f.outcome || f.q), 'activity');
  return { runs: shownRuns, changes: shownChanges };
}

function render() {
  const missions = document.getElementById('missions');
  missions.textContent = '';
  const shownMissions = renderMissionsBar(DATA.missions);
  if (!DATA.missions.length) {
    missions.appendChild(emptyBlock('Nothing is being watched yet.',
      'Add a product on the Products tab, paste a listing URL, and a mission is created for you.'));
  } else if (!shownMissions.length) {
    missions.appendChild(emptyBlock('Nothing matches those filters.',
      DATA.missions.length + ' missions are hidden — clear the filters above to see them.'));
  }
  for (const m of shownMissions) missions.appendChild(missionCard(m));

  const products = document.getElementById('products');
  products.textContent = '';
  const shownProducts = renderProductsBar(DATA.products);
  if (!DATA.products.length) {
    products.appendChild(emptyBlock('No products yet.', 'Add one with the form above.'));
  } else if (!shownProducts.length) {
    products.appendChild(emptyBlock('Nothing matches those filters.',
      DATA.products.length + ' products are hidden — clear the filters above to see them.'));
  }
  for (const p of shownProducts) products.appendChild(productCard(p));

  const act = renderActivityBar(DATA.runs, DATA.changes);

  const runsCard = document.getElementById('runs-card');
  runsCard.textContent = '';
  const newestCheck = DATA.missions
    .map((m) => m.lastCheckedAt)
    .filter(Boolean)
    .sort()
    .pop();
  runsCard.appendChild(runTable(act.runs,
    DATA.runs.length ? 'No runs match those filters.' : 'Nothing has run yet.',
    newestCheck));

  const changesCard = document.getElementById('changes-card');
  changesCard.textContent = '';
  if (!act.changes.length) {
    changesCard.appendChild(el('div', 'meta',
      DATA.changes.length ? 'No changes match those filters.' : 'Nothing has changed yet.'));
  } else {
    const table = el('table');
    const body = el('tbody');
    const head = el('tr');
    for (const h of ['When', 'Product', 'Retailer', 'Now']) head.appendChild(el('th', null, h));
    body.appendChild(head);
    for (const o of act.changes) {
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
  const blind = DATA.missions.filter(notReading).length;
  const parts = [];
  // First, because a watcher that cannot read pages is not watching, and that
  // outranks anything else the line could say.
  if (blind) parts.push(blind + ' NOT READING');
  if (inStock) parts.push(inStock + ' in stock');
  if (armed) parts.push(armed + ' armed');
  if (never) parts.push(never + ' never checked');
  document.getElementById('summary').textContent =
    parts.length ? parts.join(' · ') : 'nothing in stock';
  document.getElementById('who').textContent = DATA.you || '';

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
  if (document.activeElement !== sf.querySelector('[name=spendCapDay]')) {
    sf.querySelector('[name=spendCapDay]').value =
      st.spendCapDay === null || st.spendCapDay === undefined ? '' : st.spendCapDay;
  }
  if (document.activeElement !== sf.querySelector('[name=sweepEveryHours]')) {
    sf.querySelector('[name=sweepEveryHours]').value = st.sweepEveryHours || '';
  }

  renderRadar();
  renderFinds();
  renderDetail();
  applyViews();

  const hf = document.getElementById('hours-form');
  if (document.activeElement !== hf.querySelector('[name=activeFrom]')) {
    hf.querySelector('[name=activeFrom]').value = st.activeFrom || '';
  }
  if (document.activeElement !== hf.querySelector('[name=activeUntil]')) {
    hf.querySelector('[name=activeUntil]').value = st.activeUntil || '';
  }
  if (document.activeElement !== hf.querySelector('[name=timezone]')) {
    hf.querySelector('[name=timezone]').value = st.timezone || '';
  }
  hf.querySelector('[name=paused]').checked = !!st.paused;

  // Say it where it cannot be missed, not only on the tab nobody opens.
  renderMoney();
  const banner = document.getElementById('paused-banner');
  banner.hidden = !st.paused;

  // The queue alarm. A waiting room at a shop means a drop is likely live
  // RIGHT NOW, and the one useful thing this app can do with that is put it
  // at the top of every tab with a link — getting in line is a person's job,
  // and the queue position is the scarce thing.
  const SHOP_URL = {
    'Target': 'https://www.target.com',
    'Walmart': 'https://www.walmart.com',
    'Pokemon Center': 'https://www.pokemoncenter.com',
  };
  const qb = document.getElementById('queue-banner');
  qb.textContent = '';
  const queues = DATA.queues || [];
  qb.hidden = queues.length === 0;
  for (const q of queues) {
    qb.appendChild(el('div', 'name',
      'WAITING ROOM UP AT ' + (q.retailer || 'A SHOP').toUpperCase()));
    const meta = el('div', 'meta');
    meta.append('Seen ' + ago(q.at) + ' — a drop is likely live. Get in line from any device: ');
    const a = el('a', null, 'open ' + (q.retailer || 'the shop'));
    a.href = SHOP_URL[q.retailer] || 'https://www.' +
      String(q.retailer || '').toLowerCase().split(' ').join('') + '.com';
    a.target = '_blank';
    a.rel = 'noreferrer';
    meta.appendChild(a);
    qb.appendChild(meta);
  }

  // The two buttons that change what the Watcher is doing, labelled with the
  // action rather than the state. "Turn watcher on" when it is off is
  // unambiguous; a toggle labelled "Paused" leaves you guessing whether that
  // is the current state or what pressing it will do.
  const toggle = document.getElementById('watcher-toggle');
  toggle.textContent = st.paused ? 'Turn watcher on' : 'Turn watcher off';
  toggle.className = st.paused ? 'primary' : '';

  // The sweep button says which of three things is true, because "queued" for
  // forty minutes reads as stuck. A sweep is thirteen queries reported one at a
  // time, so between pressing and finishing there is a long middle where the
  // honest word is "sweeping", with how far along it is.
  const sweepBtn = document.getElementById('sweep-now');
  const sweep = DATA.sweep || {};
  const running = String(sweep.lastStatus || '').indexOf('sweeping') === 0;
  sweepBtn.disabled = !!sweep.queued;
  sweepBtn.textContent = !sweep.queued
    ? 'Run catalogue sweep'
    : running
      ? sweep.lastStatus
      : 'sweep queued';
  sweepBtn.title = sweep.lastSweptAt
    ? 'last swept ' + ago(sweep.lastSweptAt) + (sweep.lastStatus ? ' — ' + sweep.lastStatus : '')
    : 'never swept';

  document.getElementById('c-missions').textContent = DATA.missions.length || '';
  document.getElementById('c-products').textContent = DATA.products.length || '';
  document.getElementById('c-activity').textContent = DATA.runs.length || '';
  document.getElementById('c-finds').textContent = (DATA.discoveries || []).length || '';
}

/**
 * The review list.
 *
 * Sorted so the ones the sweep was confident about come first and the ones it
 * wants a person for come after — the whole reason 'unsure' exists is that
 * showing you a poster collection costs two seconds and dropping a real drop
 * costs the drop, so the uncertain ones are shown, just not shown first.
 */
/** Whole days from today to a plain yyyy-mm-dd. Null when it is not one. */
function daysUntil(date) {
  const t = Date.parse(date + 'T00:00:00Z');
  if (!isFinite(t)) return null;
  const now = new Date();
  const today = Date.parse(
    now.getUTCFullYear() + '-' +
    String(now.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(now.getUTCDate()).padStart(2, '0') + 'T00:00:00Z');
  return Math.round((t - today) / 86400000);
}

/** One sentence on why this is worth a look. Blank when there is nothing to add. */
function findReason(d) {
  if (d.signal === 'buyable') return 'buyable right now';
  if (d.signal === 'scheduled') return 'scheduled — the shop has published a date';
  if (d.signal === 'recent') return 'released recently and sold out — the restock candidate';
  if (d.foundBy) return 'found by "' + d.foundBy + '"';
  return '';
}

/**
 * What the finds list is currently narrowed to.
 *
 * Module state rather than the URL or storage: the page reloads its data every
 * thirty seconds and re-renders, and a filter that reset each time would be
 * unusable. A hard refresh clearing it is the right amount of memory for
 * something you set while looking at a list.
 */
const FIND_FILTER = {
  shop: savedShop('finds'), state: '', q: '', showDormant: false, fresh: false,
};

/** First seen inside the last two days — the news, as opposed to the list. */
const FRESH_MS = 48 * 3600 * 1000;
function isFresh(d) {
  const t = Date.parse(d.firstSeenAt || '');
  return isFinite(t) && Date.now() - t < FRESH_MS;
}

/**
 * What each kind of sealed product usually costs at a shop that is not
 * reselling it. Shipped with the page rather than fetched: it is a constant,
 * and a price sanity check that arrives late is no use next to a price.
 */
const TYPICAL_PRICE = ${JSON.stringify(TYPICAL_PRICE)};
const FLAG_ABOVE = ${FLAG_ABOVE};

/** How far above the usual price this sits. Null when there is no comparison. */
function overTypical(kind, price) {
  const typical = TYPICAL_PRICE[String(kind || '').toLowerCase()];
  if (!typical || !price || !(price > 0)) return null;
  return Math.round((price / typical) * 100) / 100;
}

/** Which band a find is in. Lower is more worth your attention. */
function findRank(d) {
  if (d.isPreOrder) return 0;              // takes money now — decide deliberately
  if (d.state === 'in') return 1;          // buyable this minute
  if (d.releaseDate && daysUntil(d.releaseDate) > 0) return 2;  // dated, ahead
  if (d.signal === 'recent') return 3;     // sold out recently, may come back
  if (d.confidence === 'unsure') return 5; // needs a person, but not urgently
  return 4;
}

/** Everything below this band is back-catalogue: real, remembered, not news. */
const DORMANT_FROM = 4;

function findMatches(d) {
  const f = FIND_FILTER;
  if (f.shop && d.retailer !== f.shop) return false;
  if (f.state === 'pre' && !d.isPreOrder) return false;
  if (f.state === 'in' && (d.isPreOrder || d.state !== 'in')) return false;
  if (f.state === 'out' && (d.isPreOrder || d.state !== 'out')) return false;
  if (f.fresh && !isFresh(d)) return false;
  if (f.q) {
    const hay = ((d.name || '') + ' ' + (d.kind || '') + ' ' + (d.retailer || '')).toLowerCase();
    // Every word, in any order. Typing two words should narrow, not fail.
    for (const word of f.q.toLowerCase().split(' ')) {
      if (word && hay.indexOf(word) === -1) return false;
    }
  }
  return true;
}

function renderFindFilters(all) {
  const shops = document.getElementById('find-shops');
  const states = document.getElementById('find-states');
  if (!shops || !states) return;
  shops.textContent = '';
  states.textContent = '';

  const chip = (label, n, active, onClick, disabled) => {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (n !== null) b.appendChild(el('span', 'n', String(n)));
    if (disabled) b.disabled = true;
    else b.addEventListener('click', onClick);
    return b;
  };

  // Counts are of what the *other* filters allow, so a chip always tells the
  // truth about what pressing it would give you.
  const forShop = (shop) => all.filter((d) => {
    const was = FIND_FILTER.shop;
    FIND_FILTER.shop = shop;
    const ok = findMatches(d);
    FIND_FILTER.shop = was;
    return ok;
  }).length;

  shops.appendChild(chip('All shops', forShop(''), !FIND_FILTER.shop, () => {
    FIND_FILTER.shop = '';
    saveShop('finds', '');
    renderFinds();
  }));
  const names = [];
  for (const d of all) {
    if (d.retailer && names.indexOf(d.retailer) === -1) names.push(d.retailer);
  }
  names.sort();
  for (const name of names) {
    const n = forShop(name);
    shops.appendChild(chip(name, n, FIND_FILTER.shop === name, () => {
      FIND_FILTER.shop = FIND_FILTER.shop === name ? '' : name;
      saveShop('finds', FIND_FILTER.shop);
      renderFinds();
    }, n === 0 && FIND_FILTER.shop !== name));
  }

  const forState = (state) => all.filter((d) => {
    const was = FIND_FILTER.state;
    FIND_FILTER.state = state;
    const ok = findMatches(d);
    FIND_FILTER.state = was;
    return ok;
  }).length;

  const pick = (key, label) => {
    const n = forState(key);
    return chip(label, n, FIND_FILTER.state === key, () => {
      FIND_FILTER.state = FIND_FILTER.state === key ? '' : key;
      renderFinds();
    }, n === 0 && FIND_FILTER.state !== key);
  };
  states.appendChild(chip('Any status', forState(''), !FIND_FILTER.state, () => {
    FIND_FILTER.state = '';
    renderFinds();
  }));
  states.appendChild(pick('pre', 'Pre-order'));
  states.appendChild(pick('in', 'In stock'));
  states.appendChild(pick('out', 'Out of stock'));

  // The news chip. Independent of status — a fresh pre-order and a fresh
  // restock are both "what showed up since yesterday", which is the question
  // this chip answers.
  const forFresh = () => all.filter((d) => {
    const was = FIND_FILTER.fresh;
    FIND_FILTER.fresh = true;
    const ok = findMatches(d);
    FIND_FILTER.fresh = was;
    return ok;
  }).length;
  const nFresh = forFresh();
  states.appendChild(chip('New (48h)', nFresh, FIND_FILTER.fresh, () => {
    FIND_FILTER.fresh = !FIND_FILTER.fresh;
    renderFinds();
  }, nFresh === 0 && !FIND_FILTER.fresh));
}

/**
 * The release radar: every known street date ahead of today, as a calendar.
 *
 * Discovery answers "what exists"; the radar answers "when do I need to be
 * awake". It merges what you are watching with what the sweep found, because
 * on a release morning the distinction is bookkeeping — dated missions come
 * first (deduped by name, the mission wins), and Target is the only shop
 * that publishes dates ahead, so most rows will be Target's; that is a fact
 * about the retailers, not a bug in the radar.
 */
function renderRadar() {
  const host = document.getElementById('release-radar');
  if (!host) return;
  const entries = [];
  const seen = {};
  for (const m of DATA.missions) {
    if (!m.releaseDate) continue;
    const days = daysUntil(m.releaseDate);
    if (days === null || days < 0) continue;
    entries.push({ name: m.productName, retailer: m.retailer, date: m.releaseDate,
      days: days, watching: true, armed: !!m.armed, url: m.url, pre: !!m.isPreOrder });
    seen[String(m.productName).toLowerCase()] = true;
  }
  for (const d of DATA.discoveries || []) {
    if (!d.releaseDate) continue;
    const days = daysUntil(d.releaseDate);
    if (days === null || days < 0) continue;
    if (seen[String(d.name).toLowerCase()]) continue;
    entries.push({ name: d.name, retailer: d.retailer, date: d.releaseDate,
      days: days, watching: false, armed: false, url: d.url, pre: !!d.isPreOrder });
  }
  host.textContent = '';
  if (!entries.length) { host.hidden = true; return; }
  host.hidden = false;
  host.appendChild(el('div', 'name', 'Release radar'));
  host.appendChild(el('div', 'meta', 'Every known street date ahead, soonest first.'));
  entries.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));
  const groups = [
    { label: 'Drops today', today: true, match: (e) => e.days === 0 },
    { label: 'Tomorrow', match: (e) => e.days === 1 },
    { label: 'This week', match: (e) => e.days >= 2 && e.days <= 7 },
    { label: 'Later', match: (e) => e.days > 7 },
  ];
  for (const g of groups) {
    const mine = entries.filter(g.match);
    if (!mine.length) continue;
    const box = el('div', 'rgroup');
    box.appendChild(el('h3', g.today ? 'today' : null, g.label));
    for (const e of mine) {
      const row = el('div', 'rrow');
      const a = el('a', null, shortName(e.name));
      a.href = e.url; a.target = '_blank'; a.rel = 'noreferrer'; a.title = e.name;
      row.appendChild(a);
      row.appendChild(el('span', 'meta', (e.retailer ? e.retailer + ' · ' : '') + e.date +
        (e.days > 1 ? ' · in ' + e.days + ' days' : '')));
      if (e.armed) row.appendChild(el('span', 'pill s-in', 'ARMED'));
      else if (e.watching) row.appendChild(el('span', 'pill info', 'watching'));
      if (e.pre) row.appendChild(el('span', 'pill s-queue', 'PRE-ORDER'));
      box.appendChild(row);
    }
    host.appendChild(box);
  }
}

function renderFinds() {
  const list = document.getElementById('finds-list');
  list.textContent = '';
  // Ordered by what you can act on, not alphabetically.
  //
  // Walmart's own catalogue runs back years and most of it will never restock,
  // and unlike Pokémon Center it publishes no release date to judge age by — so
  // there is nothing to filter on without throwing away things that matter.
  // Sorting costs nothing and throws away nothing: the buyable and the
  // scheduled come first, the dormant back-catalogue sinks, and a long list
  // stops being a wall.
  const all = DATA.discoveries || [];
  renderFindFilters(all);

  const matched = all.filter(findMatches).sort((a, b) => {
    if (findRank(a) !== findRank(b)) return findRank(a) - findRank(b);
    // Within a band, newest first: a find that appeared today is the news.
    const seen = String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || ''));
    if (seen !== 0) return seen;
    return String(a.name).localeCompare(String(b.name));
  });

  // The back catalogue is folded away rather than filtered out. Walmart alone
  // contributes sixty-odd boxes from years ago that will most likely never
  // restock — but "most likely" is not "never", and dropping them would be a
  // decision made on your behalf. Behind one click, with the count on it, is
  // the honest version.
  const live = matched.filter((d) => findRank(d) < DORMANT_FROM);
  const dormant = matched.filter((d) => findRank(d) >= DORMANT_FROM);
  // The fresh filter unfolds the back catalogue: something that appeared
  // yesterday is news even when its band says dormant, and a chip that
  // promised three and folded one away would be lying.
  const shown = FIND_FILTER.showDormant || FIND_FILTER.fresh || live.length === 0
    ? matched : live;

  const count = document.getElementById('find-count');
  if (count) {
    count.textContent = all.length === 0 ? ''
      : shown.length === all.length ? 'All ' + all.length + ' waiting on you'
      : 'Showing ' + shown.length + ' of ' + all.length;
  }

  if (all.length === 0) {
    const empty = el('div', 'card');
    empty.appendChild(el('div', 'name', 'Nothing waiting'));
    empty.appendChild(el('div', 'meta',
      'Run a sweep on the machine that watches: npm run discover'));
    list.appendChild(empty);
    return;
  }

  if (matched.length === 0) {
    const none = el('div', 'card');
    none.appendChild(el('div', 'name', 'Nothing matches those filters'));
    none.appendChild(el('div', 'meta',
      String(all.length) + ' finds are waiting — widen the search to see them.'));
    const clear = el('button', 'small', 'Clear filters');
    clear.addEventListener('click', () => {
      FIND_FILTER.shop = '';
      FIND_FILTER.state = '';
      FIND_FILTER.q = '';
      FIND_FILTER.fresh = false;
      saveShop('finds', '');
      const box = document.getElementById('find-q');
      if (box) box.value = '';
      renderFinds();
    });
    const acts = el('div', 'actions');
    acts.style.marginTop = '10px';
    acts.appendChild(clear);
    none.appendChild(acts);
    list.appendChild(none);
    return;
  }

  for (const d of shown) {
    const card = el('div', 'card');
    const row = el('div', 'row');
    // The picture comes with the find, straight from Target's own response.
    // A review list of twenty text rows is a chore; a list of twenty boxes you
    // recognise is a glance.
    row.appendChild(thumb(d.imageUrl, d.name));
    const left = el('div', 'grow');

    left.appendChild(el('div', 'name', d.name || 'unnamed'));

    // The retailer leads. Keeping or forgetting turns on which shop it is
    // before it turns on anything else: the same box at Pokémon Center and at
    // a Walmart reseller are not the same decision.
    const facts = [];
    if (d.retailer) facts.push(d.retailer);
    if (d.kind) facts.push(d.kind);
    // Whose price this is, when it is not the one the page will show you.
    if (d.price) {
      facts.push(d.state === 'out' && d.otherOffers > 0
        ? money(d.price) + ' at ' + (d.retailer || 'the retailer')
        : money(d.price));
    }
    // What this kind of thing usually costs. Not "the MSRP of this product" —
    // no retailer publishes one, and two honest shops price the same box
    // differently. "Usually" is the claim that is actually true.
    const typical = TYPICAL_PRICE[String(d.kind || '').toLowerCase()];
    if (typical) facts.push('usually ' + money(typical));
    if (d.orderLimit) facts.push('limit ' + d.orderLimit + ' per order');
    left.appendChild(el('div', 'meta', facts.join(' · ')));

    const tags = el('div', 'tags');

    // The news first: a find that appeared in the last two days is the reason
    // to open this tab today rather than any other day.
    if (isFresh(d)) tags.appendChild(el('span', 'pill fresh', 'NEW'));

    // What it is, before what we guessed about it. A pre-order takes the money
    // now and ships whenever the publisher says, so it is a different decision
    // from a restock rather than a variety of one.
    if (d.isPreOrder) {
      tags.appendChild(el('span', 'pill s-queue', 'PRE-ORDER'));
    } else if (d.state === 'in') {
      tags.appendChild(el('span', 'pill s-in', 'in stock'));
    } else if (d.state === 'out') {
      tags.appendChild(el('span', 'pill s-out', 'out of stock'));
    }

    if (d.releaseDate) {
      const days = daysUntil(d.releaseDate);
      tags.appendChild(el('span', 'pill info',
        days === null ? 'releases ' + d.releaseDate
          : days > 0 ? 'releases ' + d.releaseDate + ' · ' + days + 'd'
          : days === 0 ? 'releases today'
          : 'released ' + d.releaseDate));
    }

    // The warning that was missing.
    //
    // A Walmart find is its own listing, at its own price, out of stock — all
    // true, and then the link opens a page where a marketplace seller holds
    // the buy box at forty times the money, because Walmart has none and the
    // box falls to whoever does. Nothing is wrong with the find. Being sent to
    // that page with no warning is what was wrong.
    // The number you are actually asking for when you look at a price: is this
    // sane? Flagged well above 1, because first-party shops genuinely differ by
    // twenty per cent and a flag that fires on that is one nobody reads.
    const over = overTypical(d.kind, d.price);
    if (over !== null && over >= FLAG_ABOVE) {
      tags.appendChild(el('span', 'pill flag', over.toFixed(1) + '× the usual price'));
    }

    if (d.state === 'out' && d.otherOffers > 0) {
      tags.appendChild(el('span', 'pill flag',
        d.otherOffers + (d.otherOffers === 1 ? ' reseller has' : ' resellers have') + ' the buy box'));
    }

    if (d.confidence === 'unsure') {
      tags.appendChild(el('span', 'pill s-unknown', 'not sure — your call'));
    }
    if (d.alreadyHave) {
      tags.appendChild(el('span', 'pill info', 'already on your list'));
    }
    if (tags.children.length) left.appendChild(tags);

    // Why the sweep put this in front of you, said in words rather than in a
    // status code. Only Pokémon Center's walk produces these; a Target keyword
    // sweep says which keyword instead, which is the more useful of the two
    // when there is a keyword to name.
    const why = findReason(d);
    if (why) left.appendChild(el('div', 'meta dim', why));

    if (d.url) {
      const link = document.createElement('a');
      link.href = d.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.className = 'meta';
      link.textContent = 'open at the retailer';
      const wrap = el('div', 'meta');
      wrap.appendChild(link);
      left.appendChild(wrap);
    }

    const actions = el('div', 'actions');
    actions.style.marginTop = '10px';

    const keep = el('button', 'small primary', 'Keep');
    keep.addEventListener('click', async (e) => {
      await withButton(e.target, 'Keeping…', null, async () => {
        await api('POST', '/api/discoveries/' + d.id + '/keep');
        load();
        return 'kept — it is a product now, watching nothing yet';
      });
    });

    const forget = el('button', 'small', 'Forget');
    forget.addEventListener('click', async (e) => {
      await withButton(e.target, 'Forgetting…', null, async () => {
        await api('POST', '/api/discoveries/' + d.id + '/forget');
        load();
        return 'forgotten — it will not be offered again';
      });
    });

    actions.appendChild(keep);
    actions.appendChild(forget);
    left.appendChild(actions);

    row.appendChild(left);
    card.appendChild(row);
    list.appendChild(card);
  }

  // The tail, and what it would cost you to look at it.
  // No fold notice while the fresh filter is on — it unfolds everything it
  // matches, so "N more from the back catalogue" would be counting rows that
  // are already on screen.
  if (dormant.length > 0 && !FIND_FILTER.showDormant && !FIND_FILTER.fresh && live.length > 0) {
    const more = el('div', 'card');
    more.appendChild(el('div', 'name',
      dormant.length + ' more from the back catalogue'));
    more.appendChild(el('div', 'meta',
      'Out of stock with no date, so most will not come back — but nothing is ' +
      'hidden from you permanently.'));
    const btn = el('button', 'small', 'Show them');
    btn.addEventListener('click', () => { FIND_FILTER.showDormant = true; renderFinds(); });
    const acts = el('div', 'actions');
    acts.style.marginTop = '10px';
    acts.appendChild(btn);
    more.appendChild(acts);
    list.appendChild(more);
  } else if (FIND_FILTER.showDormant && dormant.length > 0 && live.length > 0) {
    const fold = el('div', 'card');
    fold.appendChild(el('div', 'meta',
      'Showing the back catalogue as well.'));
    const btn = el('button', 'small', 'Hide the back catalogue');
    btn.addEventListener('click', () => { FIND_FILTER.showDormant = false; renderFinds(); });
    const acts = el('div', 'actions');
    acts.style.marginTop = '8px';
    acts.appendChild(btn);
    fold.appendChild(acts);
    list.appendChild(fold);
  }
}

function renderMoney() {
  const banner = document.getElementById('money-banner');
  if (!banner) return;
  const open = DATA.authorisations || [];
  banner.hidden = open.length === 0;
  if (open.length === 0) return;

  const cap = DATA.settings && DATA.settings.spendCapDay;
  document.getElementById('money-banner-detail').textContent =
    '$' + Number(DATA.committed || 0).toFixed(2) + ' of ' +
    (cap ? '$' + Number(cap).toFixed(2) : 'no cap') +
    ' is committed by ' + open.length + (open.length === 1 ? ' grant' : ' grants') +
    '. A grant is a buy in progress, or a Watcher that died mid-checkout.';

  const list = document.getElementById('money-banner-list');
  list.textContent = '';
  for (const a of open) {
    const m = (DATA.missions || []).find((x) => x.id === a.missionId);
    const row = el('div', 'actions');
    row.style.marginTop = '10px';
    row.appendChild(el('span', 'meta',
      '$' + Number(a.amount).toFixed(2) + ' — ' + (m ? m.productName : 'mission ' + a.missionId) +
      ' — granted ' + new Date(a.grantedAt).toLocaleTimeString()));
    const release = el('button', 'small danger', 'Release');
    release.addEventListener('click', async (e) => {
      // Deliberate friction, in words: releasing says "I looked, nothing was
      // bought". The confirm is the look.
      // No newline escapes in this string: the page ships inside a template
      // literal, which eats the backslash and drops a raw newline into the
      // middle of a quoted string. That mistake has now been made six times.
      if (!window.confirm(
        'Release this $' + Number(a.amount).toFixed(2) + ' grant? ' +
        'Only do this after checking your ' + (m ? m.retailer : '') + ' orders page. ' +
        'If an order DID go through, the money is spent whatever this button says.')) return;
      await withButton(e.target, 'Releasing…', null, async () => {
        await api('POST', '/api/authorisations/' + a.id + '/resolve',
          { result: 'released', note: 'released by hand from the app' });
        load();
        return 'released';
      });
    });
    row.appendChild(release);
    list.appendChild(row);
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
      closeAdd();
      // Open the new product's pop-up once fresh data is in, so the next
      // step is in front of you. The key is read HERE, inside the button's
      // own error handling — a surprise response shape must fail the button,
      // not leak out of a .then as an unhandled rejection.
      const newKey = r.product ? r.product.key : r.listing ? r.listing.productKey : '';
      load().then(() => { if (newKey) openDetail('product', newKey); });
      return r.alreadyTracked
        ? 'already watching that listing — the product details were saved'
        : 'added, and watching ' + r.listing.retailer + ' ' + r.listing.externalId;
    }

    const { product } = await api('POST', '/api/products', details);
    form.reset();
    closeAdd();
    const newKey = product ? product.key : '';
    load().then(() => { if (newKey) openDetail('product', newKey); });
    return 'added — now give it a listing URL below';
  });
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === tab);
    for (const name of ['missions', 'products', 'activity', 'finds', 'settings']) {
      document.getElementById('tab-' + name).hidden = name !== tab.dataset.tab;
    }
  });
}

const addDialog = document.getElementById('add-dialog');

function openAdd() {
  // showModal gives the backdrop and Escape for free. Older engines fall back
  // to a plain open dialog rather than a button that does nothing.
  if (addDialog.showModal) addDialog.showModal();
  else addDialog.open = true;
  const first = addDialog.querySelector('[name=name]');
  if (first) first.focus();
}
function closeAdd() {
  if (addDialog.close) addDialog.close();
  else addDialog.open = false;
}

document.getElementById('add-open').addEventListener('click', openAdd);
addDialog.querySelector('[data-act=add-close]').addEventListener('click', closeAdd);

for (const box of document.querySelectorAll('.vt')) {
  for (const b of box.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      VIEWS[box.dataset.list] = b.dataset.view;
      try { localStorage.setItem('view:' + box.dataset.list, b.dataset.view); } catch (e) { /* fine */ }
      applyViews();
    });
  }
}

const detailDialog = document.getElementById('detail-dialog');
detailDialog.querySelector('[data-act=detail-close]').addEventListener('click', closeDetail);
detailDialog.addEventListener('click', (e) => { if (e.target === detailDialog) closeDetail(); });
// Escape closes the dialog natively; the state has to follow it.
detailDialog.addEventListener('close', () => { DETAIL = null; });
// Clicking the backdrop is the other way people expect to dismiss this.
addDialog.addEventListener('click', (e) => { if (e.target === addDialog) closeAdd(); });

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
      // Blank clears the cap — and with it, the ability to arm anything new.
      spendCapDay: f.spendCapDay === '' ? null : Number(f.spendCapDay),
      // Blank leaves the sweep cadence as it is — there is no "no sweeps"
      // spelling here on purpose.
      ...(f.sweepEveryHours === '' ? {} : { sweepEveryHours: Number(f.sweepEveryHours) }),
    });
    load();
    return 'saved — applies to every mission';
  });
});

document.getElementById('diag-download').addEventListener('click', async (e) => {
  const hours = document.getElementById('diag-hours').value;
  const msg = document.getElementById('diag-msg');
  await withButton(e.target, 'Collecting…', msg, async () => {
    const res = await fetch('/api/activity/export?hours=' + hours, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('the Hub said ' + res.status);
    const text = await res.text();
    const data = JSON.parse(text);

    // Saved from the text already in hand rather than by pointing a link at
    // the endpoint. Same bytes the checks below ran against, and it works on a
    // phone, where navigating to a JSON URL opens a viewer instead of saving.
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'watcher-activity-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    if (data.warnings && data.warnings.length) {
      // The export checks its own output and says so rather than going quiet.
      // If this ever fires, the file is still yours — just do not pass it on.
      return 'saved ' + data.counts.lines + ' lines, but check it first: ' + data.warnings.join(', ');
    }
    const errors = (data.counts.byLevel && data.counts.byLevel.error) || 0;
    return 'saved ' + data.counts.lines + ' lines' + (errors ? ', ' + errors + ' of them failures' : '');
  });
});

document.getElementById('sweep-now').addEventListener('click', async (e) => {
  await withButton(e.target, 'Queueing…', null, async () => {
    await api('POST', '/api/sweep-now');
    load();
    return 'queued — the Watcher sweeps a query per pass from here';
  });
});

document.getElementById('watcher-toggle').addEventListener('click', async (e) => {
  const turningOff = !(DATA.settings && DATA.settings.paused);
  // Only ever asked on the way to stopping. Starting something is not the
  // decision worth interrupting; stopping the thing that is meant to catch a
  // drop is.
  if (turningOff && !confirm('Stop all watching? Nothing will be checked until you turn it back on.')) {
    return;
  }
  await withButton(e.target, turningOff ? 'Stopping…' : 'Starting…', null, async () => {
    await api('POST', '/api/settings', { paused: turningOff });
    load();
    return turningOff ? 'watcher off' : 'watcher on';
  });
});

document.getElementById('hours-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = fields(form);
  const msg = document.getElementById('hours-msg');
  await withButton(form.querySelector('button[type=submit]'), 'Saving…', msg, async () => {
    await api('POST', '/api/settings', {
      paused: !!f.paused,
      activeFrom: f.activeFrom || '',
      activeUntil: f.activeUntil || '',
      timezone: f.timezone || '',
    });
    load();
    return f.paused
      ? 'paused — the Watcher will look at nothing until you turn this off'
      : f.activeFrom
        ? 'saved — watching ' + f.activeFrom + ' to ' + f.activeUntil
        : 'saved — watching around the clock';
  });
});

document.getElementById('refresh').addEventListener('click', (e) =>
  withButton(e.target, 'Refreshing…', null, load));

// Searching the finds. Re-renders from data already in the page, so it filters
// as you type without asking the Hub anything.
document.getElementById('find-q').addEventListener('input', (e) => {
  FIND_FILTER.q = String(e.target.value || '').trim();
  renderFinds();
});

// The other lists' search boxes. Static in the markup for the same reason as
// the finds box: a rebuilt input loses your cursor every thirty seconds.
document.getElementById('flt-missions-q').addEventListener('input', (e) => {
  LIST_FILTERS.missions.q = String(e.target.value || '').trim();
  render();
});
document.getElementById('flt-products-q').addEventListener('input', (e) => {
  LIST_FILTERS.products.q = String(e.target.value || '').trim();
  render();
});
document.getElementById('flt-activity-q').addEventListener('input', (e) => {
  LIST_FILTERS.activity.q = String(e.target.value || '').trim();
  render();
});

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
