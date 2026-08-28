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

`api/index.js` is a committed bundle of `src/server.ts` and everything it
imports, so **Vercel runs no build step at all** — it just deploys the file.

Both halves of that were learned the hard way. Shipping TypeScript failed
because Vercel compiled the entry file, left the `./app.ts` specifier as
written, and never compiled `src/`. Adding a `build` script then failed
differently: it flipped Vercel out of zero-config into static-site mode, which
demands an output directory this project will never have.

So: rebuild with `npm run bundle` after changing anything in `src/`, and commit
the result. A test compares the committed bundle against a fresh build and
fails if you forget.

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

## Products, listings, missions

Three things, and the distinction between them is the design:

- **product** — the thing itself. "Pitch Black Elite Trainer Box."
- **listing** — somewhere you can buy it: a retailer, its id, a URL. A product
  has many listings, **including several at the same retailer**. Walmart puts
  every seller's offer on one item page; Target's third-party sellers appear to
  get their own item id. Today each product has one listing per retailer, and a
  second one is an INSERT rather than a migration.
- **mission** — a listing plus what you have authorised: enabled, armed,
  ceiling, quantity, seller policy, how often to check.

**One mission per listing, enforced by the schema.** Two armed missions pointing
at the same listing is two purchases of the same item.

**A mission cannot arm without a ceiling.** `armed` with no ceiling is an open
cheque; it is refused where a person sets it, not only where the Watcher reads
it.

**Seller policy defaults to `retailer_only`.** The point of this is buying at
retail before the resellers do. An IN_STOCK marketplace listing at 1.5× MSRP is
the thing you are racing, not the thing you want.

Paste a product URL and the retailer and id are read out of it. Category URLs
are refused — Target's `A-` is an item and `N-` is a category, and a mission
pointed at a category polls a page with no product on it forever.

## Mission runs

**Not one row per poll.** A run is written when a mission *did something or
could not*: stock appeared and it acted, or a check failed. Routine "still out
of stock" is not a run, or the four rows that matter drown under ten thousand
that don't.

Outcomes: `in_stock`, `bought`, `declined`, `failed`, `blocked` — and every one
that isn't a plain success carries a **reason in words**, filled in with a
placeholder if the caller forgets. A run marked `failed` with an empty reason is
the log line you find at 3am and learn nothing from.

Each run records its duration, so detection-to-order time is measured rather
than estimated.

## Two tables for what the Watcher sees

`watch_state` holds one row per **listing** and is **upserted on every check**, so the page can always say how stale a reading is. A dashboard that
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

## The page is tested by being used

`page.test.ts` loads the real HTML into a real DOM, fills the real fields,
clicks the real buttons, and asserts on what reaches the network.

It exists because of a bug 98 passing tests were blind to. The add-product form
read its name as `form.name` — which is a form's **own name attribute**, not the
input called "name". Every submission sent an empty name and came back "a
product needs a name". Since the name box plainly had a name in it, the only
field left to suspect was the date, which looked required when it never was.

Every other test in the suite exercised the API the page calls. Not one of them
pressed the button. Forms are read through `FormData` now, which cannot be
shadowed by a form property, and these tests press the buttons.

## Testing

```bash
npm test
```

114 tests, running against **real Postgres** — PGlite, compiled to WebAssembly,
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

And `bundle.test.ts` tests **the artifact that actually deploys** — it runs
esbuild and serves the output over real HTTP. That test exists because the
first deploy had 66 green tests, a successful build, and a function that died
on startup with `Cannot find module '/var/task/hub/src/app.ts'`. Vercel had
compiled the entry file, left the `./app.ts` specifier exactly as written, and
never compiled `src/` at all. Every test passed because they all import the
TypeScript directly and none of them cared how it was packaged.

It also asserts the committed `api/index.js` matches a fresh build, so the
artifact cannot drift behind the source it was made from.

## Layout

```
api/index.js       The deployed bundle. Generated and committed — do not edit
src/server.ts      Vercel adapter — the only platform-specific file
scripts/bundle.ts  Build options, shared by the build and the test that checks it
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
