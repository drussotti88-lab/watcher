# Phantom

Watches three retailers from **your machine, on your connection**, because that
is the only way these three can be watched at all. Pokémon Center, Target and
Walmart all refuse a datacentre outright; a real browser on a home connection
isn't imitating a legitimate visitor, it is one.

**Setting this up for the first time? Read [SETUP.md](SETUP.md)** — or just
double-click `1 - Set up`. This file is developer notes.

---

## What it does today

- Reads a product page at all three retailers — price, stock, seller,
  order limit, street date, pre-order.
- Sweeps all three catalogues for things worth watching, and files them for
  you to keep or forget.
- Reports every check to the Hub, with a scrubbed activity log.
- Paces itself per retailer, backs off when challenged, and sleeps outside the
  hours you set.

**It can buy, at Target only, and only when four separate things are true.**
This line used to say there was no checkout code at all. That stopped being
true on 31 Aug 2026, and a file promising otherwise — about money, to a
person deciding whether to trust this on their own machine — is the kind of
stale sentence worth going out of the way to correct.

What has to be true before a single order is placed: the account holds
`can_arm`; a daily spend cap is set; the mission is armed with a price
ceiling; and `live` is true in `watcher.config.json`, which ships false. With
`live` false the whole flow runs and stops on the line before the button.
Walmart and Pokémon Center have no checkout at all.

## Commands

```
npm run setup     first run: checks the machine, asks for the Hub and a token
npm run watch     the real thing. Leave it running
npm run stop      ask a running Phantom to stop cleanly, from anywhere
npm run once      one pass, then exit. The first thing to try when something looks wrong
npm run scan      read a Target search URL and sort it into what is worth watching
npm run discover  the same scan, remembered, reported to the Hub
npm run probe     open each retailer and report whether this machine can read it
npm run inspect   dump everything one page will tell us, into probe-artifacts/
npm test          the whole suite. No network, nothing spent
npm run package   build the zip to hand to somebody else
```

## The two browser profiles

`chrome-profile-watch` is **signed out**, and that is the whole point. It does
all the polling, generates all the traffic, and carries none of the risk — the
worst case is a challenge that clears itself.

`chrome-profile-buy` is signed in, opens rarely, and is the one that would ever
hold payment details. Keeping it out of the polling loop is what stops the noisy
half costing you the account.

**Do not sign in to the watch profile.** An earlier version of this file said to,
and it was wrong: it defeats the split entirely.

## Config

`watcher.config.json` — gitignored, holds your Hub token, treat it like a saved
password. `npm run setup` writes it for you.

| Key | Meaning |
|---|---|
| `hub.url` / `hub.token` | The Hub, and your own token. Blank runs standalone |
| `browser.channel` | `chrome` uses your install — the default, and the right one |
| `browser.executablePath` | Only if Chrome is somewhere unusual |
| `browser.headed` | `true` means you can watch it work |
| `budget.perRun` / `perDay` | **Requests, not dollars.** How many page reads per pass and per day |
| `live` | `false` stops before every submit. Nothing exists to submit yet |
| `intervalSec` | Seconds between passes |

`budget` is worth reading twice: it caps **how often the shops are touched**,
not how much money could leave. There is no money cap yet — see the roadmap. A
mission's price ceiling limits what one purchase may cost and nothing limits the
total.

## The money rails, honestly

Written and tested, and not all of them are connected to anything yet:

| Rail | State |
|---|---|
| Kill switch (`npm run stop`, and the app's toggle) | **built** |
| Seller check — a marketplace listing is refused before the price is looked at | **built** |
| Pre-order check — a pre-order is refused unless the mission allows one | **built** |
| Cart re-verification (`verifyCart`) | written and tested; **nothing calls it**, because nothing fills a cart |
| Dry run (`live: false`) | the switch exists; **there is no flow for it to interrupt** |
| Per-run / per-day money cap | **not built** |
| Duplicate lock per product per event | **not built** |

The load-bearing rule underneath all of it: **fail open on watching, fail closed
on spending.** A Hub that is briefly unreachable must not stop us looking at
pages — but it must stop us buying, because an unreachable Hub is exactly when a
duplicate purchase is most likely.
