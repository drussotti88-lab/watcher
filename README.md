# Pokémon buying system

Two halves of one problem, built separately because they fail differently.

## Half A — knowing

**`watcher/`** — Node + Playwright, runs on the desk. A real Chrome on a real
residential connection, because that is the only thing that reaches these
retailers: a Hub in a datacentre gets 403 from all three.

Reads price and stock from Pokémon Center, Target and Walmart. Each needed a
different strategy, and every reader was written from a recorded page rather
than from guessed CSS selectors:

| Retailer | Where the truth lives |
|---|---|
| Pokémon Center | schema.org JSON-LD in the page |
| Target | the page's own API calls, captured during hydration |
| Walmart | the `__NEXT_DATA__` blob |

**`hub/`** — Vercel + Supabase. The Watcher's memory: watchlist, dedupe ledger,
product identity, alerts. It does not watch anything itself.

## Half B — owing

**`PokeTrack/`** — Python, the working v1. Orders out, money due, release dates.
The half this project actually started as, and the half still to be rebuilt on
the spine above.

## The two findings that would have cost money

**Target says `sold_out: false` on an out-of-stock item.** It appears to mean
*discontinued*. The field that answers "can I buy this, shipped, now" is
`fulfillment.shipping_options.availability_status`. A reader trusting
`sold_out` would fire a purchase at 3am against nothing.

**Walmart says `IN_STOCK` at $73.76 from `sellerType: EXTERNAL`.** A marketplace
reseller at half again over MSRP. Price and stock alone are enough to buy from a
scalper unattended, so every reading carries its seller.

Neither is reachable by reasoning about the APIs. Both came from reading what
the sites actually sent.

## Running it

```bash
cd watcher && npm install && npm test     # 94 tests
cd hub     && npm install && npm test     # 37 tests, real Postgres via PGlite
```

Each folder's README has the setup.
