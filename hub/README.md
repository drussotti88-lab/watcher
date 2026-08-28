# Hub

The Watcher's memory. It holds the watchlist, keeps the dedupe ledger, mints
product identity, and sends the alerts. It does **not** watch anything itself.

That last part is settled, not a design preference. A Hub in a datacentre gets
403 from pokemoncenter.com, target.com and walmart.com. A real Chrome on your
own connection reaches all three and reads their prices. So the machine on the
desk does the looking, and this remembers.

It also serves the web app: a page showing what is being watched, what is in
stock, at what price, from which seller, and how stale each reading is.

**Stack:** Vercel · Supabase (Postgres). All free tier. Discord is optional and
off by default — `notify.ts` posts nothing when no webhook is set.

## Why there is no cron

Vercel's Hobby plan runs cron once a day, with up to an hour of slop. That
would be fatal if the Hub were doing the watching — it isn't. The Watcher runs
every minute on your PC and calls `POST /sweep` on whatever rhythm suits.

The one thing cloud cron could add is sweeping while your PC is off, and that
was ruled out by the 403s above. Nothing is lost.

## Setup

### 1. Database

Create a Supabase project, then click **Connect** at the top of the project
dashboard and choose **Shared pooler → Transaction mode**.

Supabase offers three strings and two of them will not work here:

| | Host | Works from Vercel? |
|---|---|---|
| Direct connection | `db.<ref>.supabase.co:5432` | **No** — IPv6 only |
| Dedicated pooler | `db.<ref>.supabase.co:6543` | **No** — IPv6 only, and paid |
| **Shared pooler** | `aws-N-<region>.pooler.supabase.com:6543` | **Yes** |

Both of the wrong ones connect perfectly from a laptop and fail every time in
production, because Vercel's functions are IPv4 and `db.<ref>.supabase.co`
resolves over IPv6 unless you buy the add-on. `src/db.ts` refuses them by
**host**, not by port — an earlier version checked only the port and waved the
dedicated pooler straight through.

The giveaway on a correct string: the username carries the project ref
(`postgres.<ref>`), and the host contains `pooler.supabase.com`.

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
npx vercel env add APP_PASSWORD production
npx vercel env add INGEST_TOKEN production
npm run deploy
```

`INGEST_TOKEN` is a long random string you invent — it is what the Watcher
presents:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`APP_PASSWORD` is the password for the web page. There are no accounts because
there is one user. It also signs the session cookie, so changing it signs you
out everywhere — which is what you want from changing a password.

**Neither being set means that door is shut, never open.** A dashboard that
went public because someone forgot an environment variable is the failure this
is built to avoid, and there is a test named after it.

### 3. Check

```bash
curl https://<your-deployment>/health
```

Public, and the only public endpoint. Everything that changes state or costs a
request needs `Authorization: Bearer <INGEST_TOKEN>`.

## API

| Method | Path | Auth | What |
|---|---|---|---|
| `GET` | `/` | password | The page |
| `GET` | `/health` | — | Is it up, and what does each source look like |
| `GET` | `/api/dashboard` | either | Everything the page renders, in one request |
| `POST` | `/observations` | token | The Watcher reports what it saw |
| `GET` | `/watchlist` | token | `products` to poll, and `sources` to hunt in |
| `POST` | `/ingest` | token | The Watcher posts what it saw |
| `POST` | `/sweep` | token | Sweep sources the Hub can fetch itself (`?source=<id>` for one) |
| `GET` | `/probe` | token | Which sources this deployment can actually reach |

`/probe` is worth running once after deploying. It reports, from Vercel's own
egress, which sources are fetchable — and every retailer that comes back
`BLOCKED` belongs to the Watcher. Right now that is all of them, which is why
`seed.sql` puts every source on `via = 'watcher'`.

## Two tables for what the Watcher sees

`watch_state` holds one row per (product, retailer) and is **upserted on every
check**, so the page can always say how stale a reading is. A dashboard that
cannot tell you it is out of date is worse than no dashboard.

`observations` is append-only history and is written **only when something
material changed** — state, price, or seller. Polling a static product every
minute for a week is ten thousand checks and zero rows. That is what makes the
history readable, and why "in stock since" means what it says instead of
resetting every time we look.

The first ever sighting is recorded but not counted as a change. Otherwise
switching the Watcher on announces everything at once — the same mistake the
discovery seeding logic exists to avoid.

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

66 tests, running against **real Postgres** — PGlite, compiled to WebAssembly,
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
src/app.ts         The API and pages, as Request → Response
src/auth.ts        Bearer token for the Watcher, signed cookie for the browser
src/page.ts        The two HTML documents. No framework, no build step
src/db.ts          The database seam: Sql interface + Postgres adapter
src/store.ts       Every SQL statement. Nothing above here writes SQL
src/discover.ts    Sweep, rotate, seed-or-announce
src/fetcher.ts     HTTP with timeouts, plus probeUrl
src/filter.ts      Keyword filters and dedupe
src/notify.ts      Discord. An unreachable webhook must not kill a sweep
src/parsers/       sitemap, jsonList, identify (product key minting)
scripts/migrate.ts Applies a .sql file. Replaces `wrangler d1 execute`
```
