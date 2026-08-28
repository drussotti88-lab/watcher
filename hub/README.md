# Hub

The Watcher's memory. It holds the watchlist, keeps the dedupe ledger, mints
product identity, and sends the alerts. It does **not** watch anything itself.

That last part is settled, not a design preference. A Hub in a datacentre gets
403 from pokemoncenter.com, target.com and walmart.com. A real Chrome on your
own connection reaches all three and reads their prices. So the machine on the
desk does the looking, and this remembers.

**Stack:** Vercel (API) · Supabase (Postgres) · Discord (alerts). All free tier.

## Why there is no cron

Vercel's Hobby plan runs cron once a day, with up to an hour of slop. That
would be fatal if the Hub were doing the watching — it isn't. The Watcher runs
every minute on your PC and calls `POST /sweep` on whatever rhythm suits.

The one thing cloud cron could add is sweeping while your PC is off, and that
was ruled out by the 403s above. Nothing is lost.

## Setup

### 1. Database

Create a Supabase project, then from **Project Settings → Database →
Connection string → Transaction pooler** copy the connection string. It ends in
`:6543/postgres`.

Port **6543**, not 5432. `src/db.ts` refuses 5432 deliberately: a direct
connection works fine locally and exhausts Postgres' connection limit once a
handful of serverless functions are warm.

```bash
cp .env.example .env.local     # then paste your values in
npm install
npm run db:push                # creates the tables
npm run db:seed                # three retailers, three known-good products
```

`schema.sql` is `IF NOT EXISTS` throughout and `seed.sql` is
`ON CONFLICT DO NOTHING` throughout, so both are safe to run again.

### 2. Deploy

```bash
npx vercel link
npx vercel env add DATABASE_URL production
npx vercel env add DISCORD_WEBHOOK_URL production
npx vercel env add INGEST_TOKEN production
npm run deploy
```

`INGEST_TOKEN` is a long random string you invent:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Check

```bash
curl https://<your-deployment>/health
```

Public, and the only public endpoint. Everything that changes state or costs a
request needs `Authorization: Bearer <INGEST_TOKEN>`.

## API

| Method | Path | Auth | What |
|---|---|---|---|
| `GET` | `/health` | — | Is it up, and what does each source look like |
| `GET` | `/watchlist` | token | `products` to poll, and `sources` to hunt in |
| `POST` | `/ingest` | token | The Watcher posts what it saw |
| `POST` | `/sweep` | token | Sweep sources the Hub can fetch itself (`?source=<id>` for one) |
| `GET` | `/probe` | token | Which sources this deployment can actually reach |

`/probe` is worth running once after deploying. It reports, from Vercel's own
egress, which sources are fetchable — and every retailer that comes back
`BLOCKED` belongs to the Watcher. Right now that is all of them, which is why
`seed.sql` puts every source on `via = 'watcher'`.

## Design notes that matter

**A new row in `discoveries` *is* a discovery event.** That table is the dedupe
ledger, unique on `(source_id, external_id)`. Everything else follows from it.

**A source seeds silently.** The first full sweep records the back catalogue
without announcing it, so switching a source on doesn't fire two hundred
alerts. With a rotating cursor, "seeded" means a *complete lap* of the index,
not one window — declaring it after one pass makes the next window look
entirely new, which is the same alert storm by a different route.

**The Hub mints identity; retailers only supply aliases.** `products` owns the
key, `aliases` points at it. A retailer changing its SKU is an alias edit, not
a migration, and it is what lets one product be watched at three retailers.

**Write only when something changed.** Never a row per poll. The original
reason was D1's write quota; the reason it survived the move to Postgres is
that a table with a row per poll is unreadable, and this data is meant to be
looked at — Supabase gives you a table editor, so use it.

## Testing

```bash
npm test
```

37 tests, running against **real Postgres** — PGlite, compiled to WebAssembly,
in the test process. The previous version tested SQL against SQLite, which
agrees with Postgres right up until it doesn't:

- SQLite returns `1` for a boolean column; Postgres returns `true`. Every
  `seeded === 1` in the codebase was silently false after the port. A source
  would have re-seeded on every sweep and therefore announced **nothing** —
  a monitor that runs perfectly and never tells you anything.
- Postgres returns `NUMERIC` as a *string*, to preserve precision. `"73.76"`
  compared against a price ceiling does the wrong thing quietly rather than
  throwing. `store.ts` coerces on the way out, and a test asserts both halves.

Neither of those is reachable from a SQLite fake. That is the entire argument
for PGlite.

The HTTP surface is tested too, which the Worker version never was: the handler
is `Request → Response` and takes its database as an argument, so the whole API
runs in-process with no server and no platform mocks.

## Layout

```
api/index.ts       Vercel adapter — the only platform-specific file
src/app.ts         The API, as Request → Response
src/db.ts          The database seam: Sql interface + Postgres adapter
src/store.ts       Every SQL statement. Nothing above here writes SQL
src/discover.ts    Sweep, rotate, seed-or-announce
src/fetcher.ts     HTTP with timeouts, plus probeUrl
src/filter.ts      Keyword filters and dedupe
src/notify.ts      Discord. An unreachable webhook must not kill a sweep
src/parsers/       sitemap, jsonList, identify (product key minting)
scripts/migrate.ts Applies a .sql file. Replaces `wrangler d1 execute`
```
