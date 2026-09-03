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

/**
 * Nav icons.
 *
 * Inline SVG rather than a font or a sprite: they inherit `currentColor`, so
 * the selected state is one CSS rule and not a second copy of every drawing,
 * and there is no second request to fail on a phone with one bar of signal.
 *
 * Stroke-only, 24-unit box, no fills. They are read at 21px on a bottom bar,
 * where anything with interior detail turns to mud.
 *
 * `aria-hidden` on every one of them: the label beside it is the accessible
 * name, and a screen reader announcing "image, crosshair, Missions" is worse
 * than silence.
 */
const svg = (paths: string): string =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `${paths}</svg>`;

const ICONS = {
  // Three lines. The one control on the page whose meaning is universal, so it
  // carries no label even when everything else does.
  menu: svg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  // A bell, for the things that want a person.
  bell: svg('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/>' +
    '<path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  // Discord's mark is theirs; this is a plain game controller, which is what
  // the link means here without borrowing somebody else's logo.
  discord: svg('<rect x="2" y="7" width="20" height="11" rx="5"/>' +
    '<path d="M7 11v3M5.5 12.5h3M15.5 12h.01M18 14h.01"/>'),
  // A crosshair: a mission is one thing, watched.
  missions: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  // A box.
  products: svg('<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/>' +
    '<path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>'),
  // A pulse line: the log is a heartbeat, and its silences mean something.
  activity: svg('<path d="M3 12h4l2.5-6 4 12L16 12h5"/>'),
  // A magnifier: finds are what the sweep turned up.
  finds: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>'),
  // A shield: the vault is where a bought thing is kept.
  vault: svg('<path d="M12 3l7.5 3v6c0 4.5-3.2 7.6-7.5 9-4.3-1.4-7.5-4.5-7.5-9V6z"/>' +
    '<path d="m9 12 2.2 2.2L15.5 10"/>'),
  // A rising step: the dashboard is where the shape of things is read.
  home: svg('<path d="M3 19h18"/><path d="M6 19v-5M10.5 19V9M15 19v-7M19.5 19V5"/>'),
  // A rosette: a win is a thing that happened, not a thing being watched.
  wins: svg('<circle cx="12" cy="9" r="5.5"/><path d="m8.6 13.6-1.6 7 5-2.6 5 2.6-1.6-7"/>'),
  // A dial.
  settings: svg('<circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3' +
    'M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
};

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
/* viewport-fit=cover puts the page under the notch and the status bar. That
   is what makes the bottom bar sit flush — but nothing was reserving the space
   at the TOP, so on a phone the clock and the battery sat on top of the
   wordmark. The inset is zero everywhere it does not apply. */
main { max-width: 1040px; margin: 0 auto;
       padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 96px; }

header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
         position: relative; margin-bottom: 18px; }
header > div { min-width: 0; }
#summary { display: block; }

/* ── The ribbon ─────────────────────────────────────────────────────────── */
.ribbon { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
.ribbon .primary { padding: 8px 14px; font-size: 13px; }
.rib { display: inline-flex; align-items: center; gap: 7px; position: relative;
       padding: 7px 10px; border-radius: var(--r-sm); border: 1px solid var(--line);
       background: var(--panel-2); color: var(--muted); cursor: pointer;
       font: 500 12.5px/1 var(--sans); text-decoration: none; }
.rib:hover { color: var(--ink); border-color: var(--line-strong); }
.rib svg { width: 17px; height: 17px; }
.rib .dot { position: absolute; top: 4px; right: 4px; width: 8px; height: 8px;
            border-radius: 50%; background: var(--alert); }
.rib.avatar { width: 32px; height: 32px; padding: 0; justify-content: center;
              border-radius: 50%; background: var(--accent-soft); color: var(--accent);
              border-color: var(--accent); font-weight: 700; font-size: 13px; }

/* Both panels hang under the ribbon rather than in it, so a long list does not
   push the header around. */
.pop { position: absolute; right: 0; top: calc(100% + 8px); z-index: 40; width: 340px;
       max-width: calc(100vw - 24px); max-height: 60vh; overflow-y: auto;
       background: var(--panel); border: 1px solid var(--line-strong);
       border-radius: var(--r); box-shadow: 0 18px 40px rgba(0,0,0,.45); }
.pop-sm { width: 230px; }
.pop-head { padding: 11px 12px 8px; font: 600 12px/1.3 var(--sans); color: var(--muted);
            letter-spacing: .04em; text-transform: uppercase;
            display: flex; align-items: center; gap: 8px; }
.popitem { display: block; width: 100%; text-align: left; padding: 10px 12px;
           background: none; border: 0; border-top: 1px solid var(--line);
           color: var(--ink); font: 500 13.5px/1.2 var(--sans); cursor: pointer;
           text-decoration: none; }
.popitem:hover { background: var(--panel-2); }
.bellrow { display: block; width: 100%; text-align: left; padding: 10px 12px;
           background: none; border: 0; border-top: 1px solid var(--line);
           color: var(--ink); font: 500 13px/1.35 var(--sans); cursor: pointer; }
.bellrow:hover { background: var(--panel-2); }
.bellrow .when { color: var(--dim); font-weight: 400; font-size: 12px; }
.bellrow.alarm { border-left: 3px solid var(--alert); }
.bellrow.warn { border-left: 3px solid var(--warn); }

/* ── The profile panel ──────────────────────────────────────────────────── */
.me-top { display: flex; align-items: center; gap: 10px; padding: 13px 12px 10px; }
.me-name { font: 600 15px/1.2 var(--sans); color: var(--ink); }
.me-rights { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 11px; }
/* Selector written as a child rather than ".me-rights .pill", because that
   spelling contains the exact string a test greps for when it checks the real
   .pill rule, and it silently became the first match. */
.me-rights > span { font-size: 11px; }
.me-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px;
            background: var(--line); border-top: 1px solid var(--line);
            border-bottom: 1px solid var(--line); margin-bottom: 11px; }
.me-stat { background: var(--panel); padding: 10px 12px; }
.me-stat b { display: block; font: 700 17px/1.1 var(--mono); color: var(--ink); }
.me-stat span { font-size: 11.5px; color: var(--dim); letter-spacing: .02em; }
/* The mark: the creature's eye from the dnacardvault logo, redrawn as SVG —
   the same drawing the PWA icons are rendered from. */
.mark { width: 34px; height: 34px; border-radius: 10px; flex: none;
        background: #0b0817 url("data:image/png;base64,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") center / cover no-repeat;
        box-shadow: 0 4px 14px rgba(127, 119, 221, .4);
        display: inline-flex; vertical-align: -9px; margin-right: 10px; }
h1 { font: 800 26px/1.2 var(--display); margin: 0; letter-spacing: -0.02em; }
/* ── Headings outrank the words under them ──────────────────────────────────
   They did not. A heading was 12px, uppercase and DIM, sitting above body text
   that was 13px and brighter, so the label for a section was quieter than the
   section — and the eye slid past the chapter marks into one grey wall.

   Bigger, brighter, in sentence case, with the air above it that says a new
   thing has started. The hairline stays: it is what makes the page read as
   chapters rather than one long scroll. */
h2 { font: 700 19px/1.3 var(--display); letter-spacing: -.01em;
     color: var(--ink); margin: 38px 0 12px;
     display: flex; align-items: center; gap: 14px; }
h2::after { content: ''; flex: 1; height: 1px; background: var(--line); }
/* First heading in a tab has nothing above it to be separated from. */
section > h2:first-child { margin-top: 4px; }
h3 { font: 700 14px/1.4 var(--display); margin: 0 0 8px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
a { color: var(--accent); text-underline-offset: 2px; }

/*
 * The nav. One element, two shapes, and they are the two shapes the platform
 * already taught people:
 *
 *   PHONE   a fixed bar along the BOTTOM, icon over label, one row, thumb-high.
 *   BROWSER a side panel down the LEFT, icon beside label, brand on top.
 *
 * It used to be a wrapping strip stuck to the top on a phone. That solved the
 * real problem it was written for — six tabs are wider than a phone, and the
 * sixth was simply gone off the right-hand edge — but it solved it by eating
 * two rows of the most valuable space on the screen, at the end furthest from
 * the thumb. Every app this competes with puts its nav at the bottom because
 * that is where the hand already is.
 *
 * Six items across the narrowest phone is ~53px each. That is why the label
 * drops to 10px and the icon carries the recognition: a bottom bar is scanned
 * by shape, not read.
 */
.shell { display: flex; align-items: stretch; min-height: 100vh; flex-direction: column; }
.shell > main { flex: 1; min-width: 0; }
.tabs { display: flex; align-items: center; z-index: 30;
        background: rgba(9, 8, 14, .82);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
/*
 * The lockup stacks rather than shrinks.
 *
 * "Phantom by DNA" on one line at 18px next to a 34px mark is wider than the
 * 194px the side panel has to give, and it was being cut off mid-word. The
 * first fix shrank the type, which bought a few pixels and made the app's own
 * name the smallest thing on its own panel.
 *
 * Two lines instead: the name at full weight, the origin under it in small
 * caps. Same information, half the width, and it reads as a mark rather than a
 * sentence that ran out of room. The space between the two spans is a real
 * text node, so the accessible name is still "Phantom by DNA".
 */
.brand { display: flex; align-items: center; gap: 9px; padding: 8px 10px 8px 14px; }
.brand-name { display: flex; flex-direction: column; line-height: 1.05; min-width: 0; }
.brand-name b { font: 800 18px/1 var(--display); letter-spacing: -0.015em; }
.brand-name i { font: 600 10px/1 var(--sans); font-style: normal; letter-spacing: .13em;
                text-transform: uppercase; color: var(--muted); margin-top: 3px; }
/* The header's copy of the wordmark. Shown only when the side panel is not. */
.phonebrand { display: none; padding: 0 0 2px; width: 100%; }
@media (max-width: 899px) { .phonebrand { display: flex; } }
.tab { cursor: pointer; border: none; background: none;
       display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
       padding: 11px 12px; border-radius: 10px; position: relative;
       font: 500 14px/1.4 var(--sans); color: var(--muted);
       transition: color .12s, background .12s; }
.tab:hover { color: var(--ink); background: rgba(255, 255, 255, .04); }
.tab .ico { flex: none; display: block; width: 19px; height: 19px; }
.tab .lbl { flex: 1 1 auto; min-width: 0; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
.tab .count { flex: none; font-family: var(--mono); font-size: 11px;
              color: var(--muted); padding: 1px 6px; border-radius: 999px;
              background: rgba(255, 255, 255, .06); }
.tab .count:empty { display: none; }
/* The active row, as the vault draws it: a soft filled pill in the accent, the
   label at full ink, and a short bar on the left edge so the current section is
   findable without reading. */
.tab.on { color: var(--ink); background: var(--accent-soft); font-weight: 600; }
.tab.on::before { content: ''; position: absolute; left: 0; top: 50%;
                  transform: translateY(-50%); width: 3px; height: 20px;
                  border-radius: 0 3px 3px 0; background: var(--accent); }
.tab.on .ico { color: var(--accent); }

/* A labelled break, not a bare rule: "why is there a gap here" is a question a
   divider on its own does not answer. */
.navgroup { display: flex; align-items: center; gap: 10px;
            padding: 18px 12px 7px; }
.navgroup span { font: 600 10px/1 var(--sans); letter-spacing: .12em;
                 text-transform: uppercase; color: var(--dim); white-space: nowrap; }
.navgroup::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.navspacer { flex: 1 1 auto; min-height: 12px; }

.navtop { display: flex; align-items: center; gap: 6px; }
.navtop .brand { flex: 1 1 auto; min-width: 0; }
.navtoggle { flex: none; cursor: pointer; display: flex;
       align-items: center; justify-content: center; width: 34px; height: 34px;
       border: 1px solid var(--line); border-radius: 9px; background: none;
       color: var(--muted); transition: color .12s, background .12s; }
.navtoggle:hover { color: var(--ink); background: rgba(255,255,255,.05); }
.navtoggle .ico { width: 17px; height: 17px; }


/* ── Phone: the bottom bar ───────────────────────────────────────────────── */
/* The sidebar is a browser thing. On a phone the thumb lives at the bottom of
   the screen, and a drawer that has to be opened first is a tap in front of
   every tap. Same items, same order, laid out as a strip: the group label and
   the collapse control have no meaning here and are not drawn. */
@media (max-width: 899px) {
  .tabs { position: fixed; left: 0; right: 0; bottom: 0; top: auto; z-index: 50;
          display: flex; flex-direction: row; align-items: stretch; gap: 0;
          border-top: 1px solid var(--line); padding: 2px 0 0;
          /* The home-indicator strip on an iPhone. Without this the last row
             of labels sits under it and reads as clipped. */
          padding-bottom: env(safe-area-inset-bottom, 0px);
          background: var(--panel, #0b0a12); }
  .tabs .navtop, .navgroup, .navspacer { display: none; }
  .tab { position: relative; flex: 1 1 0; min-width: 0; border-radius: 0;
         display: flex; flex-direction: column; align-items: center; gap: 3px;
         padding: 7px 1px 6px; font-size: 10px; letter-spacing: .01em; }
  .tab:hover { background: none; }
  /* Seven items and the longest label is nine characters: labels shrink
     rather than collide. */
  .tab .lbl { flex: none; max-width: 100%; }
  @media (max-width: 400px) { .tab { font-size: 9px; letter-spacing: 0; } }
  .tab .ico { width: 21px; height: 21px; }
  .tab.on { color: var(--accent); background: none; font-weight: 600; }
  .tab.on::before { display: none; }
  /* A badge on the icon, not a number after the label: at 10px an inline
     count is indistinguishable from the word it follows. */
  .tab .count { position: absolute; top: 4px; left: 50%; margin-left: 5px;
                font-size: 9.5px; line-height: 1; padding: 2px 4px;
                border-radius: 6px; background: var(--accent-soft); color: var(--ink); }
  /* Content must clear the bar. 58px is the bar, and the inset is whatever
     the phone adds under it. */
  .shell > main { padding-bottom: calc(58px + env(safe-area-inset-bottom, 0px)); }
}

/* ── Browser: the rail ───────────────────────────────────────────────────── */
@media (min-width: 900px) {
  .shell { flex-direction: row; }
  .tabs { display: flex; flex-direction: column; flex-wrap: nowrap;
          align-items: stretch; gap: 2px;
          width: 244px; flex: none; height: 100vh;
          position: sticky; top: 0; padding: 16px 12px;
          border-right: 1px solid var(--line);
          background: rgba(9, 8, 14, .55);
          transition: width .16s ease; }
  .brand { padding: 4px 2px 18px; }

  /* Collapsed: icons only, and everything that was text stops taking width
     rather than being squeezed into an ellipsis. The title attribute on each
     button is what still names it, which is why every tab carries one. */
  body.nav-collapsed .tabs { width: 68px; padding: 16px 10px; }
  body.nav-collapsed .tab { justify-content: center; padding: 11px 0; gap: 0; }
  body.nav-collapsed .tab .lbl,
  body.nav-collapsed .brand-name,
  body.nav-collapsed .navgroup span { display: none; }
  body.nav-collapsed .navgroup { padding: 14px 4px 8px; }
  body.nav-collapsed .navtop { flex-direction: column; gap: 10px; }
  body.nav-collapsed .brand { padding: 2px 0 8px; }
  /* The count becomes a dot on the icon: a pill with a number in it does not
     fit 68px, and hiding it entirely would lose the one thing the collapsed
     rail is still trying to tell you. */
  body.nav-collapsed .tab .count { position: absolute; top: 6px; right: 12px;
        min-width: 7px; height: 7px; padding: 0; font-size: 0; line-height: 0;
        background: var(--accent); border-radius: 999px; }
}

.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
/* The ⋯ overflow menu is gone with the buttons it used to hide: two things and
   a spacer fit on a phone without needing somewhere to hide. */
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
/* ═══════════════════════════════════════════════════════════════════════════
   LIQUID GLASS — the material, ported from DNA Card Vault
   ═══════════════════════════════════════════════════════════════════════════

   Same palette both apps already shared (#09080e ground, #7f77dd accent, DM
   Sans / Syne / DM Mono). What Phantom was missing was the MATERIAL: an
   ambient light field for the glass to refract, translucent surfaces over it,
   and the specular top edge that is the thing people actually recognise.

   ── The scope is deliberate, and it is not "everything" ──────────────────

   backdrop-filter is the expensive part. The vault's rule is blur only the
   few big, mostly-fixed surfaces, and give everything else a translucent fill
   plus a catch-light — they sit on a lit ground, so they read as glass for
   about zero GPU cost.

   Phantom needs that rule applied one level HARDER than the vault does,
   because .card here is not a panel — it is a LIST ROW. Forty missions and a
   hundred finds are forty and a hundred cards, and blurring each of them is
   the phone-jank the vault's comment warns about, at four times the count.
   So:

     BLURRED  the nav, the banners, the wizard and quick-add panels, the
              dialog — few, large, mostly fixed.
     FILLED   list cards, chips, buttons — translucent + specular, no blur.
     SOLID    prices, pills, tables, the log. Dense figures stay crisp; a
              number you have to squint at is worse than a flat panel.

   ── Guarded so it can only enhance ──────────────────────────────────────

   @supports for backdrop-filter, and the reduce-transparency check lives in
   JS rather than a CSS media query. That is the vault's scar: a CSS guard on
   prefers-reduced-transparency FAILS CLOSED, because a browser that has never
   heard of the feature treats the whole query as false and silently drops
   every rule inside it — which is how the material worked on desktop Chrome
   and rendered as nothing at all on the owner's phone. matchMedia in JS fails
   OPEN, and anybody who really has asked for less transparency simply never
   gets the attribute set. */
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :root[data-material=glass] {
    /* A vertical gradient, not a flat film: it reads as lit thickness. */
    --glass-bg:   linear-gradient(180deg, rgba(255,255,255,.085), rgba(255,255,255,.035));
    --glass-bg2:  rgba(255,255,255,.10);   /* controls */
    --glass-in:   rgba(255,255,255,.055);  /* interiors: inputs, thumbnails */
    --glass-bd:   rgba(255,255,255,.17);   /* hairline edge */
    --glass-bd2:  rgba(255,255,255,.10);   /* interior hairline, quieter */
    --glass-hi:   rgba(255,255,255,.45);   /* the catch-light */
    /* 18px, not 22. Above that it goes milky and the product art behind the
       panels stops being readable — the vault measured this so we do not
       have to. */
    --glass-blur: 18px;
    --glass-chrome-blur: 28px;
    --glass-chrome: rgba(13, 12, 19, .55);
  }

  /* The world the glass refracts. Without a lit ground, a translucent panel is
     just a grey one — the material is the CONTRAST between bright corner and
     dark field, not the transparency. */
  :root[data-material=glass] body {
    background:
      radial-gradient(1100px 760px at 12% -12%, rgba(127, 119, 221, .30), transparent 65%),
      radial-gradient(920px 680px at 106% 112%, rgba(96, 160, 240, .14), transparent 58%),
      radial-gradient(760px 560px at 88% 46%, rgba(127, 119, 221, .10), transparent 66%),
      linear-gradient(168deg, transparent 34%, rgba(127, 119, 221, .07) 62%, transparent 94%),
      var(--bg);
    background-attachment: fixed;
  }
  /* Phones: those px radii are wider than the whole viewport, so a 390px
     screen sits inside the flat CENTRE of an 1100px gradient and the light
     reads as one uniform tint. No bright-corner-into-dark falloff, no glass.
     Re-cut in viewport units, hotter and tighter. */
  @media (max-width: 768px) {
    :root[data-material=glass] body {
      background:
        radial-gradient(130vw 46vh at 14% -6%, rgba(127, 119, 221, .36), transparent 68%),
        radial-gradient(120vw 42vh at 108% 104%, rgba(96, 160, 240, .18), transparent 62%),
        radial-gradient(90vw 30vh at 94% 46%, rgba(255, 255, 255, .05), transparent 66%),
        var(--bg);
      background-attachment: fixed;
    }
  }

  /* ── chrome: the nav, in both its shapes ─────────────────────────────── */
  :root[data-material=glass] .tabs {
    background: var(--glass-chrome);
    backdrop-filter: blur(var(--glass-chrome-blur)) saturate(180%);
    -webkit-backdrop-filter: blur(var(--glass-chrome-blur)) saturate(180%);
  }
  @media (max-width: 899px) {
    /* The bottom bar is most of the frame on a phone, so it carries the
       material hardest: a deeper blur and the specular edge along its top,
       where content scrolls under it. */
    :root[data-material=glass] .tabs {
      backdrop-filter: blur(var(--glass-chrome-blur)) saturate(200%);
      -webkit-backdrop-filter: blur(var(--glass-chrome-blur)) saturate(200%);
      box-shadow: inset 0 1px 0 var(--glass-hi), 0 -10px 30px rgba(0,0,0,.32);
    }
  }
  @media (min-width: 900px) {
    /* The side panel's catch-light runs down its inner edge, not across a top
       it does not have. */
    :root[data-material=glass] .tabs {
      box-shadow: inset -1px 0 0 rgba(255,255,255,.06);
    }
  }
  :root[data-material=glass] .tab.on { box-shadow: inset 0 1px 0 var(--glass-hi); }

  /* ── list cards: filled and lit, not blurred ─────────────────────────── */
  :root[data-material=glass] .card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-bd);
    box-shadow: inset 0 1px 0 var(--glass-hi),
                inset 0 -24px 44px rgba(255,255,255,.03),
                0 16px 36px rgba(0,0,0,.30);
  }

  /* ── the panels that DO get blur: few, big, near the top ─────────────── */
  :root[data-material=glass] .banner,
  :root[data-material=glass] .wizard,
  :root[data-material=glass] .quickadd,
  :root[data-material=glass] dialog .card {
    backdrop-filter: blur(var(--glass-blur)) saturate(180%);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  }

  /* ── the float layer ─────────────────────────────────────────────────── */
  /* The pop-up stays NEAR-SOLID. A translucent sheet lets the page's own text
     ghost up through it, which is unreadable rather than beautiful — the
     vault settled this the hard way. The glass lives in its edge and its
     catch-light, and in the blurred page dimmed behind it. */
  :root[data-material=glass] dialog .card {
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    border: 1px solid var(--glass-bd);
    box-shadow: inset 0 1px 0 var(--glass-hi), var(--shadow);
  }
  :root[data-material=glass] dialog::backdrop {
    background: rgba(4, 3, 8, .55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }

  /* ── controls: translucent fill + specular, no per-element blur ──────── */
  /* Resting state only. The active chip and the primary button own their
     accent fill, and these rules are equal specificity — without the guards
     the later source order would quietly un-highlight a selected filter. */
  :root[data-material=glass] button:not(.primary):not(.go),
  :root[data-material=glass] .btn,
  :root[data-material=glass] .chip:not([aria-pressed="true"]) {
    background: var(--glass-bg2);
    border-color: var(--glass-bd);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.16);
  }
  /* The focal actions keep their solid accent and gain the top edge; the glow
     is the accent, so it belongs to them and to nothing else. */
  :root[data-material=glass] .primary,
  :root[data-material=glass] .go {
    box-shadow: inset 0 1px 0 rgba(255,255,255,.45),
                0 8px 22px rgba(127, 119, 221, .40);
  }

  /* ── interiors ───────────────────────────────────────────────────────── */
  /* Inputs and thumbnails sat on solid fills ON TOP of the glass, which broke
     every panel into patchwork. One quieter interior language, no extra blur —
     they are already on a lit surface, so this is free. Focus states are set
     after this in the cascade and are untouched. */
  :root[data-material=glass] input,
  :root[data-material=glass] select,
  :root[data-material=glass] textarea,
  :root[data-material=glass] .thumb {
    background: var(--glass-in);
    border-color: var(--glass-bd2);
  }

  /* Everything not named above stays exactly as it was, and that is the point:
     pills, tables, the activity log and every price on the page keep their
     solid fills, because a figure you have to squint at is a worse outcome
     than a flat panel. */
}

/*
 * The hidden attribute must actually hide.
 *
 * The rule below sets display: inline-block on every button, and an author
 * rule beats the user-agent stylesheet's own [hidden] { display: none }. So a
 * button carrying the hidden attribute stayed on screen — the Install button
 * was visible on every browser that never offered an install prompt, and the
 * front door's Back button sat there on step one with nothing behind it.
 *
 * Everything in this page toggles visibility with .hidden, so this belongs at
 * the top rather than as a display:none sprinkled on each offender.
 *
 * (No backticks in this comment on purpose. It lives inside a template
 * literal, and one of them ends the stylesheet.)
 */
[hidden] { display: none !important; }

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
/* One row: the shop lens, the Filters control, and the view switcher. It used
   to be three rows and the switcher had a row to itself. */
/* ── The dashboard ───────────────────────────────────────────────────────────
 *
 * Deliberately almost no colour. The funnel is ONE hue at descending strength,
 * because its job is magnitude in a fixed order — categorical colours here
 * would give five stages five identities and bury the only thing that matters,
 * which is where the number falls off a cliff.
 *
 * The status colours stay reserved for status, and never appear without a word
 * next to them: a red bar that means "this is the problem" and a red bar that
 * means "series four" cannot live in the same app.
 */
/* Two columns on a desktop, one on a phone. Panels that carry a list or a row
   of tiles take the full width; the four that are comparisons sit side by side,
   which is what makes this read as a dashboard rather than a scroll. */
.dash { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
        align-items: start; }
.dash > .card { margin: 0; }
.dash .span2 { grid-column: 1 / -1; }
@media (max-width: 860px) { .dash { grid-template-columns: minmax(0, 1fr); } }

/* The hero figure. Exactly one on the page: the number you opened it for.
   Proportional figures, not tabular — at this size tabular-nums gives every
   digit the width of a zero and a small number looks loose. */
.livehead { display: flex; align-items: center; gap: 14px; }
.hero { font: 700 46px/1 var(--display); color: var(--ink); letter-spacing: -.02em; }
.herolabel { font: 500 12px/1.3 var(--sans); letter-spacing: .06em;
             text-transform: uppercase; color: var(--muted); margin-top: 5px; }

/* ── The headline ───────────────────────────────────────────────────────────
   The panel had a number and a small grey caption, and read as one more tile
   on a page of tiles. This is the only thing on the dashboard you can act on
   in the next minute, so it says so in the app's own IN STOCK green — the same
   green as the pill on a card, because a colour that means one thing here and
   another thing there is a colour nobody trusts.

   It is a status colour, so it never appears without its word: the word IS the
   headline. And at zero it goes grey, because a bright green heading over
   "nothing is in stock" would be the interface lying for the sake of looking
   lively. */
.livetitle { font: 800 30px/1 var(--display); letter-spacing: .06em;
             text-transform: uppercase; color: var(--in);
             text-shadow: 0 0 22px rgba(95, 211, 160, .35); }
.livetitle.none { color: var(--muted); text-shadow: none; }
.hero { color: var(--in); }
.hero.none { color: var(--muted); }
@media (max-width: 520px) { .livetitle { font-size: 24px; } .hero { font-size: 38px; } }

/* One buyable listing. A row, not a card: the point is to scan several and
   click one, and a grid of tiles here would out-shout the number above it. */
.live { display: flex; align-items: center; gap: 10px; padding: 9px 0;
        border-top: 1px solid var(--line); }
.live img { width: 34px; height: 34px; border-radius: 7px; object-fit: cover;
            background: var(--panel-2); flex: none; }
.live .g { flex: 1 1 0; min-width: 0; }
.live .nm { font-size: 13.5px; color: var(--ink);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live .px { font: 700 14px/1 var(--mono); color: var(--ink); }
.live .go { font-size: 12px; }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px; margin-bottom: 12px; }
.kpis:last-child { margin-bottom: 0; }
.kpi { border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 12px 14px;
       background: var(--panel-2); }
.kpi .k { font: 500 11px/1.3 var(--sans); letter-spacing: .06em; text-transform: uppercase;
          color: var(--muted); }
.kpi .v { font: 700 26px/1.15 var(--display); margin-top: 6px;
          font-variant-numeric: tabular-nums; }
.kpi .n { font-size: 12px; color: var(--dim); margin-top: 3px; }
.kpi.good .v { color: var(--in); }
.kpi.bad .v { color: var(--alert); }

/* One bar per stage. The label sits ABOVE its bar rather than beside it, so a
   long stage name never squeezes the bar into a stub on a phone. */
.fstage { margin-top: 14px; }
.fstage .top { display: flex; align-items: baseline; gap: 8px; }
.fstage .lbl { font-size: 13px; }
.fstage .num { margin-left: auto; font: 700 15px/1 var(--mono); }
.fstage .track { height: 10px; margin-top: 6px; border-radius: 5px;
                 background: var(--panel-2); overflow: hidden; }
.fstage .fill { height: 100%; border-radius: 5px; background: var(--accent);
                transition: width .3s ease; }
/* The one place a stage is called out, and it is called out in words too. */
.fstage.cliff .lbl { color: var(--warn); font-weight: 600; }
.fstage .drop { font-size: 12px; color: var(--muted); margin-top: 4px; }

.verdict { margin-top: 16px; padding: 12px 14px; border-radius: var(--r-ctl);
           background: var(--warn-bg); border: 1px solid rgba(224, 176, 96, .3);
           font-size: 13.5px; line-height: 1.5; }
.verdict.ok { background: var(--in-bg); border-color: rgba(95, 211, 160, .3); }

/* A plain two-column list. Seven-odd reasons with counts is a table's job, not
   a pie chart's — see the note in the dashboard comment. */
.rows { margin-top: 10px; }
.rowline { display: flex; align-items: baseline; gap: 10px; padding: 7px 0;
           border-bottom: 1px solid var(--line); font-size: 13.5px; }
.rowline:last-child { border-bottom: none; }
.rowline .g { flex: 1 1 0; min-width: 0; }
.rowline .c { font-family: var(--mono); font-size: 13px; color: var(--muted); }
.rowline .bar { height: 4px; border-radius: 2px; background: var(--accent);
                opacity: .55; margin-top: 5px; }

/* The budget, as one bar in three parts.
 *
 * A stacked bar rather than three separate meters, because the question is
 * part-to-whole — how much of the pot is accounted for — and three meters make
 * the reader do the addition. Two-pixel gaps between the segments so adjacent
 * fills stay countable, and every segment carries a written label: these are
 * status colours, and a status colour without a word beside it is a colour
 * somebody has to guess at.
 */
/* ── Named for what it is, after it ate every form on the site ──────────────
   This was called .stack, which is also the class every FORM uses. The rule
   form.stack set display and gap and won on specificity, so the forms still
   laid out — but height 14px, overflow hidden and the panel background came
   through untouched, and every form in the app silently became a 14-pixel
   strip with its inputs clipped out of existence. The mission Settings dialog
   rendered as a bar with three labels and nothing else.
   (No backticks in this comment on purpose: one anywhere in here ends the
   stylesheet's template literal and takes the whole page with it.)
   A shared name is not a shared meaning. This one is the money bar. */
.moneybar { display: flex; height: 14px; border-radius: 7px; overflow: hidden;
         background: var(--panel-2); margin-top: 12px; gap: 2px; }
.moneybar > span { display: block; height: 100%;
                /* A real number is never invisible. $1.09 against a $500 budget
                   is a fifth of a per cent — sub-pixel, and a segment that
                   rounds to nothing reads as money that is not there. */
                min-width: 3px; }
.moneybar .settled { background: var(--accent); }
.moneybar .committed { background: var(--warn); }
.moneybar .open { background: var(--alert); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; font-size: 12.5px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.legend i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }

.fltrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
           margin: 0 0 10px; }
.fltcount { margin: -4px 0 12px; }
.fltrow .grow { flex: 1 1 0; min-width: 0; }
.fltrow .chips { flex: 0 1 auto; }
/* The count of what is on, on the control itself, so a collapsed panel is
   never silently filtering. */
.fltn { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 8px;
        background: var(--accent-soft); color: var(--ink); font-family: var(--mono);
        font-size: 11px; }
/* The switcher stays on a phone. List versus tiles is MORE useful on a small
   screen, not less — tiles are how you scan forty products by their pictures. */
.filters input[type=search] { width: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chipgroups { display: grid; gap: 6px; }
/* The shop switcher: the chips, promoted. Same behaviour, tab-sized targets,
   because "which shop am I looking at" is the first question on these pages. */
/* List/grid switcher, and the grid it switches to. The grid restyles the
   SAME cards CSS-only: image on top, facts under it, actions at the foot —
   nothing about what a card says changes with how it is laid out. */
.listtools { display: flex; justify-content: flex-end; margin: 0 0 10px; }
/* The two halves of the mission pop-up. */
.dlgtabs { display: flex; gap: 6px; margin: 2px 0 12px; border-bottom: 1px solid var(--line);
           padding-bottom: 10px; }
.dlgtabs button.on { background: var(--accent-soft); border-color: var(--accent);
                     color: var(--accent); }

/* ── One box, whichever tab is showing ──────────────────────────────────────
   The panels are different heights — a settings form is a fixed set of fields,
   a run history is however long the history is — so switching tabs made the
   window jump and resize under the pointer, which on a long history meant the
   tab you just pressed moved away from where you pressed it.
   A fixed height fixes the frame and lets the CONTENT move instead. Both tabs
   now scroll inside the same box rather than the box growing to fit them. */
.dlgbody { height: min(58vh, 520px); overflow-y: auto; overscroll-behavior: contain;
           /* Room for a scrollbar so text does not shift sideways when one
              tab needs it and the other does not. */
           padding-right: 4px; }

/* ── A card you can press ───────────────────────────────────────────────────
   The whole tile opens the pop-up now, so it has to LOOK pressable and behave
   like a control: a pointer, a lift on hover, and a focus ring for anyone
   arriving by keyboard. The buttons that stay on the card sit above it and
   stop their own clicks, so Pause never opens anything. */
.card.opens { cursor: pointer; }
.card.opens:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.card.opens:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .card.opens:hover { transform: none; } }

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
/* Staged stock: counted, not sellable. Its own colour because it is a third
   state, not a shade of in or out — and a bright one, because it is the hour
   before a drop and the whole point is that it catches your eye. */
.staged { background: var(--alert-bg); color: var(--alert); font-weight: 700; }
/*
 * ── The two disqualifiers ────────────────────────────────────────────────
 *
 * Not the retailer, and not the price. Both are reasons a listing is not the
 * thing we are chasing, and both were being said quietly — one in a muted pill
 * among five others, the other not at all.
 *
 * Filled rather than tinted, on purpose. Every other pill on the card is a
 * status; these two are a warning, and a warning that looks like a status gets
 * read at the same speed as one.
 */
.pill.notshop { background: var(--alert); color: #fff; font-weight: 800; }

/* ── The win ─────────────────────────────────────────────────────────────── */
#win-moment { position: fixed; inset: 0; z-index: 80; display: flex;
              align-items: center; justify-content: center; padding: 20px;
              background: rgba(4, 3, 9, .86); backdrop-filter: blur(6px); }
#win-moment[hidden] { display: none; }
.wincard { position: relative; width: min(440px, 100%); text-align: center;
           padding: 28px 26px 22px; border-radius: 22px;
           background: var(--panel, #0f0d19); border: 1px solid rgba(245, 197, 66, .35);
           box-shadow: 0 0 0 1px rgba(245, 197, 66, .12), 0 30px 90px rgba(0, 0, 0, .7),
                       0 0 120px rgba(245, 197, 66, .18);
           animation: winin .55s cubic-bezier(.2, 1.4, .4, 1) both; }
@keyframes winin { from { transform: scale(.7) translateY(30px); opacity: 0; }
                   to   { transform: none; opacity: 1; } }
.winimg { width: 190px; height: 190px; margin: 0 auto 18px; border-radius: 18px;
          background: #fff; display: flex; align-items: center; justify-content: center;
          overflow: hidden; box-shadow: 0 12px 40px rgba(0, 0, 0, .5); }
.winimg img { max-width: 92%; max-height: 92%; object-fit: contain; }
.winimg:has(img:not([src])) , .winimg:has(img[src=""]) { background: var(--accent-soft); }
.winword { font: 800 44px/1 var(--display); letter-spacing: -.02em;
           text-transform: uppercase; color: #f5c542;
           text-shadow: 0 0 30px rgba(245, 197, 66, .45); margin-bottom: 10px; }
.winname { font: 600 17px/1.3 var(--sans); color: var(--ink); margin-bottom: 6px; }
.winline { font: 500 15px/1.4 var(--sans); color: var(--muted); }
.winline b { color: var(--ink); font-family: var(--mono); }
.winwhen { font: 500 12px/1.4 var(--sans); color: var(--dim); margin: 8px 0 18px; }
.wincard .actions { justify-content: center; }

/* Confetti, in CSS, from a dozen spans. Not a library: it is a burst that
   lasts three seconds and has to work on a phone in a car park. */
.winburst { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.winburst span { position: absolute; top: -12px; width: 9px; height: 14px;
                 border-radius: 2px; opacity: 0;
                 animation: winfall 2.8s ease-in both; }
@keyframes winfall {
  0%   { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(110vh) rotate(720deg); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .wincard { animation: none; }
  .winburst { display: none; }
}
.pill.overmsrp { background: var(--warn); color: #16110a; font-weight: 800; }
.meta.staged { background: none; letter-spacing: 0; text-transform: none; }
/* The grid restyles the same cards; it lives below the rules it overrides so
   the pinned .pill/.right definitions stay the first (and canonical) ones. */
.gridded { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
           gap: 12px; align-items: start; }
.gridded .card { margin-bottom: 0; }
.gridded .row { display: block; }
.gridded .thumb, .gridded .thumb.lg { width: 100%; height: 190px; margin-bottom: 10px; }
.gridded .right { text-align: left; min-width: 0; margin-top: 8px; }
.gridded .empty, .gridded > .card.foldnote { grid-column: 1 / -1; }
/* A pill that is wider than its grid column trims itself rather than
   escaping the card. */
.gridded .pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; display: inline-block; line-height: 22px; }
/* The release radar: a compact calendar of street dates — when things first exist. */
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

/*
 * The art fills its frame.
 *
 * object-fit: contain letterboxed every photo inside its box, and because
 * retailer product shots come on a white ground, what you actually saw was a
 * small white rectangle floating in a dark one with the product small inside
 * THAT. Two nested frames, and the thing you are trying to recognise at a
 * glance was the smallest element of the three.
 *
 * cover crops instead, and crops the right thing: product photography is
 * centred with generous margin, so what goes first is the white surround, not
 * the box. The frames grew too — 60 to 76 in a row, 150 to 190 in a tile —
 * because on a list of forty missions the picture is how you find the one you
 * meant, and it was doing that job at the size of a favicon.
 */
.thumb { width: 76px; height: 76px; border-radius: var(--r-ctl);
         object-fit: cover; object-position: center;
         background: var(--panel-2); border: 1px solid var(--line); flex: 0 0 auto; }
.thumb.ph { display: flex; align-items: center; justify-content: center;
            color: var(--dim); font-size: 20px; }
/* Refused by the retailer, as opposed to never fetched. Different problem. */
.thumb.broken { color: var(--warn); border-color: var(--warn); }
.thumb.lg { width: 104px; height: 104px; }

/* Forms and any other vertical run of controls. */
.stack, form.stack { display: grid; gap: 11px; }
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

/* The front door. Bordered like the quick-add card because it is the same
   kind of thing — a panel that appears, does one job and goes away. */
.wizard { margin-bottom: 16px; border-color: var(--accent); }
.wizhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.wizard .name { font: 700 18px/1.3 var(--display); }
.wizfoot { margin-top: 16px; align-items: center; }
.wizfoot .sub { margin-left: auto; font-family: var(--mono); font-size: 12px; }
.wizard p { margin: 10px 0 0; max-width: 62ch; }
.wizard ul { margin: 10px 0 0; padding-left: 18px; max-width: 62ch; }
.wizard li { margin: 5px 0; }
.wizard .pickable { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                    padding: 9px 0; border-bottom: 1px solid var(--line); }
.wizard .pickable:last-child { border-bottom: none; }
.wizard .pickable .grow { flex: 1 1 0; min-width: 120px; }
.warn-text { color: var(--warn); }
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
/* Two scrollbars for one pop-up is a UI arguing with itself. When the mission
   dialog is showing, the fixed-height panel inside is the thing that scrolls. */
dialog .card:has(.dlgbody) { overflow-y: visible; }
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
<title>Phantom by DNA</title>
<link rel="manifest" href="/manifest.webmanifest?v=6">
<link rel="icon" href="/icon-192-v6.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/icon-192-v6.png">
${FONTS}<style>${STYLE}</style></head>
<body><main class="login">
  <div class="card">
    <h1><span class="mark"></span>Phantom by DNA</h1>
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

/**
 * The vault's door.
 *
 * DNA Card Vault sends a Phantom-tier member here with a 60-second launch
 * token in the URL FRAGMENT — deliberately, because a fragment never reaches
 * any server or any log on either side. This page's one job is to lift it out
 * of location.hash and post it to /api/sso, which sets the same session cookie
 * the login form would. No token, an expired one, or a forged one all land on
 * the same honest message with a way back to the vault.
 */
export function ssoPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phantom by DNA</title>
<link rel="icon" href="/icon-192-v6.png" sizes="192x192" type="image/png">
${FONTS}<style>${STYLE}</style></head>
<body><main class="login">
  <div class="card">
    <h1><span class="mark"></span>Phantom by DNA</h1>
    <p class="sub" id="sso-status" style="margin:6px 0 0">Signing you in from your vault…</p>
    <div class="err" id="sso-err" style="margin:9px 0"></div>
  </div>
<script>
(function () {
  var m = /[#&]token=([^&]+)/.exec(location.hash || '');
  var token = m ? decodeURIComponent(m[1]) : '';
  // Drop the token from the address bar immediately — history is a log too.
  try { history.replaceState(null, '', '/sso'); } catch (e) {}
  var fail = function (text) {
    document.getElementById('sso-status').textContent = 'That sign-in didn’t work.';
    document.getElementById('sso-err').textContent = text +
      ' Open Phantom from your DNA Card Vault membership page to try again.';
  };
  if (!token) { fail('The link carried no sign-in token.'); return; }
  fetch('/api/sso', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token }),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.ok && data.ok) { location.replace('/'); return; }
      fail(data.error || 'The vault’s sign-in could not be verified.');
    });
  }).catch(function () { fail('The server could not be reached.'); });
})();
</script>
</main></body></html>`;
}

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<!--
  The material, decided before the first paint.

  Inline and at the top on purpose: set from a script at the bottom of the
  body and the page renders flat for a beat, then everything lights up at
  once. A flash of the wrong material is worse than not having one.

  Two ways to end up without glass, and both are respected here rather than
  in CSS. A media query on prefers-reduced-transparency FAILS CLOSED — a
  browser that has never heard of the feature treats it as false and drops
  every rule guarded by it, which is how this material worked on a desktop and
  rendered as nothing on a phone. matchMedia fails OPEN: unknown query, no
  match, glass allowed. Somebody who really has asked their system for less
  transparency never gets the attribute, and somebody who turned it off here
  gets their choice back on every load.
-->
<script>
(function () {
  var off = false;
  try { off = localStorage.getItem('phantom.material') === 'plain'; } catch (e) { off = false; }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) off = true;
  } catch (e) { /* an older browser simply has no opinion */ }
  if (!off) document.documentElement.setAttribute('data-material', 'glass');
})();
</script>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Phantom by DNA</title>
<link rel="manifest" href="/manifest.webmanifest?v=6">
<meta name="theme-color" content="#09080e">
<link rel="icon" href="/icon-192-v6.png" sizes="192x192" type="image/png">
<!-- iOS ignores the manifest for the home-screen icon and the status bar. -->
<!-- The version tag is load-bearing: the icons are served immutable, so a
     new drawing under the old URL is a new drawing nobody's phone will ever
     fetch. Bump ?v= whenever the art changes. -->
<link rel="apple-touch-icon" href="/icon-192-v6.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Phantom">
${FONTS}<style>${STYLE}</style></head>
<body><div class="shell">
  <!-- ── The sidebar ───────────────────────────────────────────────────────
       One list of items, drawn two ways: a rail on a browser, matching DNA
       Card Vault, that collapses to icons; and a bottom bar on a phone, where
       the thumb is. The drawer that briefly replaced the bar was a tap in
       front of every tap and lasted one evening.

       Grouped, because seven flat items is a list and four-plus-two is a
       shape: the first group is what the machine is doing, the second is what
       is waiting on a person, and Settings sits apart at the bottom where it
       is not in the way of either. -->
  <nav class="tabs" id="nav" aria-label="Sections">
    <div class="navtop">
      <div class="brand"><span class="mark"></span><span class="brand-name"><b>Phantom</b> <i>by DNA</i></span></div>
      <button class="navtoggle" id="nav-collapse" type="button"
              aria-label="Collapse the menu" title="Collapse the menu">${ICONS.menu}</button>
    </div>
    <button class="tab on" data-tab="home" title="Dashboard">${ICONS.home}<span class="lbl">Dashboard</span></button>
    <button class="tab" data-tab="missions" title="Missions">${ICONS.missions}<span class="lbl">Missions</span><span class="count" id="c-missions"></span></button>
    <button class="tab" data-tab="products" title="Products">${ICONS.products}<span class="lbl">Products</span><span class="count" id="c-products"></span></button>
    <button class="tab" data-tab="activity" title="Activity">${ICONS.activity}<span class="lbl">Activity</span><span class="count" id="c-activity"></span></button>
    <div class="navgroup"><span>Waiting on you</span></div>
    <button class="tab" data-tab="finds" title="Discovery">${ICONS.finds}<span class="lbl" id="finds-tab-label">Discovery</span><span class="count" id="c-finds"></span></button>
    <button class="tab" data-tab="wins" title="Wins">${ICONS.wins}<span class="lbl">Wins</span><span class="count" id="c-vault"></span></button>
    <div class="navspacer"></div>
    <button class="tab" data-tab="settings" title="Settings">${ICONS.settings}<span class="lbl">Settings</span></button>
  </nav>
<main>
  <header>
    <!-- The wordmark on a phone. The side panel carries it on a browser; a
         bottom bar cannot spare the width, and a nameless app is a worse
         trade than a header line. -->
    <div class="brand phonebrand"><span class="mark"></span><span class="brand-name"><b>Phantom</b> <i>by DNA</i></span></div>
    <div>
      <span class="sub" id="summary">loading…</span>
    </div>

    <!-- ── The ribbon ─────────────────────────────────────────────────────
         Four controls, each with something real behind it. Nothing here is
         decoration: the bell is built from rows this page already has, the
         Discord button is hidden until somebody sets an invite, and Feedback
         is hidden unless there is a webhook for it to reach. An icon that
         does nothing is the same lie as a lever attached to nothing. -->
    <!-- ── One row, not three ─────────────────────────────────────────────
         This was a header line, then a toolbar under it, and then a ribbon
         opposite the toolbar — so "Sign out" ended up floating under the bell
         with nothing around it. Six controls went to Settings and the profile
         menu; the one thing you do FROM a list is adding a product, so it is
         the only action left out here, and it lives in the same row as
         everything else that is not content. -->
    <div class="ribbon">
      <button id="add-open" class="primary">Add product</button>
      <a id="discord-link" class="rib" hidden target="_blank" rel="noreferrer"
         title="Open the Discord">${ICONS.discord}</a>
      <button id="bell-open" class="rib" title="What needs you" aria-expanded="false">
        ${ICONS.bell}<span class="dot" id="bell-dot" hidden></span>
      </button>
      <button id="me-open" class="rib avatar" title="You" aria-expanded="false">
        <span id="me-initial">·</span>
      </button>
    </div>

    <!-- Both panels hang off the ribbon and close on any click outside. -->
    <div class="pop" id="bell-pop" hidden>
      <div class="pop-head">What needs you</div>
      <div id="bell-list"></div>
    </div>
    <div class="pop" id="me-pop" hidden>
      <!-- Identity, then what this account may do, then what it has actually
           done. Every number below is this account's own. -->
      <div class="me-top">
        <span class="rib avatar" id="me-face" aria-hidden="true">·</span>
        <div class="grow">
          <div class="me-name" id="me-handle"></div>
          <div class="meta" id="me-since"></div>
        </div>
        <span class="who" id="who"></span>
      </div>
      <div class="me-rights" id="me-rights"></div>
      <div class="me-stats" id="me-stats"></div>
      <div class="meta" id="me-vault" style="padding:0 12px 12px"></div>
      <button class="popitem" id="wiz-open">How Phantom works</button>
      <button class="popitem" id="me-settings">Settings</button>
      <button class="popitem" id="install" hidden>Install the app</button>
      <a class="popitem" href="/logout">Sign out</a>
    </div>
  </header>

  <!-- ── The front door ──────────────────────────────────────────────────
       Shown when there is nothing to show, and re-openable from the header
       afterwards. Everything else on this page assumes you already know what
       it is for; somebody arriving from the vault does not, and an empty
       dashboard tells them nothing except that it is empty.

       Deliberately not a modal, and skippable on every step: a wizard you
       cannot get out of is a wizard people learn to click through. -->
  <div class="card wizard" id="wizard" hidden>
    <div class="wizhead">
      <div class="name" id="wiz-title"></div>
      <button type="button" class="small" id="wiz-close">Skip</button>
    </div>
    <div id="wiz-body"></div>
    <div class="actions wizfoot">
      <button type="button" class="small" id="wiz-back">Back</button>
      <button type="button" class="primary" id="wiz-next">Next</button>
      <span class="sub" id="wiz-step"></span>
    </div>
  </div>

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

  <!-- A live grant is money committed: a buy in progress, or a Phantom that
       died mid-checkout. Both deserve the top of the page. Releasing is the
       recovery path for the second one — after a look at the orders page,
       because a grant nobody resolved means nobody knows whether money moved. -->
  <div class="card banner warn" id="money-banner" hidden>
    <div class="name">Money is committed</div>
    <div class="meta" id="money-banner-detail"></div>
    <div id="money-banner-list"></div>
  </div>

  <!-- Phantom stopped talking.
       On 1 Sep 2026 it died at 19:14 and nobody noticed for thirty-five
       minutes, because a watcher that is OFF looks exactly like a watcher
       whose products have not changed: the readings all stay put and only
       their age moves. This is the one failure the system cannot afford to
       report by omission. -->
  <div class="card banner alert" id="silence-banner" hidden>
    <div class="name">Phantom has stopped reporting</div>
    <div class="meta" id="silence-detail"></div>
  </div>

  <div class="card banner alert" id="paused-banner" hidden>
    <div class="name">Everything is paused</div>
    <div class="meta">
      Phantom is looking at nothing. Turn it back on under Settings → When to watch.
    </div>
  </div>

  <div class="card banner alert" id="queue-banner" hidden></div>

  <!-- A drop with an appointment, and whatever would stop it working.
       Above the load-in banner because a switch that is off ninety minutes
       before a known drop is more urgent than stock arriving in a warehouse:
       one of them you have time to fix, and only if you are told. -->
  <div class="card banner" id="ready-banner" hidden></div>

  <!-- Warehouse stock appearing on a watched listing that had none — hours of
       warning before a scheduled drop turns buyable. Warn, not alert: nothing
       is buyable YET, and the queue banner keeps the louder colour for the
       moment something is. -->
  <div class="card banner warn" id="load-banner" hidden></div>




  <!-- ── The dashboard ────────────────────────────────────────────────────
       One question: where are we losing it? The funnel leads because the
       answer is almost never "the machine is slow" — it is a stage where
       everything stops, and until this existed you had to infer that from a
       log. Machine health sits underneath because it is the second question,
       not the first. -->
  <section id="tab-home">
    <!-- ── The dashboard, as a dashboard ──────────────────────────────────
         It was six full-width cards stacked down a page: money, funnel, a
         loose row of numbers, refusals, the machine, wins. Everything was the
         same size, so nothing was more important than anything else, and the
         one question you open this page to ask — is there anything to buy
         right now — was not on it at all.

         Now: one hero number, a band of stat tiles, and a grid. What is
         BUYABLE leads, because it is the only part you can act on this
         second. Everything below it is history, in decreasing order of how
         often it changes what you do. -->
    <div class="fltrow">
      <div class="chips" id="range-chips"></div>
      <span class="grow"></span>
      <span class="sub" id="range-note"></span>
    </div>

    <div class="dash">
      <!-- The hero. Exactly one per view, and it is the thing you came for. -->
      <div class="card span2" id="live-card">
        <div class="wizhead">
          <div class="livehead">
            <div class="hero" id="live-n">—</div>
            <div>
              <div class="livetitle" id="live-title">In stock</div>
              <div class="herolabel" id="live-label">buyable right now</div>
            </div>
          </div>
          <button type="button" class="small" id="live-all">See the watchlist</button>
        </div>
        <div id="live-list"></div>
      </div>

      <div class="card span2"><div class="kpis" id="home-kpis"></div></div>

      <div class="card" id="funnel-card">
        <!-- Named for what it shows. "Where it goes" was a heading that
             assumed you already knew what "it" was and where "there" was. -->
        <div class="name">From watching to bought</div>
        <div class="sub" id="funnel-sub"></div>
        <div id="funnel"></div>
        <div id="funnel-verdict"></div>
      </div>

      <!-- Money: three numbers, because "spent" is not one thing. An order is
           paid, a pre-order is owed, and a grant nobody resolved is neither. -->
      <div class="card" id="money-card">
        <div class="wizhead">
          <div class="name">The money</div>
          <span class="sub" id="money-budget"></span>
        </div>
        <div class="kpis" id="money-kpis"></div>
        <div id="money-bar"></div>
        <div id="money-upcoming"></div>
      </div>

      <div class="card">
        <div class="name">Why it did not buy</div>
        <div class="sub">Every run that ended in something other than an order, in its own words.</div>
        <div id="refusals"></div>
      </div>

      <div class="card">
        <div class="name">The machine</div>
        <div class="sub">Is it running, and how fast does it read a page?</div>
        <div class="kpis" id="health-kpis"></div>
        <div id="speed"></div>
      </div>

      <div class="card span2" id="wins-preview">
        <div class="wizhead">
          <div class="name">Latest wins</div>
          <button type="button" class="small" id="see-wins">See all</button>
        </div>
        <div id="wins-preview-list"></div>
      </div>
    </div>
  </section>

  <section id="tab-missions" hidden>
    <!-- Twelve chips in three groups was six rows on a phone, before any
         content and under three rows of buttons. The shop is the lens people
         actually use — which shop am I looking at — so it stays out. Status
         and mode go behind one control that says how many are on, and an
         active one is pulled back out where it can be seen and cleared: a
         filter that is hiding rows while hiding ITSELF is how somebody
         concludes the app is broken. -->
    <!-- Always present: the shop lens, the way into the rest, and the view
         switcher. It is one row, and it used to be four. -->
    <div class="fltrow">
      <div class="chips" id="flt-missions-shops"></div>
      <!-- Armed, watching, paused. These lived behind the Filters button and
           should not have: "which of these is switched on" is asked as often as
           "which shop", and a control you have to go looking for is a control
           that gets asked for again. Empty ones are omitted rather than dimmed
           so the row cannot grow on an account that has none of them. -->
      <div class="chips" id="flt-missions-modes"></div>
      <button type="button" class="small" id="flt-missions-more" aria-expanded="false" hidden>Filters</button>
      <div class="chips" id="flt-missions-active"></div>
      <span class="grow"></span>
      <div class="vt" data-list="missions"><button type="button" data-view="list" title="List view">☰</button><button type="button" data-view="grid" title="Grid view">▦</button></div>
    </div>
    <div class="filters" id="flt-missions" hidden>
      <div class="chipgroups" id="flt-missions-chips"></div>
      <input type="search" id="flt-missions-q" placeholder="Search missions"
             autocomplete="off" autocapitalize="off" spellcheck="false">
    </div>
    <div class="sub fltcount" id="flt-missions-count"></div>
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

  <!-- ── One tab, two jobs ──────────────────────────────────────────────────
       For a curator this is the sweep's decision queue: keep it or forget it.
       For a member it is where the links they sent in went. Both belong on the
       same tab because both answer "what is coming into the catalogue" — they
       just answer it from opposite ends.
       The queue itself is hidden from a member rather than shown with dead
       buttons. Keep and Forget were rendered for everyone and refused by the
       server for anybody without curation rights, so a member's Discovery tab
       was a page of controls that threw errors. -->
  <section id="tab-finds" hidden>
    <h2 style="margin-top:0" id="finds-head">Discovery — what the sweep turned up</h2>
    <p class="sub" style="margin:-6px 0 14px" id="finds-blurb">
      <strong>Keep</strong> starts watching it. <strong>Forget</strong> is
      remembered, so it is never offered again. Neither arms anything.
    </p>
    <!-- What is coming, whoever you are: a fact about the world rather than a
         decision, so it stays for members. -->
    <div class="card radar" id="release-radar" hidden></div>
    <div class="card" id="requests-card" hidden></div>
  <div class="listtools" id="finds-tools"><div class="vt" data-list="finds"><button type="button" data-view="list" title="List view">☰</button><button type="button" data-view="grid" title="Grid view">▦</button></div></div>
    <div class="filters" id="finds-filters">
      <div class="chips seg" id="find-shops"></div>
      <input type="search" id="find-q" placeholder="Search discoveries"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="chips" id="find-states"></div>
      <div class="sub" id="find-count"></div>
    </div>
    <div id="finds-list"></div>
  </section>

  <!-- Wins and the vault queue are the same list seen twice: everything here
       is a checkout the retailer's own page confirmed. Splitting them into two
       tabs would have meant two names for one event and an eighth item in a
       bottom bar that is already tight at seven. -->
  <section id="tab-wins" hidden>
    <h2 style="margin-top:0">Wins</h2>
    <p class="sub" style="margin:-6px 0 16px">
      Every order a retailer's own page confirmed. Never a click that only
      seemed to work.
    </p>
    <div id="wins-summary" class="kpis"></div>
    <div id="wins-list"></div>

    <h2 style="margin-top:26px">On their way to your vault</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Confirm which vault product it is — once per product — and
      <strong>Send</strong> files it in DNA Card Vault at its real cost basis.
    </p>
    <div id="acq-list"></div>
  </section>

  <section id="tab-settings" hidden>
    <h2 style="margin-top:0">Appearance</h2>
    <p class="sub" style="margin:-6px 0 14px">
      A look, not a setting. Remembered on this device only.
    </p>
    <div class="card">
      <label class="check"><input type="checkbox" id="material-toggle"> Liquid glass</label>
      <div class="meta" style="margin-top:8px" id="material-note"></div>
    </div>

    <h2>This page</h2>
    <div class="card">
      <div class="row">
        <div class="grow">
          <label class="check"><input type="checkbox" id="auto" checked> Refresh automatically every 30 seconds</label>
          <div class="meta" style="margin-top:6px">
            Phantom keeps checking either way. This is only the page.
          </div>
        </div>
        <button id="refresh" type="button">Refresh now</button>
      </div>
    </div>

    <p class="sub" id="member-note" style="margin:-2px 0 18px" hidden>
      The rest of this page configures the machine that does the watching and
      the money it may spend. That machine is not yours, so it is not shown.
    </p>

    <!-- ── The machine, and the money ─────────────────────────────────────
         Everything from here down commands somebody's agent or spends
         somebody's card: Phantom on and off, the sweep, watching hours, drop
         windows, which shops, the spend cap, the Discord webhook, the
         diagnostics of a machine you may not have.

         A member sees none of it. Not greyed out — absent. A disabled control
         still says "this is yours, and it is broken"; an absent one says the
         truth, which is that it belongs to someone else. -->
    <div id="machine-settings">
    <h2>Phantom</h2>
    <div class="card">
      <div class="row">
        <div class="grow">
          <div class="name" id="phantom-state">Phantom</div>
          <div class="meta" style="margin-top:6px">
            Off stops all checking. Everything picks up where it left off.
          </div>
        </div>
        <button id="phantom-toggle">Turn Phantom off</button>
      </div>
    </div>
    <div class="card" style="margin-top:10px">
      <div class="row">
        <div class="grow">
          <div class="name">Catalogue sweep</div>
          <div class="meta" style="margin-top:6px">
            Looks for products we have never seen and puts them in Discovery.
            Runs on its own schedule; this asks for one now.
          </div>
        </div>
        <button id="sweep-now">Run catalogue sweep</button>
      </div>
    </div>

    <h2>Alerts</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Drops open at three in the morning. These reach you when the page is shut.
    </p>
    <div class="card">
      <div class="row">
        <div class="grow">
          <div class="name">Discord</div>
          <div class="meta" id="discord-state">Checking…</div>
        </div>
        <button id="discord-preview" type="button">Preview an in-stock alert</button>
        <button id="discord-test" type="button">Send a test message</button>
      </div>
      <div class="meta" id="discord-result" style="margin-top:8px" hidden></div>
    </div>

    <h2>What is true of every mission</h2>
    <p class="sub" style="margin:-6px 0 14px">
      A ceiling is per unit and covers tax. Shipping is per order, so it gets
      its own allowance here.
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
          <label class="f">Total budget
            <span class="hint">the pot this is working against — reads only, stops nothing</span>
            <input type="number" name="budgetTotal" step="0.01" min="0" placeholder="unset">
          </label>
          <label class="f">Sweep for new products every
            <span class="hint">hours — how often the catalogues are re-read</span>
            <input type="number" name="sweepEveryHours" step="1" min="1" placeholder="24">
          </label>
        </div>
        <p class="sub" style="margin:0">
          A tax rate of 0 judges the listed price as it stands and checks the
          real tax in the cart. A shipping allowance of 0 means postage must be
          free.
        </p>
        <div class="actions">
          <button type="submit" class="primary">Save settings</button>
          <span class="msg" id="settings-msg"></span>
        </div>
      </form>
    </div>

    <h2>When to watch</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Traffic spent on a quiet afternoon is what earns a challenge at three in
      the morning. Leave both blank to watch around the clock.
    </p>
    <div class="card">
      <form class="stack" id="hours-form">
        <label class="f" style="flex-direction:row; align-items:center; gap:9px">
          <input type="checkbox" name="paused" style="width:auto; margin:0">
          <span>Pause everything</span>
        </label>
        <p class="sub" style="margin:-6px 0 4px">
          The master switch. Stops all watching without unpicking a mission.
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
          <span class="hint">e.g. America/Chicago — blank uses Phantom's own clock</span>
          <input type="text" name="timezone" placeholder="">
        </label>
        <p class="sub" style="margin:0">
          Two things wake it regardless: <strong>Check now</strong> on a card,
          and a product releasing today.
        </p>
        <div class="actions">
          <button type="submit" class="primary">Save hours</button>
          <span class="msg" id="hours-msg"></span>
        </div>
      </form>
    </div>

    <h2>Which shops, and how hard</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Off means no checks and no sweeps for that shop. A drop window tightens
      the gap between checks, then closes itself.
    </p>
    <div class="card">
      <form class="stack" id="shops-form">
        <div class="chips" id="shop-toggles"></div>
        <div class="grid2">
          <label class="f">Drop-window spacing
            <span class="hint">seconds between checks while a window is open — blank or 0 keeps the ordinary 20s</span>
            <input type="number" name="burstSpacingSeconds" step="1" min="5" max="60" placeholder="0">
          </label>
          <label class="f">Repeat the load-in alert
            <span class="hint">minutes between reminders while stock sits staged — 0 says it once</span>
            <input type="number" name="stagedRepeatMinutes" step="5" min="0" max="1440" placeholder="0">
          </label>
          <label class="f">Discord invite
            <span class="hint">the link people join with — https://discord.gg/… — blank hides the button</span>
            <input type="url" name="discordInvite" placeholder="https://discord.gg/…"
                   autocomplete="off" spellcheck="false" maxlength="200">
          </label>
          <label class="f">Follow up on in-stock after
            <span class="hint">minutes after the first post, comma separated — "30" sends two posts in all, "30, 60" sends three. Blank says it once.</span>
            <input type="text" name="inStockRepeatAfter" placeholder="30" autocomplete="off"
                   spellcheck="false" maxlength="60">
          </label>
          <label class="f">Open a drop window for
            <span class="hint">it closes itself when the time is up</span>
            <select id="drop-minutes">
              <option value="30">30 minutes</option>
              <option value="60" selected>1 hour</option>
              <option value="120">2 hours</option>
              <option value="240">4 hours</option>
            </select>
          </label>
        </div>
        <p class="sub" style="margin:0" id="drop-state"></p>
        <div class="actions">
          <button type="submit" class="primary">Save shops</button>
          <button type="button" id="drop-open">Open a drop window now</button>
          <button type="button" id="drop-close" hidden>Close it</button>
          <span class="msg" id="shops-msg"></span>
        </div>
      </form>
    </div>

    <h2>Diagnostics</h2>
    <p class="sub" style="margin:-6px 0 14px">
      Every check is written down, the ones that worked as well as the ones
      that did not.
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
        <strong>Not in it:</strong> your token, password, address, postcode,
        email, account name, or the visitor id Target puts in its URLs — those
        are stripped on your own machine, and stripped again here on the way
        out. Nothing leaves until you press the button.
      </p>
    </div>
    </div>
  </section>
  <!-- ── The win ───────────────────────────────────────────────────────────
       The one moment everything else on this page exists to produce, and
       until now it was a row in a table. This takes the whole screen once,
       for each confirmed order, on the device that first sees it. It is
       dismissed by hand rather than on a timer: a thing worth celebrating is
       worth the second it takes to close it. -->
  <div id="win-moment" hidden>
    <div class="winburst" aria-hidden="true"></div>
    <div class="wincard" role="dialog" aria-labelledby="win-title">
      <div class="winimg"><img id="win-img" alt=""></div>
      <div class="winword" id="win-title">Bought</div>
      <div class="winname" id="win-name"></div>
      <div class="winline" id="win-line"></div>
      <div class="winwhen" id="win-when"></div>
      <div class="actions">
        <button type="button" class="primary" id="win-open">See it in Wins</button>
        <button type="button" id="win-close">Close</button>
      </div>
    </div>
  </div>
  <dialog id="add-dialog">
    <div class="card">
      <h3>Add a product</h3>
      <p class="sub" style="margin:-4px 0 12px">
        The thing itself. Only the name is needed — everything else can wait,
        or be filled in from the page once Phantom reads it.
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

/** A date a person can read, without a time nobody needs. */
function shortDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

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
/**
 * Days until this product's RELEASE — its street date, when the expansion
 * first exists on the market at all.
 *
 * ── Release is not a drop ────────────────────────────────────────────────────
 *
 * Two different events, and this system needs both, so the words are kept
 * apart deliberately:
 *
 *   RELEASE  the publisher's street date. Happens ONCE per product, is known
 *            weeks ahead, and is what pre-orders are timed against. Answers
 *            "does this thing exist to buy yet?"
 *   DROP     a retailer putting stock up. Happens MANY times per product, in
 *            many forms — launch-day allocation, a midnight restock, a
 *            quiet reload — and is never announced. Answers "can I buy one
 *            right now?", and is what staged stock and waiting rooms warn of.
 *
 * A product releases once and drops forever after. Calling a street date a
 * "drop" made the card say DROPS TODAY on a release day that carried no stock,
 * and left us with no word at all for the 2am restock that is most of what we
 * are actually hunting.
 */
function releasesIn(m) {
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
 * checked, means Phantom looked and came back with nothing. That is a
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
    ph.title = 'no image yet — Phantom fills this in on its first read';
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

/*
 * Which half of the mission pop-up is showing. Kept outside DETAIL so the
 * thirty-second refresh, which rebuilds the panel, does not throw you back to
 * the first tab while you are reading the second.
 */
let DETAIL_TAB = 'settings';

function openDetail(kind, key, tab) {
  // Both halves of a mission live in one pop-up now, so the old two entry
  // points become one plus a starting tab.
  if (kind === 'mission-runs') { kind = 'mission'; tab = 'runs'; }
  if (kind === 'mission') DETAIL_TAB = tab || 'settings';
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
  if (!force && DETAIL.kind === 'mission' && DETAIL_TAB === 'runs') return;
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');
  if (DETAIL.kind === 'mission') {
    const m = DATA.missions.find((x) => x.id === DETAIL.key);
    // The thing this pop-up was about can vanish under it — deleted from
    // another device, say. A dialog about nothing closes rather than lying.
    if (!m) { closeDetail(); return; }
    title.textContent = shortName(m.productName);
    body.textContent = '';

    /*
     * Two tabs, one pop-up.
     *
     * They were two buttons on every card, which is two controls per row for
     * two questions asked at different times — "change how this is watched"
     * and "what has it done". The card itself is now the way in, so the
     * choice moves inside, where it costs nothing and neither answer has to
     * be walked past to reach the other.
     */
    const tabs = el('div', 'dlgtabs');
    const bodyIn = el('div', 'dlgbody');
    const pick = (name, label) => {
      const b = el('button', 'small' + (DETAIL_TAB === name ? ' on' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-selected', String(DETAIL_TAB === name));
      b.addEventListener('click', () => {
        if (DETAIL_TAB === name) return;
        DETAIL_TAB = name;
        renderDetail(true);
      });
      return b;
    };
    tabs.append(pick('settings', 'Settings'), pick('runs', 'Run history'));
    bodyIn.appendChild(DETAIL_TAB === 'runs' ? missionRunsPanel(m) : missionPanel(m));
    body.append(tabs, bodyIn);
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

/**
 * Stock that EXISTS but cannot be bought yet.
 *
 * Three states, not two, and the middle one is the whole point. "0 available"
 * and "8 available" were the only things this card could say, which collapsed
 * a genuinely different situation into one of them: units sitting in the
 * warehouse against a listing the site still refuses to sell. That is what a
 * scheduled drop looks like in the hours before it goes live — measured 1 Sep
 * 2026, when a competitor read 30,000 units at 11:34pm for a 3am drop — and
 * calling it "30000 available" would be a lie you could act on, while calling
 * it "0 available" throws away the best warning Target gives.
 *
 * So: staged means counted and not yet sellable. It is the same fact the
 * STOCK LOADED alarm fires on, said in the standing state of the card rather
 * than as a one-off event.
 */
function isStaged(r) {
  const q = r.availableQuantity;
  return q !== null && q !== undefined && q > 0 && r.state !== 'in';
}

/**
 * The count, in words that say which of the three it is.
 *
 * The plus carries its own meaning: Target's figure is a real number below a
 * ceiling and a ceiling above it (0, 8, 9, 10, 14, 18, 20 across every reading
 * so far, 10 and 20 far too often to be chance), so "20" means at least twenty
 * and "9" means nine. Which makes it precise exactly when it matters: as a
 * drop is eaten the number falls under the ceiling and starts telling truth.
 */
/**
 * Is this number a count, or a ceiling wearing a number costume?
 *
 * Settled by measurement on 2 Sep 2026. Walking every captured Target response
 * for nodes that state BOTH the promise count and the per-order purchase
 * limit, there are four, and in all four they are the same number:
 *
 *   tcin 1008749492  atp 20  limit 20        tcin 1001539762  atp 10  limit 10
 *   tcin 1004990536  atp 20  limit 20        tcin 1001539813  atp 10  limit 10
 *
 * So the published count is clamped to the limit, and landing exactly on it
 * means AT LEAST that many. Counts that sit below any ceiling do occur - 8, 9,
 * 14, 18 all appear - and those are real figures, printed plainly.
 *
 * The obvious next thought was that some other endpoint knows the true number,
 * since other trackers quote precise ones. Probed it: a same-origin fetch from
 * inside a real page on a real session to product_fulfillment_v1 returned atp
 * 10 for a listing the page also called 10, and pdp_fulfillment_v1 answered
 * 410 Gone. There is no less-clamped number to go and get. What we can do is
 * stop printing a ceiling as though it were a census.
 *
 * When no limit came back, fall back to the two values that ceiling has always
 * worn. A measurement beats a guess, and a guess beats saying nothing.
 */
function isCapped(r) {
  const q = r.availableQuantity;
  if (q === null || q === undefined || q <= 0) return false;
  const lim = r.orderLimit;
  if (lim !== null && lim !== undefined && lim > 0 && q === lim) return true;
  return q === 10 || q === 20;
}

/** Said in full on hover, because the plus is doing a lot of work. */
function stockWhy(r) {
  if (!isCapped(r)) return 'Counted by the retailer, and below its per-order limit, so this is the actual figure.';
  return 'A floor, not a count: the retailer publishes this number clamped to its own per-order limit, so there are at least this many and possibly a pallet. Measured 2 Sep 2026 - the fulfillment endpoint returns the same clamped number as the page, so no more precise figure exists to fetch.';
}

function stockLine(r) {
  const q = r.availableQuantity;
  if (q === null || q === undefined) return '';
  const n = isCapped(r) ? q + '+' : String(q);
  if (isStaged(r)) return n + ' staged · not sellable yet';
  return n + ' available';
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
    // Loud, and next to the "out of stock" it qualifies: the site says no, and
    // the warehouse says otherwise. This is the hour to be awake.
    if (isStaged(m)) {
      flags.appendChild(el('span', 'pill staged', 'STOCK STAGED · DROP NEAR'));
    }
  }

  if (!m.enabled) flags.appendChild(el('span', 'pill s-out', 'paused'));
  if (m.armed) {
    flags.appendChild(el('span', 'pill flag',
      'ARMED · ' + m.quantity + ' @ ' + money(m.ceiling)));
  } else if (m.enabled) {
    flags.appendChild(el('span', 'pill info', 'watching only'));
  }
  /*
   * ── Not the shop, and not the price ──────────────────────────────────────
   *
   * The Walmart trap, said in the loudest words the card has. A listing whose
   * buy box has fallen to a reseller is not a smaller version of the thing we
   * want — it is the thing we are racing, and every mission refuses it. The
   * old pill said "marketplace: <name>", which reads as a label; this one
   * leads with the retailer's name and the word NOT, because that is the fact.
   */
  if (m.sellerKind === 'marketplace') {
    flags.appendChild(el('span', 'pill notshop',
      'NOT ' + (m.retailer || 'the shop') + ' · ' + (m.sellerName || 'third-party seller')));
  } else if (m.sellerKind === 'unknown' && m.state === 'in') {
    // Unknown is refused too. judge() asks whether the seller IS the retailer,
    // not whether it is a marketplace, so anything it cannot identify is
    // declined — and the card must not imply otherwise.
    // (No backticks in here: this comment lives inside a template literal, and
    //  one backtick ends the whole script. It has cost an evening before.)
    flags.appendChild(el('span', 'pill notshop', 'SELLER UNKNOWN'));
  }
  /*
   * And what it costs against what it should cost.
   *
   * Shown whenever we have both numbers and the price is meaningfully over,
   * regardless of seller: a retailer can price above MSRP too, and the point
   * of the pill is the gap rather than who opened it. Five per cent of slack
   * before it fires, so a $59.99 box listed at $60.49 is not called out as a
   * markup.
   */
  if (m.price !== null && m.price !== undefined && m.msrp > 0) {
    const over = (m.price - m.msrp) / m.msrp;
    if (over > 0.05) {
      flags.appendChild(el('span', 'pill overmsrp',
        'OVER MSRP · +' + Math.round(over * 100) + '% · ' + money(m.msrp) + ' list'));
    }
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
  const release = releasesIn(m);
  if (release !== null) {
    flags.appendChild(el('span', 'pill flag',
      release === 0 ? 'RELEASES TODAY' :
      release === 1 ? 'releases tomorrow' :
      'releases in ' + release + ' days · ' + m.releaseDate));
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
    // ── Check now, and what it is honestly waiting on ─────────────────────
    //
    // This used to become a dead pill reading "check queued" and stay that
    // way, sometimes for minutes. Two things were wrong and only one of them
    // was the machine: Phantom asked the Hub once a cycle (fixed — it asks
    // every three seconds now), and the page then said nothing at all about
    // what was happening.
    //
    // A button that goes quiet is indistinguishable from a broken one. So it
    // counts, and past a point where the count is no longer normal it says
    // what it is actually waiting for — which, nine times out of ten, is a
    // machine that is not running.
    const now = el('button', 'small', 'Check now');
    if (m.checkNow) {
      const since = m.checkNowAt ? Math.round((Date.now() - new Date(m.checkNowAt).getTime()) / 1000) : 0;
      const heard = DATA.agentSeenAt ? Date.now() - new Date(DATA.agentSeenAt).getTime() : null;
      const running = heard !== null && heard < 3 * 60 * 1000;
      now.disabled = true;
      now.textContent = !running
        ? 'waiting — Phantom is not running'
        : since < 15
          ? 'checking…'
          : 'checking… ' + since + 's';
      if (!running) now.classList.add('stale');
    }
    now.addEventListener('click', async (e) => {
      const ok = await withButton(e.target, 'Asking…', null, async () => {
        await api('POST', '/api/missions/' + m.id + '/check-now');
        return 'asked — Phantom picks this up within a few seconds';
      });
      if (ok) { e.target.textContent = 'checking…'; e.target.disabled = true; load(); }
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
  // Because it is a ceiling. Target clamps available_to_promise_quantity to
  // the per-order purchase limit — measured, not guessed: the two fields carry
  // the same values in every captured response. The plus is put on by
  // isCapped(), and hovering the line says so in full.
  //
  // Which makes it precise exactly when it matters: as a drop is eaten the
  // number falls under the ceiling and starts telling the truth.
  // Three answers, not two — see stockLine(). Staged stock is the pre-drop
  // tell and gets said as such rather than being rounded to one of the others.
  const stock = stockLine(m);
  if (stock) {
    const stockEl = el('div', isStaged(m) ? 'meta staged' : 'meta', stock);
    stockEl.title = stockWhy(m);
    right.appendChild(stockEl);
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
  /*
   * The card is the way in.
   *
   * It carried a Settings button and a Run history button — two controls on
   * every row for two questions asked at different moments. Pressing the thing
   * itself is what people try first, and it leaves the row with only the
   * control that changes something without opening anything.
   *
   * Clicks from real controls are ignored: a press on Pause, on a link, or on
   * anything inside the actions row must do its own job and nothing else.
   */
  card.classList.add('opens');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', 'Open ' + shortName(m.productName));
  const opens = (e) => {
    if (e.target.closest('button, a, input, select, textarea, label')) return;
    openDetail('mission', m.id);
  };
  card.addEventListener('click', opens);
  card.addEventListener('keydown', (e) => {
    // Enter and Space, because that is what a role=button promises.
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target !== card) return;
    e.preventDefault();
    openDetail('mission', m.id);
  });

  /*
   * Pausing on the card, without opening anything.
   *
   * This was two clicks and a dialog to change one boolean, and it is the
   * boolean people change most: a drop is over, an item is a mistake, a shop
   * is being noisy tonight. Everything else in that dialog is a decision about
   * money and belongs behind a deliberate step. This is not.
   *
   * The POST carries the mission's other fields unchanged because the endpoint
   * takes a whole mission. Sending only the enabled flag would quietly reset a
   * ceiling somebody set — which is the kind of helpfulness that costs money.
   */
  const toggle = el('button', 'small', m.enabled ? 'Pause' : 'Resume');
  if (!m.enabled) toggle.className = 'small primary';
  toggle.title = m.enabled
    ? 'Stop checking this listing. Nothing else changes.'
    : 'Start checking this listing again on its schedule.';
  toggle.addEventListener('click', async () => {
    const was = toggle.textContent;
    toggle.disabled = true;
    toggle.textContent = m.enabled ? 'Pausing…' : 'Resuming…';
    try {
      await api('POST', '/api/missions', {
        listingId: m.listingId,
        label: m.label,
        enabled: !m.enabled,
        armed: m.armed,
        alerts: m.alerts,
        ceiling: m.ceiling,
        quantity: m.quantity,
        sellerPolicy: m.sellerPolicy,
        preOrderPolicy: m.preOrderPolicy,
        checkEverySeconds: m.checkEverySeconds,
      });
      load();
    } catch (err) {
      toggle.textContent = was;
      toggle.disabled = false;
    }
  });

  const acts = el('div', 'actions');
  acts.style.marginTop = '12px';
  acts.append(toggle);

  /*
   * Disarming is one click. Arming is not, and that asymmetry is deliberate.
   *
   * Taking away permission to spend can never be the wrong thing to do by
   * accident. GRANTING it beside a "Pause" button, on a list you scroll with
   * your thumb, is a misclick that buys something. Arming stays in Settings
   * where the ceiling and the quantity are on screen next to the tick.
   */
  if (m.armed) {
    const disarm = el('button', 'small', 'Disarm');
    disarm.title = 'Keep watching, but stop it buying without asking.';
    disarm.addEventListener('click', async () => {
      disarm.disabled = true;
      disarm.textContent = 'Disarming…';
      await api('POST', '/api/missions', {
        listingId: m.listingId,
        label: m.label,
        enabled: m.enabled,
        armed: false,
        alerts: m.alerts,
        ceiling: m.ceiling,
        quantity: m.quantity,
        sellerPolicy: m.sellerPolicy,
        preOrderPolicy: m.preOrderPolicy,
        checkEverySeconds: m.checkEverySeconds,
      }).catch(() => {});
      load();
    });
    acts.append(disarm);
  }

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
    <label class="check"><input type="checkbox" name="alerts"> Post this one to Discord</label>
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
  // Absent on an older Hub means it was announcing, so default it on rather
  // than presenting an unticked box that silently mutes on the next save.
  q('alerts').checked = m.alerts !== false;
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
          alerts: f.alerts,
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
  // The Hub has no browser, and Phantom will not jump the retailer's
  // pacing for a button click, so anything promising "checking now" would be
  // making a claim neither of them can keep.
  const checkNow = form.querySelector('[data-act=check-now]');
  if (m.checkNow) checkNow.textContent = 'Test run queued';
  checkNow.addEventListener('click', async (e) => {
    const ok = await withButton(e.target, 'Queueing…', msg, async () => {
      await api('POST', '/api/missions/' + m.id + '/check-now');
      return 'queued — Phantom will check this on its next pass';
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

  // Declared up here, not beside the form that first used it: the Watch
  // buttons in the table below report through it too, and a member's panel
  // returns before that form is ever built.
  const msg = el('span', 'msg');

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

      // ── Watch this ────────────────────────────────────────────────────────
      //
      // The catalogue is shared, so a listing somebody else curated is one
      // anybody can point a mission at. Until this button existed the only
      // route in was pasting a URL — which, for a member, meant asking for
      // something that was already sitting right there on the page.
      //
      // Never armed. Arming is a separate, deliberate act on the mission
      // itself, and a one-click button next to a price is exactly where it
      // must not live.
      const mine = (DATA.missions || []).find((m) => m.listingId === l.id);
      if (mine) {
        const on = el('span', 'pill in', 'WATCHING');
        actions.appendChild(on);
      } else {
        const watch = el('button', 'small go', 'Watch this');
        watch.addEventListener('click', () =>
          withButton(watch, 'Adding…', msg, async () => {
            await api('POST', '/api/missions', { listingId: l.id, label: p.name, enabled: true });
            await load();
            return 'watching ' + l.retailer + ' — set a ceiling before arming it';
          }));
        actions.appendChild(watch);
      }

      // Removing a listing is curation, and curation is a role. A member
      // seeing a button that always answers 403 is worse than no button.
      if (DATA.canCurate) {
        const del = el('button', 'small danger', 'remove');
        del.style.marginLeft = '6px';
        del.addEventListener('click', async () => {
          if (!confirm('Remove the ' + l.retailer + ' listing?\\n\\nIts mission and run history go with it.')) return;
          await withButton(del, 'removing…', msg, async () => {
            await api('DELETE', '/api/listings/' + l.id);
            load();
            return 'removed';
          });
        });
        actions.appendChild(del);
      }
      tr.appendChild(actions);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
  }

  // ── add a listing (curators only)
  //
  // Adding a listing writes to the shared catalogue. A member who has a link
  // the catalogue is missing sends it in from Add product, which becomes a
  // request — the same act, routed to somebody who may say yes.
  if (!DATA.canCurate) {
    const note = el('div', 'meta');
    note.style.marginTop = '10px';
    note.textContent =
      'Missing a shop for this product? Send the link in from Add product and it goes to the ' +
      'catalogue owner.';
    wrap.appendChild(note);
    wrap.appendChild(msg);
    return wrap;
  }

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
/*
 * hideEmpty drops options that would match nothing, rather than dimming them.
 *
 * Dimming is right inside the Filters panel, where the greyed chip tells you
 * the category exists and is empty. On the always-visible row it is wrong: an
 * account with nothing paused and nothing armed would carry two dead chips on
 * every screen forever, and the decluttering pass that put twelve chips behind
 * one button exists precisely because that row kept growing.
 */
function chipGroup(filter, field, rows, matches, options, allLabel, onSet, hideEmpty) {
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
    const chosen = filter[field] === o.value;
    // A chosen filter is never hidden, even at zero: it is what is hiding the
    // rows, and it has to stay pressable to be turned off.
    if (hideEmpty && n === 0 && !chosen) continue;
    row.appendChild(listChip(o.label, n, chosen, () => {
      set(chosen ? '' : o.value);
    }, n === 0 && !chosen));
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
/** Whether the extra filters are showing. Per view, remembered while you look. */
const FILTERS_OPEN = { missions: false };

const STATUS_OPTIONS = [
  { value: 'pre', label: 'Pre-order' },
  { value: 'in', label: 'In stock' },
  { value: 'out', label: 'Out of stock' },
  { value: 'blind', label: 'Not reading' },
];
const MODE_OPTIONS = [
  { value: 'armed', label: 'Armed' },
  { value: 'watching', label: 'Watching' },
  { value: 'off', label: 'Paused' },
];

function renderMissionsBar(all) {
  const panel = document.getElementById('flt-missions');
  const f = LIST_FILTERS.missions;
  const box = document.getElementById('flt-missions-q');
  const shops = document.getElementById('flt-missions-shops');
  const more = document.getElementById('flt-missions-more');
  const active = document.getElementById('flt-missions-active');

  // A short list is read, not filtered. The view switcher stays either way —
  // it lives in the row now rather than on one of its own, and how you want
  // six cards laid out is still a question worth answering.
  if (all.length < FILTER_FROM) {
    panel.hidden = true;
    more.hidden = true;
    shops.textContent = '';
    active.textContent = '';
    f.shop = ''; f.status = ''; f.mode = ''; f.q = '';
    if (box) box.value = '';
    const modesOff = document.getElementById('flt-missions-modes');
    if (modesOff) modesOff.textContent = '';
    filterCountLine('flt-missions-count', all.length, all.length, false, 'missions');
    return all;
  }
  more.hidden = false;

  // The lens that stays out. "Which shop am I looking at" is the question
  // people ask on every visit; the rest are asked occasionally.
  shops.textContent = '';
  shops.appendChild(chipGroup(f, 'shop', all, missionMatchesFilter,
    shopOptions(all), 'All shops'));

  // Out here with the shop lens, not behind the button. Whether a mission is
  // armed, merely watching, or paused is the second question people ask of
  // this list, and it was two clicks away.
  const modes = document.getElementById('flt-missions-modes');
  if (modes) {
    modes.textContent = '';
    modes.appendChild(chipGroup(f, 'mode', all, missionMatchesFilter,
      MODE_OPTIONS, 'Any mode', null, true));
  }

  const extras = document.getElementById('flt-missions-chips');
  const open = FILTERS_OPEN.missions;
  panel.hidden = !open;
  extras.textContent = '';
  if (open) {
    extras.appendChild(chipGroup(f, 'status', all, missionMatchesFilter, STATUS_OPTIONS, 'Any status'));
  }

  // Anything on while the panel is shut comes back out as a chip you can see
  // and press to clear. A filter that hides rows while hiding itself is the
  // one that gets reported as a bug.
  active.textContent = '';
  if (!open) {
    const shown = [];
    if (f.status) {
      const o = STATUS_OPTIONS.find((x) => x.value === f.status);
      if (o) shown.push(['status', o.label]);
    }
    // Mode is not pulled back out any more: it is always on screen, so a chip
    // repeating it would be the same filter shown twice.
    for (const [field, label] of shown) {
      active.appendChild(listChip(label + ' ✕', null, true, () => {
        f[field] = '';
        render();
      }));
    }
  }

  const on = f.status ? 1 : 0;
  more.textContent = 'Filters';
  more.setAttribute('aria-expanded', String(open));
  if (on) more.appendChild(el('span', 'fltn', String(on)));

  // The search box lives in the panel, so it appears with it. A filter left on
  // while the panel is shut would be invisible, so it is cleared on the way
  // out rather than left hiding rows nobody can see it hiding.
  if (box && !open && f.q) { f.q = ''; box.value = ''; }

  const rows = all.filter(missionMatchesFilter);
  filterCountLine('flt-missions-count', rows.length, all.length,
    !!(f.shop || f.status || f.mode || f.q), 'missions');
  return rows;
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

  /*
   * ── "In stock" has to mean now, not last time anybody looked ─────────────
   *
   * On 2 Sep 2026 this line read "15 in stock" while Phantom was checking
   * thirteen listings, all Target, exactly one of them in stock. The other
   * fourteen were Walmart and Pokémon Center missions frozen at whatever they
   * said at 4:18pm, the minute those shops were switched off. The Iron Boulder
   * Tin had read in stock at 4:17pm and the header was still counting it six
   * hours later.
   *
   * That is the same failure as the drop we missed, wearing different clothes:
   * a switched-off shop is invisible from the front of the app, and here it
   * was worse than invisible, because the headline number was actively saying
   * everything was fine.
   *
   * So a reading only counts as current when the shop is on AND the check is
   * recent. Anything else is counted as stale and said out loud — a number
   * nobody is refreshing is not a smaller number, it is an unknown one.
   */
  const shopOff = (m) => (DATA.settings?.pausedRetailers || [])
    .some((r) => String(r).toLowerCase() === String(m.retailer || '').toLowerCase());
  // Generous next to the card's own 5-minute mark: a rotation across a dozen
  // listings can legitimately leave one of them twenty minutes old, and the
  // header should shout about a shop that stopped, not about pacing.
  const STALE_HEADER_MS = 45 * 60 * 1000;
  const fresh = (m) => !!m.lastCheckedAt &&
    Date.now() - new Date(m.lastCheckedAt).getTime() < STALE_HEADER_MS;
  const current = (m) => !shopOff(m) && fresh(m);

  const inStock = DATA.missions.filter((m) => m.state === 'in' && current(m)).length;
  const armed = DATA.missions.filter((m) => m.armed).length;
  const never = DATA.missions.filter((m) => m.state === 'unchecked').length;
  const blind = DATA.missions.filter(notReading).length;
  // Checked once, and not lately. Never-checked is its own word already, so it
  // is excluded here rather than counted twice.
  const stale = DATA.missions.filter(
    (m) => m.state !== 'unchecked' && !current(m)).length;
  const parts = [];
  // First, because a Phantom that cannot read pages is not watching, and that
  // outranks anything else the line could say.
  if (blind) parts.push(blind + ' NOT READING');
  if (inStock) parts.push(inStock + ' in stock');
  if (armed) parts.push(armed + ' armed');
  // Before "never checked": a shop that went quiet is a thing that changed,
  // and a mission that has never run is a thing that never started.
  if (stale) parts.push(stale + ' not being checked');
  if (never) parts.push(never + ' never checked');
  document.getElementById('summary').textContent =
    parts.length ? parts.join(' · ') : 'nothing in stock';
  document.getElementById('who').textContent = DATA.you || '';
  renderMe();
  renderBell();
  // Not inside renderHome(): that waits on the insights fetch, and this panel
  // needs nothing but the watchlist already in hand. Tying "what is buyable
  // right now" to an aggregate query is how the fastest answer on the page
  // ends up behind the slowest one.
  renderLive();
  showWinMoment();

  /*
   * Whether alerts have anywhere to go.
   *
   * The Hub sends a boolean and never the webhook URL: it is a credential —
   * anyone holding it can post as Phantom — and a settings page is a thing
   * people screenshot. Configured or not is the whole of what this screen
   * needs to know.
   */
  const dstate = document.getElementById('discord-state');
  if (dstate) {
    const on = DATA.discord === true;
    dstate.textContent = on
      ? 'Connected. In stock, staged stock, waiting rooms and source failures post here.' +
        (DATA.discordWins ? ' Confirmed orders post to their own wins channel.' : ' Confirmed orders post here too; set DISCORD_WINS_WEBHOOK_URL for their own channel.')
      : 'Not connected. Add DISCORD_WEBHOOK_URL to the Hub and redeploy, then test.';
    document.getElementById('discord-test').disabled = !on;
    document.getElementById('discord-preview').disabled = !on;
  }

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
  if (document.activeElement !== sf.querySelector('[name=budgetTotal]')) {
    sf.querySelector('[name=budgetTotal]').value = st.budgetTotal ? st.budgetTotal : '';
  }
  if (document.activeElement !== sf.querySelector('[name=spendCapDay]')) {
    sf.querySelector('[name=spendCapDay]').value =
      st.spendCapDay === null || st.spendCapDay === undefined ? '' : st.spendCapDay;
  }
  if (document.activeElement !== sf.querySelector('[name=sweepEveryHours]')) {
    sf.querySelector('[name=sweepEveryHours]').value = st.sweepEveryHours || '';
  }

  renderShops(st);

  renderRadar();
  renderRequests();
  renderFinds();
  maybeOpenWizard();
  renderWizard();
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
  renderSilence();

  // The queue alarm. A waiting room at a shop means a drop is likely live
  // RIGHT NOW, and the one useful thing this app can do with that is put it
  // at the top of every tab with a link — getting in line is a person's job,
  // and the queue position is the scarce thing.
  const SHOP_URL = {
    'Target': 'https://www.target.com',
    'Walmart': 'https://www.walmart.com',
    'Pokemon Center': 'https://www.pokemoncenter.com',
  };
  /*
   * ── The readiness warning ────────────────────────────────────────────────
   *
   * Walmart's queue drops are at 8pm Chicago on Wednesdays. In the ninety
   * minutes before one, this says what would stop it working — and on 2 Sep
   * 2026 the answer would have been "Walmart is switched off", three and a
   * half hours before anybody noticed.
   *
   * Two tones on purpose. Something wrong is an alert, because it needs
   * fixing now and there is a deadline. Nothing wrong is quiet and green-ish:
   * a countdown that shouts every Wednesday afternoon for no reason is a
   * banner people learn to look past, and then it is not there when it
   * matters.
   */
  const rb = document.getElementById('ready-banner');
  const ready = DATA.readiness;
  rb.textContent = '';
  rb.hidden = !ready;
  if (ready) {
    const bad = (ready.blockers || []).length > 0;
    rb.className = 'card banner' + (bad ? ' alert' : ' warn');
    // A weekly clock has no negatives: after the hour, minutesUntil is
    // counting down to NEXT week. minutesSince is what says "this is running".
    const when = ready.minutesSince > 0
      ? 'started ' + ready.minutesSince + ' min ago'
      : 'in ' + ready.minutesUntil + ' min';
    rb.appendChild(el('div', 'name',
      bad
        ? ready.retailer.toUpperCase() + ' DROP ' + when.toUpperCase() +
          ' — ' + ready.blockers.length +
          (ready.blockers.length === 1 ? ' THING IS' : ' THINGS ARE') + ' IN THE WAY'
        : ready.retailer + ' drop ' + when + ' — ready'));
    if (bad) {
      for (const b of ready.blockers) {
        const line = el('div', 'meta');
        line.appendChild(el('strong', '', b.what));
        line.append(' — ' + b.fix);
        rb.appendChild(line);
      }
    } else {
      rb.appendChild(el('div', 'meta',
        'Shop on, Phantom reporting, missions live, window will tighten by itself.'));
    }
  }

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

  const lb = document.getElementById('load-banner');
  lb.textContent = '';
  const loads = DATA.stockLoads || [];
  lb.hidden = loads.length === 0;
  if (loads.length) {
    lb.appendChild(el('div', 'name', 'STOCK IS LOADING — A DROP LOOKS NEAR'));
    for (const s of loads) {
      const meta = el('div', 'meta');
      meta.append(s.message.replace('STOCK LOADED: ', '') + ' — seen ' + ago(s.at));
      lb.appendChild(meta);
    }
  }

  // The two buttons that change what Phantom is doing, labelled with the
  // action rather than the state. "Turn Phantom on" when it is off is
  // unambiguous; a toggle labelled "Paused" leaves you guessing whether that
  // is the current state or what pressing it will do.
  const toggle = document.getElementById('phantom-toggle');
  toggle.textContent = st.paused ? 'Turn Phantom on' : 'Turn Phantom off';
  toggle.className = st.paused ? 'primary' : '';
  // In the toolbar the button was the only thing on screen saying what state
  // Phantom was in, so its label had to carry both. On a settings row there is
  // a line above it that can say the state plainly, and the button can go back
  // to naming the action alone.
  const pstate = document.getElementById('phantom-state');
  if (pstate) pstate.textContent = st.paused ? 'Phantom is off' : 'Phantom is watching';

  /*
   * Whose screen this is.
   *
   * A member's account watches the same shared catalogue and keeps its own
   * missions and history, but it has no agent and no card. Half of Settings
   * is therefore about a machine they do not have, and showing it — even
   * greyed out — is offering a lever attached to nothing. Absent is the honest
   * rendering; a sentence in its place says why rather than leaving a gap.
   *
   * Gated on canArm, the right to instruct a machine to spend, because that is
   * the question this screen is actually asking. Fails closed: an older Hub
   * that does not send the flag shows a member's view, which hides controls
   * rather than offering ones that will not work.
   */
  const machine = document.getElementById('machine-settings');
  const note = document.getElementById('member-note');
  if (machine) machine.hidden = DATA.canArm !== true;
  if (note) note.hidden = DATA.canArm === true;

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
  /*
   * Discovery for a curator; Requests for everyone else.
   *
   * The sweep's queue is a decision only a curator can make — Keep and Forget
   * both fail closed at the server — so a member gets the other half of the
   * same question instead: the links THEY sent in, and what happened to each.
   * Their count is what is still waiting on somebody, because a number that
   * counts finds they cannot act on is a badge that never goes down.
   */
  const curates = DATA.canCurate === true;
  const finds = DATA.discoveries || [];
  const requests = DATA.requests || [];
  const label = document.getElementById('finds-tab-label');
  if (label) label.textContent = curates ? 'Discovery' : 'Requests';
  document.getElementById('c-finds').textContent = curates
    ? finds.length || ''
    : requests.filter((r) => r.status === 'pending').length || '';

  const fhead = document.getElementById('finds-head');
  const fblurb = document.getElementById('finds-blurb');
  if (fhead && fblurb && !curates) {
    fhead.textContent = 'Requests — links you sent in';
    fblurb.textContent =
      'Paste a link from Add product and it comes here. The catalogue owner ' +
      'decides; anything still waiting says so below.';
  }
  // The queue itself, and the tools for working it. Hidden rather than shown
  // with buttons the server will refuse.
  for (const id of ['finds-tools', 'finds-filters', 'finds-list']) {
    const node = document.getElementById(id);
    if (node) node.hidden = !curates;
  }
  document.getElementById('c-vault').textContent =
    (DATA.acquisitions || []).filter((a) => a.status === 'queued').length || '';

  renderVault();
}

/**
 * The vault queue: each confirmed purchase, its match, and the Send.
 *
 * The match search talks to the vault's own sealed catalog (relayed through
 * /api/vault/search) so the id sent is one the vault actually knows. A product
 * matched once is remembered — vaultTcgId arrives pre-filled on the next buy
 * of the same thing — so the second time is one click.
 */
/** The shop switches, the burst field, and whether a window is open. */
const SHOPS = ['Target', 'Walmart', 'Pokemon Center'];

function renderShops(st) {
  const box = document.getElementById('shop-toggles');
  if (!box) return;
  const off = st.pausedRetailers || [];
  box.textContent = '';
  for (const shop of SHOPS) {
    const on = !off.some((r) => String(r).toLowerCase() === shop.toLowerCase());
    // The chip says the STATE, and pressing it flips that state. A control
    // labelled with what it will do next reads as a description of now.
    const chip = el('button', 'chip' + (on ? ' on' : ''), shop + (on ? ' · on' : ' · off'));
    chip.type = 'button';
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.addEventListener('click', async () => {
      const next = on
        ? [...off.filter((r) => String(r).toLowerCase() !== shop.toLowerCase()), shop]
        : off.filter((r) => String(r).toLowerCase() !== shop.toLowerCase());
      const msg = document.getElementById('shops-msg');
      await withButton(chip, '…', msg, async () => {
        await api('POST', '/api/settings', { pausedRetailers: next });
        await load();
        return shop + (on ? ' is off' : ' is on');
      });
    });
    box.appendChild(chip);
  }

  const sform = document.getElementById('shops-form');
  const burst = sform.querySelector('[name=burstSpacingSeconds]');
  if (document.activeElement !== burst) burst.value = st.burstSpacingSeconds || '';
  const repeat = sform.querySelector('[name=stagedRepeatMinutes]');
  if (repeat && document.activeElement !== repeat) repeat.value = st.stagedRepeatMinutes || '';
  const inv = sform.querySelector('[name=discordInvite]');
  if (inv && document.activeElement !== inv) inv.value = st.discordInvite || '';
  const inRep = sform.querySelector('[name=inStockRepeatAfter]');
  if (inRep && document.activeElement !== inRep) {
    inRep.value = (st.inStockRepeatAfter || []).join(', ');
  }

  // Is a window open, and how long is left? Said in words, because "true" is
  // not an answer to "am I about to be checking Target every 8 seconds".
  const state = document.getElementById('drop-state');
  const closeBtn = document.getElementById('drop-close');
  const until = st.dropModeUntil ? Date.parse(st.dropModeUntil) : NaN;
  const openNow = Number.isFinite(until) && until > Date.now();
  closeBtn.hidden = !openNow;
  if (!st.burstSpacingSeconds) {
    state.textContent =
      'No drop-window spacing set, so a window would change nothing — set the seconds first.';
  } else if (openNow) {
    const mins = Math.ceil((until - Date.now()) / 60000);
    state.textContent =
      'DROP WINDOW OPEN — checking every ' + st.burstSpacingSeconds +
      's, closing in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.';
  } else {
    state.textContent =
      'Ordinary pace. A window also opens by itself on the day something you watch is released.';
  }
}

function renderVault() {
  const list = document.getElementById('acq-list');
  if (!list) return;
  // Don't rebuild under someone mid-search: same guard the detail pop-up uses.
  if (list.contains(document.activeElement) && document.activeElement !== document.body) return;
  list.textContent = '';
  const all = DATA.acquisitions || [];
  if (!all.length) {
    list.appendChild(emptyBlock('Nothing has been bought yet.',
      'When a checkout is confirmed on the page, the purchase queues here for its trip to the vault.'));
    return;
  }
  for (const a of all) list.appendChild(acquisitionCard(a));
}

function acquisitionCard(a) {
  const card = el('div', 'card acq');
  const row = el('div', 'row');
  if (a.imageUrl) {
    const img = el('img', 'thumb');
    img.src = a.imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    row.appendChild(img);
  }
  const main = el('div', 'grow');
  main.appendChild(el('div', 'name', a.name));
  const meta = el('div', 'meta',
    a.retailer + ' · qty ' + a.quantity +
    (a.unitPriceCents != null ? ' · ' + money(a.unitPriceCents / 100) + ' each' : '') +
    (a.orderedOn ? ' · ordered ' + a.orderedOn : ''));
  main.appendChild(meta);
  row.appendChild(main);
  const pill = el('span', 'pill ' + (a.status === 'sent' ? 's-in' : a.status === 'dismissed' ? 's-out' : 'flag'),
    a.status === 'sent' ? 'in your vault' : a.status);
  row.appendChild(pill);
  card.appendChild(row);

  if (a.status !== 'queued') {
    if (a.status === 'sent' && a.sentAt) {
      card.appendChild(el('div', 'meta', 'sent ' + ago(a.sentAt)));
    }
    return card;
  }

  // The match-and-send strip. Pre-filled when this product was matched before.
  const strip = el('div', 'stack');
  strip.style.marginTop = '10px';
  const picked = { tcgId: a.vaultTcgId || '', name: '', setName: '', imageUrl: '' };

  const pickedLine = el('div', 'meta');
  const showPicked = () => {
    pickedLine.textContent = picked.tcgId
      ? 'matched to vault product ' + picked.tcgId + (picked.name ? ' — ' + picked.name : ' (remembered from last time)')
      : 'not matched yet — search your vault catalog below, or send unmatched and fix it in the vault';
  };
  showPicked();
  strip.appendChild(pickedLine);

  const searchRow = el('div', 'actions');
  const q = el('input');
  q.type = 'search';
  q.placeholder = 'Search the vault catalog';
  q.value = a.name;
  q.autocomplete = 'off';
  const searchBtn = el('button', 'small', 'Search');
  searchBtn.type = 'button';
  const results = el('div', 'stack');
  results.style.marginTop = '6px';
  searchBtn.addEventListener('click', async () => {
    searchBtn.disabled = true;
    searchBtn.textContent = 'searching…';
    results.textContent = '';
    try {
      const found = await api('GET', '/api/vault/search?q=' + encodeURIComponent(q.value));
      const products = (found.products || []).slice(0, 6);
      if (!products.length) results.appendChild(el('div', 'meta', 'nothing in the catalog matched that'));
      for (const p of products) {
        const line = el('div', 'row');
        const pick = el('button', 'small', 'This one');
        pick.type = 'button';
        pick.addEventListener('click', () => {
          picked.tcgId = String(p.id || '');
          picked.name = String((p.set ? p.set + ' ' : '') + (p.name || ''));
          picked.setName = String(p.set || '');
          picked.imageUrl = String(p.image || '');
          showPicked();
          results.textContent = '';
        });
        line.appendChild(pick);
        const label = el('span', 'meta',
          (p.set ? p.set + ' · ' : '') + (p.name || '') + (p.price != null ? ' · ' + money(p.price) : ''));
        label.style.marginLeft = '8px';
        line.appendChild(label);
        results.appendChild(line);
      }
    } catch (err) {
      results.appendChild(el('div', 'meta', err.message));
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
    }
  });
  searchRow.appendChild(q);
  searchRow.appendChild(searchBtn);
  strip.appendChild(searchRow);
  strip.appendChild(results);

  const actions = el('div', 'actions');
  const send = el('button', 'primary', 'Send to vault');
  send.type = 'button';
  const dismiss = el('button', 'small', 'Not for the vault');
  dismiss.type = 'button';
  const msg = el('span', 'msg');
  send.addEventListener('click', () => withButton(send, 'sending…', msg, async () => {
    await api('POST', '/api/acquisitions/' + a.id + '/send', {
      tcgId: picked.tcgId || null,
      name: picked.name || undefined,
      setName: picked.setName || undefined,
      imageUrl: picked.imageUrl || undefined,
    });
    await load();
    return 'in your vault';
  }));
  dismiss.addEventListener('click', () => withButton(dismiss, 'dismissing…', msg, async () => {
    await api('POST', '/api/acquisitions/' + a.id + '/dismiss');
    await load();
    return 'dismissed';
  }));
  actions.appendChild(send);
  actions.appendChild(dismiss);
  actions.appendChild(msg);
  strip.appendChild(actions);
  card.appendChild(strip);
  return card;
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
  host.appendChild(el('div', 'meta', 'Every known street date ahead, soonest first. A release is when a product first exists — a drop is a retailer putting stock up, which happens many times after.'));
  entries.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));
  const groups = [
    { label: 'Releases today', today: true, match: (e) => e.days === 0 },
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

/**
 * Links people sent in.
 *
 * Two audiences, one card, because they are two views of the same fact. The
 * OWNER sees an inbox with buttons: a link somebody found, and yes or no. A
 * MEMBER sees a receipt — what they sent, and what became of it — which is the
 * half that stops "send us a link" feeling like a hole in the ground.
 *
 * A declined row keeps its reason. "No" with a sentence attached is a person
 * answering; "no" on its own is the thing that makes people stop sending.
 */
/* ── The front door ──────────────────────────────────────────────────────────
 *
 * Every other surface on this page assumes you already know what it is for.
 * Somebody arriving from the vault does not, and an empty dashboard tells them
 * only that it is empty — which reads as broken, not as new.
 *
 * Four steps, and the middle two are the actual product rather than a tour of
 * it: pick something to watch out of the shared catalogue, or send in a link
 * that is missing from it. A walkthrough you cannot act inside is a brochure.
 *
 * Skippable on every step, and re-openable from the header afterwards. A
 * wizard you cannot get out of is one people learn to click through without
 * reading, and then it has taught them nothing twice.
 */
const WIZ_SEEN = 'phantom.frontdoor.v1';
let WIZ_STEP = 0;

/** What the steps ARE, so the count and the order have one definition. */
function wizSteps() {
  return [
    { title: 'What Phantom does', render: wizWhat },
    { title: 'Pick something to watch', render: wizPick },
    { title: 'Something missing?', render: wizAsk },
    { title: 'What happens next', render: wizNext },
  ];
}

function wizWhat(body) {
  const p1 = el('p');
  p1.textContent =
    'Phantom opens real product pages in a real browser on a real machine, and ' +
    'tells you the moment something is genuinely buyable — not "back in stock" ' +
    'from a feed that is four minutes old.';
  body.appendChild(p1);

  const list = el('ul');
  // Read from the live capability table rather than written here, so a shop
  // that goes behind a wall cannot keep being promised by a hard-coded line.
  const shops = DATA.capabilities || [];
  if (shops.length === 0) {
    for (const name of ['Target', 'Walmart', 'Pokémon Center']) {
      list.appendChild(el('li', null, name));
    }
  } else {
    for (const shop of shops) {
      const li = el('li');
      li.appendChild(document.createTextNode(shop.name + ' — '));
      const how = shop.blocked
        ? el('span', 'warn-text', 'not readable at the moment: ' + shop.blocked.what)
        : document.createTextNode(shop.watch === 'live' ? 'watched' : 'partly watched');
      li.appendChild(how);
      list.appendChild(li);
    }
  }
  body.appendChild(list);

  const p2 = el('p', 'sub');
  p2.textContent =
    'It never buys anything on your behalf. Watching and buying are separate, ' +
    'and buying needs a machine of your own signed into your own accounts.';
  body.appendChild(p2);
}

function wizPick(body) {
  const p = el('p');
  p.textContent =
    'The catalogue is shared, so anything already in it is one click away. ' +
    'Watching only — nothing here can spend.';
  body.appendChild(p);

  const listings = DATA.listings || [];
  if (listings.length === 0) {
    body.appendChild(el('div', 'meta', 'The catalogue is empty so far. The next step is how it fills up.'));
    return;
  }

  const box = el('div');
  box.style.marginTop = '10px';
  const watched = new Set((DATA.missions || []).map((m) => m.listingId));
  // The ones you are not watching first: a list that opens with six rows of
  // WATCHING is a list that looks like it has nothing to offer.
  const rows = listings
    .slice()
    .sort((a, b) => (watched.has(a.id) ? 1 : 0) - (watched.has(b.id) ? 1 : 0))
    .slice(0, 8);

  for (const l of rows) {
    const row = el('div', 'pickable');
    const name = el('div', 'grow');
    name.appendChild(el('div', null, l.productName || l.externalId));
    name.appendChild(el('div', 'meta', l.retailer + ' · ' + l.externalId));
    row.appendChild(name);

    if (watched.has(l.id)) {
      row.appendChild(el('span', 'pill in', 'WATCHING'));
    } else {
      const add = el('button', 'small go', 'Watch this');
      const msg = el('span', 'msg');
      add.addEventListener('click', () =>
        withButton(add, 'Adding…', msg, async () => {
          await api('POST', '/api/missions', { listingId: l.id, label: l.productName, enabled: true });
          await load();
          renderWizard();
          return 'watching';
        }));
      row.appendChild(add);
      row.appendChild(msg);
    }
    box.appendChild(row);
  }
  body.appendChild(box);
}

function wizAsk(body) {
  const p = el('p');
  p.textContent = DATA.canCurate
    ? 'Paste a Target, Pokémon Center or Walmart product link and it goes ' +
      'straight into the catalogue, watched from the next pass.'
    : 'Paste a Target, Pokémon Center or Walmart product link. It goes to the ' +
      'catalogue owner, and once it is added you will see it on your watchlist. ' +
      'You can see what happened to anything you send under Discovery.';
  body.appendChild(p);

  const form = el('form', 'stack');
  form.style.marginTop = '12px';
  const input = el('input');
  input.type = 'url';
  input.placeholder = 'https://www.target.com/p/…/A-1012644666';
  input.autocomplete = 'off';
  input.spellcheck = false;
  form.appendChild(input);

  const actions = el('div', 'actions');
  const send = el('button', 'go', DATA.canCurate ? 'Add and watch' : 'Send it in');
  send.type = 'submit';
  const msg = el('span', 'msg');
  actions.appendChild(send);
  actions.appendChild(msg);
  form.appendChild(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    withButton(send, 'Sending…', msg, async () => {
      const r = await api('POST', '/api/quick-add', { url });
      input.value = '';
      await load();
      if (r.requested) return r.message;
      return r.alreadyTracked ? 'already watching that one' : 'watching it now';
    });
  });
  body.appendChild(form);
}

function wizNext(body) {
  const list = el('ul');
  const bits = [
    'Readings land on the Missions tab. A page that has not been checked yet ' +
      'says so rather than pretending to be out of stock.',
    'Activity shows every check, with what the page said and why anything was ' +
      'decided — including the checks that found nothing.',
    'A release date or warehouse stock appearing is a warning that a drop is ' +
      'near. Those get their own banner at the top.',
  ];
  if (!DATA.canCurate) {
    bits.push(
      'Arming — letting a machine buy — needs a Phantom of your own, signed ' +
        'into your own accounts. Nothing here can spend your money.',
    );
  }
  for (const b of bits) list.appendChild(el('li', null, b));
  body.appendChild(list);

  const p = el('p', 'sub');
  p.textContent = 'You can reopen this any time from “How it works” at the top.';
  body.appendChild(p);
}

function renderWizard() {
  const card = document.getElementById('wizard');
  if (!card || card.hidden) return;
  const steps = wizSteps();
  WIZ_STEP = Math.max(0, Math.min(WIZ_STEP, steps.length - 1));
  const step = steps[WIZ_STEP];

  document.getElementById('wiz-title').textContent = step.title;
  const body = document.getElementById('wiz-body');
  body.textContent = '';
  step.render(body);

  document.getElementById('wiz-step').textContent = (WIZ_STEP + 1) + ' / ' + steps.length;
  document.getElementById('wiz-back').hidden = WIZ_STEP === 0;
  document.getElementById('wiz-next').textContent =
    WIZ_STEP === steps.length - 1 ? 'Done' : 'Next';
}

function openWizard(step) {
  WIZ_STEP = step || 0;
  const card = document.getElementById('wizard');
  card.hidden = false;
  renderWizard();
  // Guarded: not every environment implements it, and a front door that
  // throws while trying to be polite about scrolling is a page that dies on
  // its first render.
  if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
}

function closeWizard() {
  document.getElementById('wizard').hidden = true;
  // Remembered so it does not greet the same person every morning. A failure
  // to remember is not a failure to work: the wizard is skippable either way.
  try { localStorage.setItem(WIZ_SEEN, '1'); } catch (e) { /* private window */ }
}

/**
 * Should the front door open by itself?
 *
 * Only when there is nothing to show AND it has not been dismissed. An empty
 * dashboard reads as broken rather than new, and that is the moment worth
 * spending; a dashboard with missions on it explains itself.
 */
function maybeOpenWizard() {
  if (!document.getElementById('wizard').hidden) return;
  if ((DATA.missions || []).length > 0) return;
  let seen = false;
  try { seen = localStorage.getItem(WIZ_SEEN) === '1'; } catch (e) { seen = false; }
  if (seen) return;
  openWizard(0);
}

/**
 * Has the machine gone quiet?
 *
 * The signal is the activity log, not the readings. Phantom writes a line
 * every pass INCLUDING when it is resting outside watching hours — so silence
 * means the process is not running, rather than that it has nothing to do, and
 * this cannot cry wolf every night when the schedule closes.
 *
 * Ten minutes, against a pass every ninety seconds. Generous on purpose: the
 * log is buffered and flushed per pass, a slow pass can run minutes long, and
 * a banner that flickers is a banner people stop reading. It states the actual
 * time it last heard anything, so the judgement is not only ours.
 */
const SILENCE_MS = 10 * 60 * 1000;

function renderSilence() {
  const banner = document.getElementById('silence-banner');
  if (!banner) return;
  const seen = DATA.agentSeenAt;
  // No activity at all is a new account, not an outage. Saying "stopped
  // reporting" to somebody who has never started it is a lie with an
  // exclamation mark on it.
  if (!seen) { banner.hidden = true; return; }

  const quietFor = Date.now() - new Date(seen).getTime();
  if (!(quietFor > SILENCE_MS)) { banner.hidden = true; return; }

  banner.hidden = false;
  document.getElementById('silence-detail').textContent =
    'Nothing has been heard from the machine since ' +
    new Date(seen).toLocaleTimeString() + ' (' + ago(seen) + '). ' +
    'Nothing is being watched until it is running again — check that the ' +
    'Phantom window is still open on the machine that watches.';
}

/* ── The dashboard ───────────────────────────────────────────────────────────
 *
 * Fetched on its own, when the tab is opened and when the range changes. These
 * are aggregates over every activity row and every run ever written, and the
 * page that refreshes on a thirty-second timer must not be paying for them.
 */
let INSIGHTS = null;
let RANGE_HOURS = 168;
const RANGES = [
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

async function loadInsights() {
  const host = document.getElementById('tab-home');
  if (!host || host.hidden) return;
  try {
    INSIGHTS = await api('GET', '/api/insights?hours=' + RANGE_HOURS);
  } catch (e) {
    INSIGHTS = null;
  }
  renderHome();
}

function kpi(host, label, value, note, tone) {
  const box = el('div', 'kpi' + (tone ? ' ' + tone : ''));
  box.appendChild(el('div', 'k', label));
  box.appendChild(el('div', 'v', value));
  if (note) box.appendChild(el('div', 'n', note));
  host.appendChild(box);
  return box;
}

/** A stage of the funnel: label, count, and a bar as wide as its share. */
function stage(host, label, n, of, note, cliff) {
  const row = el('div', 'fstage' + (cliff ? ' cliff' : ''));
  const top = el('div', 'top');
  top.appendChild(el('span', 'lbl', label));
  top.appendChild(el('span', 'num', String(n)));
  row.appendChild(top);
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  fill.style.width = (of > 0 ? Math.max(1.5, (n / of) * 100) : 0) + '%';
  track.appendChild(fill);
  row.appendChild(track);
  if (note) row.appendChild(el('div', 'drop', note));
  host.appendChild(row);
}

/*
 * What is buyable right now.
 *
 * The one question this page exists to answer in the moment, and until now it
 * was not on the page at all: the funnel is about a WINDOW, and "18 came in
 * stock this week" tells you nothing about whether to open a tab.
 *
 * Built from the watchlist the page already holds — no request, no aggregate,
 * no wait. Marketplace listings are shown but flagged: they are usually the
 * only thing in stock and usually at three times MSRP, so hiding them would
 * lie about the number and showing them silently would invite a bad click.
 */
function liveNow() {
  return (DATA.missions || [])
    .filter((m) => m.enabled && m.state === 'in')
    .sort((a, b) => {
      // Sold by the shop first, then cheapest. Both halves matter: a reseller
      // at $180 is not what you came for, and among real ones price decides.
      const ar = a.sellerKind === 'marketplace' ? 1 : 0;
      const br = b.sellerKind === 'marketplace' ? 1 : 0;
      if (ar !== br) return ar - br;
      return (a.price ?? Infinity) - (b.price ?? Infinity);
    });
}

/*
 * ── The win ─────────────────────────────────────────────────────────────────
 *
 * Once per confirmed order, on the first device that sees it. The set of run
 * ids already shown lives in localStorage, so a refresh does not replay it and
 * a second phone gets its own. Limited to orders from the last day: an old win
 * must not greet a brand-new device as though it just happened.
 *
 * Deliberately not on a timer. A thing worth celebrating is worth the second
 * it takes to close it, and an overlay that vanishes while you are reaching
 * for it is a notification, not a moment.
 *
 * (No backticks anywhere in this function or its comments: they live inside
 *  the page template literal and one of them ends the script.)
 */
const WIN_SEEN_KEY = 'phantom.wins.seen';
const WIN_FRESH_MS = 24 * 60 * 60 * 1000;
const WIN_COLOURS = ['#f5c542', '#8b7cf6', '#3ddc97', '#ff8a5b', '#ffffff'];

function winsSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(WIN_SEEN_KEY) || '[]')); }
  catch (err) { return new Set(); }
}
function markWinSeen(id) {
  try {
    const seen = winsSeen(); seen.add(id);
    // Keep the last hundred. This is a memory of moments, not a ledger.
    localStorage.setItem(WIN_SEEN_KEY, JSON.stringify([...seen].slice(-100)));
  } catch (err) { /* a device that cannot remember will show it again; fine */ }
}

function showWinMoment() {
  const host = document.getElementById('win-moment');
  if (!host || !host.hidden) return;
  const seen = winsSeen();
  const now = Date.now();
  const fresh = (DATA.runs || [])
    .filter((r) => r.outcome === 'bought' && !seen.has(r.id))
    .filter((r) => now - new Date(r.finishedAt || r.startedAt).getTime() < WIN_FRESH_MS)
    .sort((a, b) => new Date(b.finishedAt || b.startedAt) - new Date(a.finishedAt || a.startedAt));
  const r = fresh[0];
  if (!r) return;

  const m = (DATA.missions || []).find((x) => x.id === r.missionId);
  const img = document.getElementById('win-img');
  const src = (m && m.imageUrl) || '';
  if (src) img.src = src; else img.removeAttribute('src');
  document.getElementById('win-name').textContent = r.productName || (m && m.productName) || 'a watched listing';
  const paid = r.total !== null && r.total !== undefined ? r.total : r.price;
  const qty = r.quantity && r.quantity > 1 ? r.quantity + ' × ' : '';
  const line = document.getElementById('win-line');
  line.textContent = '';
  line.append(qty);
  line.appendChild(el('b', null, money(paid)));
  line.append(' from ' + (r.retailer || (m && m.retailer) || 'the shop'));
  document.getElementById('win-when').textContent =
    'confirmed by the retailer ' + ago(r.finishedAt || r.startedAt);

  const burst = host.querySelector('.winburst');
  burst.textContent = '';
  for (let i = 0; i < 28; i += 1) {
    const bit = document.createElement('span');
    bit.style.left = Math.round(Math.random() * 100) + '%';
    bit.style.background = WIN_COLOURS[i % WIN_COLOURS.length];
    bit.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
    bit.style.animationDuration = (2.2 + Math.random() * 1.4).toFixed(2) + 's';
    burst.appendChild(bit);
  }

  const close = () => { host.hidden = true; markWinSeen(r.id); };
  document.getElementById('win-close').onclick = close;
  document.getElementById('win-open').onclick = () => { close(); showTab('wins'); };
  host.hidden = false;
}

function renderLive() {
  const list = document.getElementById('live-list');
  const n = document.getElementById('live-n');
  const label = document.getElementById('live-label');
  if (!list || !n) return;

  const rows = liveNow();
  const shop = rows.filter((m) => m.sellerKind !== 'marketplace');
  list.textContent = '';

  const title = document.getElementById('live-title');
  n.textContent = String(shop.length);
  n.className = shop.length ? 'hero' : 'hero none';
  if (title) {
    title.textContent = shop.length ? 'In stock' : 'Nothing in stock';
    title.className = shop.length ? 'livetitle' : 'livetitle none';
  }
  label.textContent = shop.length === 1
    ? 'buyable right now, from the shop itself'
    : 'buyable right now, from the shops themselves';

  if (rows.length === 0) {
    const none = el('div', 'meta');
    none.style.marginTop = '10px';
    none.textContent = 'Nothing you watch is in stock. That is what watching mostly looks like.';
    list.appendChild(none);
    return;
  }

  for (const m of rows.slice(0, 6)) {
    const row = el('div', 'live');
    if (m.imageUrl) {
      const img = el('img');
      img.src = m.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      row.appendChild(img);
    }
    const g = el('div', 'g');
    const nm = el('div', 'nm', shortName(m.productName));
    nm.title = m.productName;
    g.appendChild(nm);
    const meta = el('div', 'meta');
    meta.append(m.retailer + (m.sellerKind === 'marketplace'
      ? ' · ⚠️ ' + (m.sellerName || 'marketplace seller')
      : ''));
    const stock = stockLine(m);
    if (stock) meta.append(' · ' + stock);
    g.appendChild(meta);
    row.appendChild(g);

    if (m.price !== null && m.price !== undefined) {
      row.appendChild(el('div', 'px', money(m.price)));
    }
    if (m.url) {
      const a = el('a', 'btn small go', 'Open');
      a.href = m.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      row.appendChild(a);
    }
    list.appendChild(row);
  }

  if (rows.length > 6) {
    const more = el('div', 'meta');
    more.style.marginTop = '8px';
    more.textContent = (rows.length - 6) + ' more on the watchlist.';
    list.appendChild(more);
  }
}

function renderHome() {
  const host = document.getElementById('tab-home');
  if (!host || host.hidden) return;

  const chips = document.getElementById('range-chips');
  chips.textContent = '';
  for (const r of RANGES) {
    chips.appendChild(listChip(r.label, null, RANGE_HOURS === r.hours, () => {
      RANGE_HOURS = r.hours;
      loadInsights();
    }));
  }

  renderMoney2(INSIGHTS && INSIGHTS.money);

  const funnelHost = document.getElementById('funnel');
  const verdict = document.getElementById('funnel-verdict');
  const kpis = document.getElementById('home-kpis');
  const refusals = document.getElementById('refusals');
  const health = document.getElementById('health-kpis');
  const speed = document.getElementById('speed');
  for (const n of [funnelHost, verdict, kpis, refusals, health, speed]) n.textContent = '';

  // Guarded on the SHAPE, not just on presence. A half-answer — an older
  // server, a proxy that swallowed a field — must leave the page standing and
  // say it has nothing, rather than throwing on the first property access and
  // taking every other tab down with it.
  if (!INSIGHTS || !INSIGHTS.funnel || !INSIGHTS.health) {
    document.getElementById('funnel-sub').textContent =
      INSIGHTS ? 'These numbers could not be read.' : 'Loading…';
    return;
  }

  const f = INSIGHTS.funnel;
  const h = INSIGHTS.health;
  const label = (RANGES.find((r) => r.hours === INSIGHTS.hours) || {}).label || 'the window';
  document.getElementById('range-note').textContent = 'over the last ' + label;
  document.getElementById('funnel-sub').textContent =
    'Top two: right now. The rest: the last ' + label + '.';

  const top = Math.max(1, f.watching);
  stage(funnelHost, 'Watching', f.watching, top, 'listings with a mission on them');
  /*
   * Staged sits above stock on purpose: it is the only stage in this funnel
   * that moves while there is still time to do something. Everything below it
   * is a race that has already started.
   *
   * It is drawn even at zero, and zero is what it says today. That is the
   * finding, not a gap: every non-zero count this system has ever read was on
   * a listing the shop was already selling. A stage that has never fired is
   * worth a line on the page, because the alternative is a dashboard that
   * quietly omits the signal we most want and lets us assume it is working.
   */
  const stagedN = f.staged || 0;
  stage(funnelHost, 'Stock in the warehouse', stagedN, top,
    stagedN
      ? 'counted before the shop would sell it' +
        (f.stagedPeak ? ' · biggest ' + f.stagedPeak + ' units' : '')
      : 'never seen yet');

  stage(funnelHost, 'Came in stock', f.sawStock, top,
    (f.watching ? pct(f.sawStock, f.watching) + ' of what you watch' : '') +
    (f.resellerOnly ? ' · ' + f.resellerOnly + ' more were resellers only' : ''));
  stage(funnelHost, 'Armed at the time', f.sawStockArmed, top,
    f.sawStock
      ? (f.sawStockArmed === 0
          ? 'none of the ' + f.sawStock
          : pct(f.sawStockArmed, f.sawStock) + ' of those')
      : '',
    f.sawStock > 0 && f.sawStockArmed === 0);
  stage(funnelHost, 'Money approved', f.authorised, top, 'the Hub cleared the spend');
  stage(funnelHost, 'Bought', f.bought, top, 'the retailer confirmed the order');

  /*
   * The verdict, in a sentence.
   *
   * A dashboard that shows five numbers and leaves the reader to find the
   * cliff has done the easy half of the job. This names the steepest drop —
   * and it does so EVEN WHEN SOMETHING WAS BOUGHT, because "one order" and
   * "seven per cent of the stock we saw was armed for" are both true at once,
   * and only the second one tells you what to do next.
   */
  const say = el('div', 'verdict');
  const win = f.bought > 0
    ? f.bought + ' order' + (f.bought === 1 ? '' : 's') + ' confirmed. '
    : '';

  if (f.watching === 0) {
    say.textContent = 'Nothing is being watched yet. Add a listing and this fills in.';
  } else if (f.sawStock === 0) {
    say.textContent = f.resellerOnly
      ? 'Nothing came in stock at the shops in the last ' + label + '. ' +
        f.resellerOnly + ' listings had stock from resellers, which missions refuse.'
      : 'Nothing you watch came in stock in the last ' + label + '.';
  } else if (f.sawStockArmed === 0) {
    say.textContent = win +
      f.sawStock + ' listing' + (f.sawStock === 1 ? '' : 's') +
      ' came in stock and none were armed, so nothing could be bought. ' +
      'Arming is what is missing, not speed.';
  } else if (f.sawStockArmed < f.sawStock / 2) {
    // The common case, and the one the old wording hid behind a win: it did
    // buy, and it was only ever in a position to buy a fraction of what it saw.
    if (win) say.className = 'verdict ok';
    say.textContent = win +
      f.sawStock + ' listings came in stock, ' + f.sawStockArmed + ' armed (' +
      pct(f.sawStockArmed, f.sawStock) + '). The other ' +
      (f.sawStock - f.sawStockArmed) + ' were never in play.';
  } else if (f.bought === 0 && f.authorised > 0) {
    say.textContent =
      'Money was approved ' + f.authorised + ' time' + (f.authorised === 1 ? '' : 's') +
      ' and no order came of it. The reasons are below.';
  } else if (f.bought > 0) {
    say.className = 'verdict ok';
    say.textContent = win + 'Everything armed that came in stock was acted on.';
  } else {
    say.textContent =
      'Stock came in and nothing was armed far enough to approve a purchase.';
  }
  verdict.appendChild(say);

  // ── the headline numbers ────────────────────────────────────────────────
  const bought = f.outcomes.find((o) => o.outcome === 'bought');
  const runs = f.outcomes.reduce((a, o) => a + o.n, 0);
  kpi(kpis, 'Orders', String(f.bought), 'confirmed in ' + label, f.bought ? 'good' : '');
  kpi(kpis, 'Runs', String(runs), 'times a mission acted, or could not');
  kpi(kpis, 'Real stock', String(f.sawStock),
    f.resellerOnly ? '+' + f.resellerOnly + ' reseller-only, refused' : 'from the shop itself');
  kpi(kpis, 'Armed', String(f.sawStockArmed) + ' / ' + f.sawStock,
    'of those, armed to buy', f.sawStock && !f.sawStockArmed ? 'bad' : '');

  // ── why not ─────────────────────────────────────────────────────────────
  if (f.refusals.length === 0) {
    refusals.appendChild(el('div', 'meta',
      runs === 0
        ? 'No mission has acted in this window, so there is nothing to explain.'
        : 'Nothing was refused in this window.'));
  } else {
    const box = el('div', 'rows');
    const most = Math.max.apply(null, f.refusals.map((r) => r.n));
    for (const r of f.refusals) {
      const line = el('div', 'rowline');
      const g = el('div', 'g');
      g.appendChild(document.createTextNode(r.reason));
      const bar = el('div', 'bar');
      bar.style.width = Math.max(2, (r.n / most) * 100) + '%';
      g.appendChild(bar);
      line.appendChild(g);
      line.appendChild(el('span', 'c', String(r.n)));
      box.appendChild(line);
    }
    refusals.appendChild(box);
  }

  // ── the machine ─────────────────────────────────────────────────────────
  const up = Math.round(h.uptime * 100);
  kpi(health, 'Reporting', up + '%', h.stalls ? h.stalls + ' quiet five-minute gaps' : 'no gaps',
    up >= 95 ? 'good' : up >= 80 ? '' : 'bad');
  kpi(health, 'Page reads', String(h.checks), 'in ' + label);
  kpi(health, 'Failed', String(h.failed),
    h.checks ? pct(h.failed, h.checks) + ' of reads' : '', h.failed ? 'bad' : '');
  kpi(health, 'Challenged', String(h.challenged), 'walls and waiting rooms',
    h.challenged ? 'bad' : '');

  if (h.speed.length === 0) {
    speed.appendChild(el('div', 'meta', 'No reads recorded in this window.'));
  } else {
    const box = el('div', 'rows');
    const slowest = Math.max.apply(null, h.speed.map((x) => x.medianMs));
    for (const x of h.speed) {
      const line = el('div', 'rowline');
      const g = el('div', 'g');
      g.appendChild(document.createTextNode(x.retailer));
      const bar = el('div', 'bar');
      bar.style.width = Math.max(2, (x.medianMs / slowest) * 100) + '%';
      g.appendChild(bar);
      line.appendChild(g);
      line.appendChild(el('span', 'c', (x.medianMs / 1000).toFixed(1) + 's · ' + x.checks));
      box.appendChild(line);
    }
    speed.appendChild(box);
    speed.appendChild(el('div', 'meta',
      'Median time to read one page, and how many were read. Lower is how much ' +
      'of a drop you are still in when the answer arrives.'));
  }

  renderWinsInto('wins-preview-list', INSIGHTS.wins || [], true);
}

/**
 * The money, in three parts.
 *
 * "Spent" is not one thing, and the split is the whole point:
 *
 *   SETTLED    an order. Paid, gone.
 *   COMMITTED  a pre-order. The shop takes it at ship, sometimes months out —
 *              owed, not paid, and still yours until then.
 *   OPEN       a grant nobody resolved. Either a buy in flight or a Phantom
 *              that died mid-checkout, in which case nobody knows whether
 *              money moved. Shown because "not sure" is a real state, and
 *              rounding it to zero is how a budget lies.
 *
 * The bar is stacked because the question is part-to-whole. Every segment
 * carries a written label: these are the status colours, and a status colour
 * with no word beside it is a colour somebody has to guess at.
 */
function renderMoney2(m) {
  const card = document.getElementById('money-card');
  if (!card) return;
  const kpis = document.getElementById('money-kpis');
  const bar = document.getElementById('money-bar');
  const up = document.getElementById('money-upcoming');
  const budgetNote = document.getElementById('money-budget');
  for (const n of [kpis, bar, up]) n.textContent = '';
  budgetNote.textContent = '';

  if (!m) { budgetNote.textContent = 'Loading…'; return; }

  kpi(kpis, 'Settled', money(m.settled), 'orders, paid');
  kpi(kpis, 'Committed', money(m.committed),
    m.upcoming.length ? m.upcoming.length + ' pre-orders, owed at ship' : 'pre-orders, owed at ship');
  kpi(kpis, 'Open grants', money(m.open),
    m.open > 0 ? 'authorised and unresolved' : 'nothing in flight', m.open > 0 ? 'bad' : '');
  if (m.left !== null) {
    kpi(kpis, 'Left', money(m.left), 'of the budget', m.left < 0 ? 'bad' : 'good');
  }

  if (m.budget > 0) {
    budgetNote.textContent = 'budget ' + money(m.budget);
    const used = m.settled + m.committed + m.open;
    const scale = Math.max(m.budget, used);
    const row = el('div', 'moneybar');
    const seg = (cls, v) => {
      if (v <= 0) return;
      const b = el('span', cls);
      b.style.width = (v / scale) * 100 + '%';
      b.title = cls + ' ' + money(v);
      row.appendChild(b);
    };
    seg('settled', m.settled);
    seg('committed', m.committed);
    seg('open', m.open);
    bar.appendChild(row);

    const key = el('div', 'legend');
    const mark = (colour, text) => {
      const w = el('span');
      const dot = el('i');
      dot.style.background = colour;
      w.appendChild(dot);
      w.appendChild(document.createTextNode(text));
      key.appendChild(w);
    };
    mark('var(--accent)', 'settled ' + money(m.settled));
    mark('var(--warn)', 'committed ' + money(m.committed));
    if (m.open > 0) mark('var(--alert)', 'open ' + money(m.open));
    bar.appendChild(key);
    if (used > m.budget) {
      const over = el('div', 'meta stale');
      over.style.marginTop = '8px';
      over.textContent = 'That is ' + money(used - m.budget) + ' past the budget.';
      bar.appendChild(over);
    }
  } else {
    budgetNote.textContent = 'no budget set';
    const hint = el('div', 'meta');
    hint.style.marginTop = '10px';
    hint.textContent =
      'Set a budget under Settings and this becomes a bar with a number left on it. ' +
      'It only ever reads — nothing is stopped by it, so a forgotten figure cannot ' +
      'cost you a drop.';
    bar.appendChild(hint);
  }

  // What is owed, and when. The half of a pre-order that a total cannot say.
  if (m.upcoming.length) {
    const head = el('div', 'name', 'Owed, when it ships');
    head.style.marginTop = '20px';
    up.appendChild(head);
    const box = el('div', 'rows');
    for (const u of m.upcoming) {
      const line = el('div', 'rowline');
      const g = el('div', 'g');
      g.appendChild(el('div', null, u.name));
      g.appendChild(el('div', 'meta',
        [u.retailer, u.releaseDate ? 'ships ' + u.releaseDate : 'no ship date given']
          .filter(Boolean).join(' · ')));
      line.appendChild(g);
      line.appendChild(el('span', 'c', money(u.total)));
      box.appendChild(line);
    }
    up.appendChild(box);
  }
}

function pct(n, of) {
  if (!of) return '0%';
  const p = (n / of) * 100;
  return (p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)) + '%';
}

/**
 * The wins list, in both the places it appears.
 *
 * The preview flag trims it to what fits on a dashboard card and drops the
 * vault status, which belongs next to the button that acts on it.
 *
 * (No backticks in this comment. It lives inside a template literal, and one
 * of them ends the whole page.)
 */
function renderWinsInto(id, rows, preview) {
  const host = document.getElementById(id);
  if (!host) return;
  host.textContent = '';

  if (rows.length === 0) {
    const empty = el('div', 'meta');
    empty.style.marginTop = preview ? '8px' : '0';
    empty.textContent = preview
      ? 'No confirmed orders yet. The first one lands here on its own.'
      : 'No confirmed orders yet. This page fills itself in — a run is only ' +
        'written as a win once the retailer says, on its own page, that the ' +
        'order exists.';
    host.appendChild(empty);
    return;
  }

  for (const w of rows) {
    const row = el('div', 'rowline');
    const g = el('div', 'g');
    g.appendChild(el('div', null, w.productName || 'a product'));
    const bits = [w.retailer, ago(w.at)];
    if (w.quantity > 1) bits.push('×' + w.quantity);
    // A pre-order is not paid for yet, and a wins list that blurs the two is a
    // wins list you cannot budget from.
    if (w.isPreOrder) {
      bits.push(w.releaseDate ? 'PRE-ORDER · ships ' + w.releaseDate : 'PRE-ORDER');
    }
    if (!preview && w.vaultStatus) bits.push('vault: ' + w.vaultStatus);
    g.appendChild(el('div', 'meta', bits.filter(Boolean).join(' · ')));
    row.appendChild(g);

    const right = el('div');
    right.style.textAlign = 'right';
    right.appendChild(el('div', 'c', money(w.total !== null ? w.total : w.unitPrice)));
    // Against MSRP, a price is either a good buy or a bad one. Say which — but
    // only when there is an MSRP to say it against.
    if (w.msrp !== null && w.unitPrice !== null) {
      const d = w.unitPrice - w.msrp;
      const under = d <= 0;
      const note = el('div', 'meta', (under ? '' : '+') + d.toFixed(2) + ' vs MSRP');
      note.style.color = under ? 'var(--in)' : 'var(--warn)';
      right.appendChild(note);
    }
    row.appendChild(right);
    host.appendChild(row);
  }
}

function renderWins() {
  const host = document.getElementById('tab-wins');
  if (!host || host.hidden) return;
  const rows = WINS || [];
  const box = document.getElementById('wins-summary');
  box.textContent = '';
  const orders = rows.filter((w) => !w.isPreOrder);
  const pres = rows.filter((w) => w.isPreOrder);
  const sum = (xs) => xs.reduce((a, w) => a + (w.total !== null ? w.total : 0), 0);
  const units = rows.reduce((a, w) => a + (w.quantity || 1), 0);
  kpi(box, 'Orders', String(orders.length), 'paid', orders.length ? 'good' : '');
  kpi(box, 'Pre-orders', String(pres.length), 'owed at ship');
  kpi(box, 'Items', String(units), 'across all of them');
  kpi(box, 'Settled', money(sum(orders)), 'money actually gone');
  if (pres.length) kpi(box, 'Committed', money(sum(pres)), 'still to be taken');
  renderWinsInto('wins-list', rows, false);
}

let WINS = null;
async function loadWins() {
  const host = document.getElementById('tab-wins');
  if (!host || host.hidden) return;
  try {
    WINS = (await api('GET', '/api/wins')).wins || [];
  } catch (e) {
    WINS = [];
  }
  renderWins();
}

function renderRequests() {
  const card = document.getElementById('requests-card');
  if (!card) return;
  const all = DATA.requests || [];
  const mine = DATA.canCurate === true;
  card.textContent = '';

  // Nothing sent and nothing to work: no empty box on the owner's screen.
  if (all.length === 0) { card.hidden = true; return; }
  card.hidden = false;

  const pending = all.filter((r) => r.status === 'pending');
  card.appendChild(el('div', 'name', mine
    ? (pending.length ? 'Links people sent in — ' + pending.length + ' waiting' : 'Links people sent in')
    : 'Links you sent in'));
  card.appendChild(el('div', 'sub', mine
    ? 'Approve puts it in the shared catalogue and starts the mission on the watchlist of whoever asked.'
    : 'A link goes to the catalogue owner. Once it is added you will see it on your watchlist.'));

  for (const r of all) {
    const row = el('div', 'find');
    const head = el('div', 'name');
    head.appendChild(document.createTextNode(prettyUrl(r.url)));
    const pill = el('span', 'pill ' + (r.status === 'approved' ? 'in' : r.status === 'declined' ? 'out' : ''),
      r.status === 'pending' ? 'WAITING' : r.status.toUpperCase());
    pill.style.marginLeft = '8px';
    head.appendChild(pill);
    row.appendChild(head);

    const bits = [];
    if (mine && r.handle) bits.push('from ' + r.handle);
    if (r.note) bits.push('“' + r.note + '”');
    if (r.decidedNote) bits.push('answer: ' + r.decidedNote);
    if (bits.length) row.appendChild(el('div', 'meta', bits.join(' · ')));

    if (mine && r.status === 'pending') {
      const actions = el('div', 'actions');
      const nameIn = el('input');
      nameIn.placeholder = 'Product name (optional — the slug is a guess)';
      nameIn.style.flex = '1';
      actions.appendChild(nameIn);

      const yes = el('button', 'go', 'Approve');
      yes.type = 'button';
      const msg = el('div', 'msg');
      yes.addEventListener('click', () => withButton(yes, 'Adding…', msg, async () => {
        await api('POST', '/api/requests/' + r.id + '/approve', { name: nameIn.value.trim() });
        await load();
        return 'added to the catalogue';
      }));

      const no = el('button', '', 'Decline');
      no.type = 'button';
      no.addEventListener('click', () => withButton(no, 'Saving…', msg, async () => {
        // The reason is optional but asked for every time, because a decline
        // with no reason is what makes people stop sending links.
        const why = prompt('Why not? (the person who sent it will see this)') || '';
        await api('POST', '/api/requests/' + r.id + '/decline', { note: why.trim() });
        await load();
        return 'declined';
      }));

      actions.appendChild(yes);
      actions.appendChild(no);
      row.appendChild(actions);
      row.appendChild(msg);
    }
    card.appendChild(row);
  }
}

/** A link, shortened to the part a person recognises. */
function prettyUrl(u) {
  try {
    const p = new URL(u);
    const tail = p.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return p.hostname.replace(/^www\./, '') + '/' + tail;
  } catch { return u; }
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
      String(all.length) + ' discoveries are waiting — widen the search to see them.'));
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
    // Same three answers the mission card gives, so a count means the same
    // thing wherever you read it: a number, a floor, or staged.
    const dStock = stockLine(d);
    if (dStock) facts.push(dStock);
    left.appendChild(el('div', 'meta', facts.join(' · ')));

    const tags = el('div', 'tags');

    /*
     * Staged stock leads every other tag on a find, including NEW.
     *
     * On a mission card this is a warning about something you already decided
     * to chase. Here it is the opposite and better thing: units counted in a
     * warehouse behind a listing NOBODY IS WATCHING YET. That is the whole
     * value of a discovery list on a drop night, and until now the sweep read
     * the number and threw it away at the database boundary.
     */
    if (isStaged(d)) {
      tags.appendChild(el('span', 'pill staged', 'STOCK STAGED · DROP NEAR'));
    }

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

    // Belt and braces: the whole list is hidden from a member, and the two
    // buttons that only a curator may press are not built either. A control
    // that exists and fails is worse than one that was never offered.
    if (DATA.canCurate === true) {
      actions.appendChild(keep);
      actions.appendChild(forget);
      left.appendChild(actions);
    }

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
    '. A grant is a buy in progress, or a Phantom that died mid-checkout.';

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
      if (r.requested) { load(); return r.message; }
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

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('on', t.dataset.tab === name);
  }
  for (const n of ['home', 'missions', 'products', 'activity', 'finds', 'wins', 'settings']) {
    document.getElementById('tab-' + n).hidden = n !== name;
  }
  // The two pages that pay for their own data, asked for only when looked at.
  // Both are aggregates over every row ever written; neither belongs on the
  // thirty-second refresh that keeps the watchlist current.
  if (name === 'home') loadInsights();
  if (name === 'wins') loadWins();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}

/*
 * ── The sidebar's one control ──────────────────────────────────────────────
 *
 * On a browser the rail collapses to icons and the choice is remembered per
 * device. localStorage is wrapped because it throws outright in a few contexts
 * (a private window with site data blocked); a menu that cannot remember its
 * width is a small loss, and one that throws on load and takes the page's
 * scripts down with it is the whole app.
 */
function setCollapsed(on) {
  document.body.classList.toggle('nav-collapsed', on);
  const btn = document.getElementById('nav-collapse');
  const label = on ? 'Expand the menu' : 'Collapse the menu';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  try { localStorage.setItem('phantom.nav.collapsed', on ? '1' : '0'); } catch (err) { /* fine */ }
}
try {
  if (localStorage.getItem('phantom.nav.collapsed') === '1') setCollapsed(true);
} catch (err) { /* fine */ }
document.getElementById('nav-collapse').addEventListener('click', () => {
  setCollapsed(!document.body.classList.contains('nav-collapsed'));
});

document.getElementById('see-wins').addEventListener('click', () => showTab('wins'));
document.getElementById('live-all').addEventListener('click', () => showTab('missions'));

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

/*
 * Prove the wiring, rather than waiting for a drop to prove it.
 *
 * The button reports what happened in words: sent, not configured, or the
 * error. "Nothing appeared in Discord" is the one outcome this exists to make
 * impossible to misread.
 */
async function sendTest(kind) {
  const btns = [document.getElementById('discord-test'), document.getElementById('discord-preview')];
  const out = document.getElementById('discord-result');
  btns.forEach((b) => { b.disabled = true; });
  out.hidden = false;
  out.textContent = 'Sending…';
  try {
    const res = await fetch('/api/notify/test?kind=' + kind, { method: 'POST' });
    const body = await res.json();
    if (body.sent) {
      out.textContent = body.items
        ? 'Sent, using ' + body.items.join(', ') + '. Check your channel.'
        : 'Sent. It should be in your channel now.';
    } else if (!body.configured) out.textContent = 'No webhook is configured on the Hub.';
    else if (body.reason) out.textContent = 'Nothing to preview: ' + body.reason + '.';
    else out.textContent = 'The Hub accepted it but reported nothing sent.';
  } catch (err) {
    out.textContent = 'Could not reach the Hub: ' + err.message;
  }
  btns.forEach((b) => { b.disabled = false; });
}

document.getElementById('discord-test').addEventListener('click', () => sendTest('hello'));
// The real alert, with real data, footered as a rehearsal. See the endpoint for
// why waiting cannot show you this when the thing is already in stock.
document.getElementById('discord-preview').addEventListener('click', () => sendTest('stock'));

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
      budgetTotal: f.budgetTotal === '' ? 0 : Number(f.budgetTotal),
      spendCapDay: f.spendCapDay === '' ? null : Number(f.spendCapDay),
      // Blank leaves the sweep cadence as it is — there is no "no sweeps"
      // spelling here on purpose.
      ...(f.sweepEveryHours === '' ? {} : { sweepEveryHours: Number(f.sweepEveryHours) }),
    });
    load();
    return 'saved — applies to every mission';
  });
});

document.getElementById('shops-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = fields(form);
  const msg = document.getElementById('shops-msg');
  await withButton(form.querySelector('button[type=submit]'), 'Saving…', msg, async () => {
    await api('POST', '/api/settings', {
      burstSpacingSeconds: f.burstSpacingSeconds === '' ? 0 : Number(f.burstSpacingSeconds),
      stagedRepeatMinutes: f.stagedRepeatMinutes === '' ? 0 : Number(f.stagedRepeatMinutes),
      // "30, 60" on the page; a list of numbers on the wire. Anything that is
      // not a number is dropped rather than sent as NaN — a schedule that half
      // parses should send fewer posts, never one at an unknown time.
      discordInvite: String(f.discordInvite || '').trim(),
      inStockRepeatAfter: String(f.inStockRepeatAfter || '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    });
    load();
    return 'saved';
  });
});

document.getElementById('drop-open').addEventListener('click', async (e) => {
  const mins = Number(document.getElementById('drop-minutes').value || 60);
  const msg = document.getElementById('shops-msg');
  await withButton(e.target, 'Opening…', msg, async () => {
    await api('POST', '/api/settings', {
      dropModeUntil: new Date(Date.now() + mins * 60000).toISOString(),
    });
    await load();
    return 'drop window open for ' + mins + ' minutes';
  });
});

document.getElementById('drop-close').addEventListener('click', async (e) => {
  const msg = document.getElementById('shops-msg');
  await withButton(e.target, 'Closing…', msg, async () => {
    await api('POST', '/api/settings', { dropModeUntil: '' });
    await load();
    return 'back to the ordinary pace';
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
    a.download = 'phantom-activity-' + new Date().toISOString().slice(0, 10) + '.json';
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
    return 'queued — Phantom sweeps a query per pass from here';
  });
});

document.getElementById('phantom-toggle').addEventListener('click', async (e) => {
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
    return turningOff ? 'Phantom off' : 'Phantom on';
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
      ? 'paused — Phantom will look at nothing until you turn this off'
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

/*
 * The material switch.
 *
 * Only ever a downgrade path. The head script has already decided whether
 * glass is allowed at all; this can turn it off and back on again within that,
 * and it says so when the answer was taken out of its hands — a dead checkbox
 * with no explanation is how people conclude the app is broken.
 */
(function () {
  const box = document.getElementById('material-toggle');
  const note = document.getElementById('material-note');
  let forced = false;
  try {
    forced = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-transparency: reduce)').matches);
  } catch (e) { forced = false; }

  const supported = window.CSS && CSS.supports &&
    (CSS.supports('backdrop-filter', 'blur(1px)') ||
     CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));

  if (forced || !supported) {
    box.checked = false;
    box.disabled = true;
    note.textContent = forced
      ? 'Off because this device asks for reduced transparency. That setting wins.'
      : 'This browser cannot blur what is behind a panel, so the plain surfaces are what you get.';
    return;
  }

  box.checked = document.documentElement.getAttribute('data-material') === 'glass';
  note.textContent = 'Remembered on this device.';
  box.addEventListener('change', () => {
    if (box.checked) document.documentElement.setAttribute('data-material', 'glass');
    else document.documentElement.removeAttribute('data-material');
    try {
      localStorage.setItem('phantom.material', box.checked ? 'glass' : 'plain');
    } catch (e) {
      note.textContent = 'Changed for now — this browser will not remember it.';
    }
  });
})();

/*
 * The overflow, and why it is decided in JS.
 *
 * The rule is "inline where it fits, behind a ⋯ where it does not", and the
 * hidden attribute is what hides it — which CSS cannot then un-hide, because
 * [hidden] is display:none !important at the top of this stylesheet (it has
 * to be; see the note there). So the breakpoint is read here instead, once on
 * load and again whenever the window changes shape.
 *
 * A phone that has opened the menu keeps it open until it is closed. Rotating
 * a phone should not throw away what you just tapped.
 */
/* ── The ribbon ─────────────────────────────────────────────────────────────
 *
 * A profile menu, a bell, a Discord link and a feedback box. Everything here
 * is built from rows the page already has or is hidden until it has somewhere
 * real to point.
 */

/** Close every hanging panel. One rule, so two can never be open at once. */
function closePops(except) {
  for (const [pop, btn] of [['bell-pop', 'bell-open'], ['me-pop', 'me-open']]) {
    if (pop === except) continue;
    const node = document.getElementById(pop);
    const b = document.getElementById(btn);
    if (node) node.hidden = true;
    if (b) b.setAttribute('aria-expanded', 'false');
  }
}

function togglePop(pop, btn) {
  const node = document.getElementById(pop);
  const open = node.hidden;
  closePops(open ? pop : null);
  node.hidden = !open;
  document.getElementById(btn).setAttribute('aria-expanded', String(open));
  if (open && pop === 'bell-pop') markBellSeen();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.pop') || e.target.closest('.ribbon')) return;
  closePops(null);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(null); });

document.getElementById('bell-open').addEventListener('click', () => togglePop('bell-pop', 'bell-open'));
document.getElementById('me-open').addEventListener('click', () => togglePop('me-pop', 'me-open'));
document.getElementById('me-settings').addEventListener('click', () => {
  closePops(null);
  showTab('settings');
});

/*
 * What the bell is FOR.
 *
 * Not a feed of everything that happened — the activity log is that, and it is
 * a different question. This is the short list of things that are true right
 * now and want a person: stock loading before a drop, a waiting room, money
 * authorised and not yet spent, links waiting on a decision, and Phantom
 * having gone quiet.
 *
 * Every row is built from data already on the page. Nothing here polls, and
 * nothing here is invented to fill the panel out: an empty bell says so.
 */
function bellItems() {
  const out = [];
  for (const s of (DATA.stockLoads || []).slice(0, 4)) {
    out.push({
      at: s.at,
      tone: 'alarm',
      text: String(s.message || '').replace('STOCK LOADED: ', ''),
      tab: 'missions',
    });
  }
  for (const q of (DATA.queues || []).slice(0, 3)) {
    out.push({
      at: q.at,
      tone: 'warn',
      text: (q.retailer || 'A shop') + ' is showing a waiting room',
      tab: 'activity',
    });
  }
  for (const a of (DATA.authorisations || []).slice(0, 3)) {
    out.push({
      at: a.grantedAt || a.at,
      tone: 'warn',
      text: 'Money is authorised and not yet spent' +
        (a.total ? ' — ' + money(a.total) : ''),
      tab: 'activity',
    });
  }
  if (DATA.canCurate === true) {
    const waiting = (DATA.requests || []).filter((r) => r.status === 'pending');
    if (waiting.length) {
      out.push({
        at: waiting[0].createdAt || '',
        tone: 'warn',
        text: waiting.length + (waiting.length === 1 ? ' link is' : ' links are') + ' waiting on you',
        tab: 'finds',
      });
    }
  }
  // The silence. Same threshold the banner uses, because two numbers for one
  // idea is how they drift apart.
  const seen = DATA.agentSeenAt ? Date.parse(DATA.agentSeenAt) : NaN;
  if (Number.isFinite(seen) && Date.now() - seen > SILENCE_MS) {
    out.push({
      at: DATA.agentSeenAt,
      tone: 'alarm',
      text: 'Phantom has not reported since ' + ago(DATA.agentSeenAt),
      tab: 'activity',
    });
  }
  return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/*
 * What counts as unread.
 *
 * The newest item's timestamp, against the last one you looked at, kept on
 * this device. Not a server-side read flag: this is a glance, not an inbox,
 * and a badge that needs a round trip to clear is a badge that stays lit.
 */
function bellSeenAt() {
  try { return localStorage.getItem('bell:seen') || ''; } catch (e) { return ''; }
}
function markBellSeen() {
  const items = bellItems();
  const newest = items.length ? String(items[0].at || '') : '';
  try { localStorage.setItem('bell:seen', newest || new Date().toISOString()); } catch (e) { /* fine */ }
  const dot = document.getElementById('bell-dot');
  if (dot) dot.hidden = true;
}

function renderBell() {
  const list = document.getElementById('bell-list');
  const dot = document.getElementById('bell-dot');
  if (!list) return;
  const items = bellItems();
  list.textContent = '';

  if (items.length === 0) {
    const none = el('div', 'bellrow');
    none.textContent = 'Nothing wants you right now.';
    list.appendChild(none);
    if (dot) dot.hidden = true;
    return;
  }

  for (const i of items) {
    const row = el('button', 'bellrow' + (i.tone ? ' ' + i.tone : ''));
    row.type = 'button';
    row.appendChild(el('div', null, i.text));
    if (i.at) row.appendChild(el('div', 'when', ago(i.at)));
    row.addEventListener('click', () => {
      closePops(null);
      showTab(i.tab);
    });
    list.appendChild(row);
  }

  const newest = String(items[0].at || '');
  if (dot) dot.hidden = !(newest && newest > bellSeenAt());
}

/*
 * Who you are, in the corner.
 *
 * The handle was a badge beside the summary and nothing else. Making it a
 * menu gives the two things that were cluttering the header a home — how it
 * works, and installing the app — and puts signing out where every other app
 * on earth keeps it.
 */
function renderMe() {
  const me = DATA.me || {};
  const handle = String(me.handle || DATA.you || '');

  for (const id of ['me-initial', 'me-face']) {
    const node = document.getElementById(id);
    if (node) node.textContent = (handle.trim()[0] || '·').toUpperCase();
  }
  const name = document.getElementById('me-handle');
  if (name) name.textContent = handle || 'Signed in';
  const since = document.getElementById('me-since');
  if (since) since.textContent = me.since ? 'here since ' + shortDate(me.since) : '';

  /*
   * What this account MAY do, said as the rights themselves.
   *
   * One sentence describing "your role" collapses two separate permissions
   * that the store keeps deliberately apart — curating the shared catalogue
   * and instructing a machine to spend. They will come apart in practice, so
   * the panel names them one by one rather than inventing a word for the
   * combination.
   */
  const rights = document.getElementById('me-rights');
  if (rights) {
    rights.textContent = '';
    rights.appendChild(el('span', 'pill ' + (me.canArm ? 'flag' : 'info'),
      me.canArm ? 'MAY BUY' : 'WATCHING ONLY'));
    if (me.canCurate) rights.appendChild(el('span', 'pill info', 'CURATES THE CATALOGUE'));
    if (!me.canArm && !me.canCurate) {
      rights.appendChild(el('span', 'pill info', 'THE MACHINE IS THE OWNER’S'));
    }
  }

  /*
   * What it has actually done, which is a different question from what it may
   * do, and the more interesting one. Counted from this account's own rows.
   */
  const stats = document.getElementById('me-stats');
  if (stats) {
    stats.textContent = '';
    const stat = (n, label) => {
      const box = el('div', 'me-stat');
      box.appendChild(el('b', null, String(n)));
      box.appendChild(el('span', null, label));
      stats.appendChild(box);
    };
    stat(me.missions ?? 0, 'watching');
    stat(me.armed ?? 0, 'armed');
    stat(me.bought ?? 0, me.bought === 1 ? 'order' : 'orders');
    stat(money(me.spent ?? 0), 'spent');
  }

  const vault = document.getElementById('me-vault');
  if (vault) {
    vault.textContent = me.vaultLinked
      ? 'Linked to DNA Card Vault — wins can go to your collection.'
      : 'Not linked to DNA Card Vault.';
  }

  // Hidden until somebody sets an invite. A button that goes nowhere is worse
  // than no button, and the webhook is a credential, not an address.
  const dl = document.getElementById('discord-link');
  const invite = (DATA.settings && DATA.settings.discordInvite) || '';
  if (dl) {
    dl.hidden = !invite;
    if (invite) dl.href = invite;
  }
}

document.getElementById('flt-missions-more').addEventListener('click', () => {
  FILTERS_OPEN.missions = !FILTERS_OPEN.missions;
  render();
});

document.getElementById('wiz-open').addEventListener('click', () => openWizard(0));
document.getElementById('wiz-close').addEventListener('click', closeWizard);
document.getElementById('wiz-back').addEventListener('click', () => {
  WIZ_STEP -= 1;
  renderWizard();
});
document.getElementById('wiz-next').addEventListener('click', () => {
  if (WIZ_STEP >= wizSteps().length - 1) { closeWizard(); return; }
  WIZ_STEP += 1;
  renderWizard();
});

document.getElementById('quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await withButton(form.querySelector('button[type=submit]'), 'Adding…', quickMsg, async () => {
    const r = await api('POST', '/api/quick-add', { url: quickUrl.value.trim() });
    form.reset();
    history.replaceState(null, '', '/');
    load();
    // An account that cannot write the catalogue gets a REQUEST back instead
    // of a product. Say what actually happened rather than reading a name off
    // an object that was never sent.
    if (r.requested) return r.message;
    return r.alreadyTracked
      ? 'already watching that one — nothing changed'
      : 'watching “' + r.product.name + '” — set a ceiling before arming it';
  });
});

if (location.pathname === '/add' || sharedUrl()) openQuickAdd(sharedUrl());

// The dashboard is the landing tab, so its numbers are asked for once on the
// way in — not on the refresh timer, which is for the watchlist.
loadInsights();

let timer = setInterval(load, 30000);
document.getElementById('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 30000);
});
load();
</script>
</body></html>`;
}
