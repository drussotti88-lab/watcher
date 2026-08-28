# Watcher

Watches retailers from **your machine, on your connection**, because that's the
only way these three sites can be watched at all — and it's free, which the
alternative isn't.

This first release does **two things**, deliberately. Until we know what Pokémon
Center, Target and Walmart actually serve a real browser from your address,
everything downstream is guesswork.

---

## Setup

```powershell
cd C:\Users\danru\Pokemon\watcher
npm install
copy watcher.config.example.json watcher.config.json
```

`npm install` pulls Playwright — about 30 seconds. It does **not** download a
browser, because the default config uses the Chrome you already have.

---

## 1. Can this machine see them?

```powershell
npm run probe
```

A Chrome window opens, visits each retailer, and reports back. Let it work —
the window appearing is the point.

You'll get something like:

```
  RETAILER         MS     VERDICT
  ──────────────────────────────────────────────────────────
  pokemoncenter   4821  reachable — 412KB of real page
                        "New Releases | Pokémon Center"
  target          3140  CHALLENGED — Press-and-hold check
  walmart         2903  reachable — 380KB of real page
```

**This is the number that decides the architecture.** A cloud Worker got 403
from all three. If a real browser here gets through, the Watcher is the data
path and everything else follows.

Note what this is *not*: a `curl` test. Bot protection reads the TLS handshake
and header ordering, so a command-line client fails regardless of what address
it comes from. Only a real browser making a real navigation answers this
honestly.

---

## 2. Sign in once

If the probe shows challenges, do this before concluding anything:

```powershell
npm run browser
```

Opens the Watcher's **own** Chrome profile — separate from your everyday one, so
it won't fight it and won't touch your normal session. Sign in to whichever of
the three you have accounts with, then Ctrl+C.

Then run `npm run probe` again. A signed-in session is treated very differently
from a cold one, and this alone flips some retailers from challenged to fine.

---

## What's here already

The money rails are written and tested — 21 tests, no network, no spending:

```powershell
npm test
```

They cover every way an unattended buyer loses money at 3am:

| Guard | Prevents |
|---|---|
| Price ceiling, checked twice | Detected at $30, charged $54 |
| Duplicate lock | The loop runs 4× and buys 4 |
| Per-run and per-day caps | Six fire at once, you wake to $500 |
| Cart re-verification | Page said one thing, cart says another |
| Fail closed on spend | Hub unreachable → keep watching, never buy |
| Dry run | You cannot test a checkout by buying things |

`live` is `false` in the config and should stay there until you've watched a dry
run do the right thing.

---

## What isn't built yet

Stock reading per retailer, the sweep loop, Hub wiring, and the checkout flow
itself. That's next, and the probe result shapes all of it — there's no point
writing a Pokémon Center reader before knowing whether this machine can load a
Pokémon Center page.

The checkout step specifically needs building **together, with a browser window
open**, because it depends on what each site's cart actually looks like. Writing
those selectors blind would be guessing, and guessing is the one thing the whole
design refuses to do.

---

## Config

`watcher.config.json` — gitignored, holds your Hub token, treat it like a saved
password.

| Key | Meaning |
|---|---|
| `hub.url` / `hub.token` | Your deployed Worker. Blank runs standalone |
| `browser.channel` | `chrome` uses your install. `chromium` makes Playwright fetch one |
| `browser.executablePath` | Only if Chrome is somewhere unusual |
| `browser.headed` | `true` = you watch it work. Keep it that way for now |
| `budget.perRun` / `perDay` | Hard spend caps. Refused loudly, never silently |
| `live` | `false` stops before every submit. **Leave it false** |
| `intervalSec` | Seconds between sweeps, once the loop exists |

The config refuses to load if `perRun` exceeds `perDay`, or if `live` is true
with no Hub — spending has to be authorised somewhere that survives this process
dying.
