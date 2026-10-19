# Phantom by DNA: rules for any session working in this repo

Phantom (older name: "the Watcher") watches Pokémon Center, Target and Walmart from the owner's own PC and can buy at Target under strict rails. The owner is Dan (older docs say "Roberto"). He is not technical: no terminal for him; he approves anything that reaches members, the app, the database or money.

## Layout

- `watcher/`: the agent. Node 22+, TypeScript run with `--experimental-strip-types`, Playwright driving the user's real Chrome. Runs on the owner's Windows PC.
- `hub/`: "the app". One Vercel function (`hub/api/index.js`, a committed esbuild bundle of `hub/src`) + Postgres in the **`watcher` Supabase project** (ref `riwdybozflszkpcpdinc`), separate from DNA's shared project. Live at https://watcher-gold.vercel.app.
- `PokeTrack/` (old Python Half B v1), root `*.html` briefs and root `*-migration.sql` files are history; don't build on them.

## Hard rules

1. **Never start Phantom from a remote shell** (`cycle.ps1`, `start ""`, `npm run watch`, a launcher). A later command ending in that console sends it Ctrl+C. The keeper (Task Scheduler `\Phantom\keeper`) restarts it; the owner double-clicks `2 - Start watching`. A session doesn't start, stop or restart the owner's Phantom at all unless he asks.
2. **Don't touch the owner's live state from a session:** no arming, no `can_arm` changes, no mission edits, no `live` flips, no spend-cap changes. Read-only queries are fine.
3. **Fail open on watching, fail closed on spending.** An unreachable app, an unknown seller, a pre-order the mission didn't allow, a cart that doesn't verify: each stops the buy and never stops the reading.
4. **Spending needs all four:** account `can_arm`, a daily spend cap, an armed mission with a ceiling, and `live: true` in `watcher.config.json` (ships `false`). Never remove or bypass one, and never let one Phantom spend for a user whose token it doesn't hold.
5. **Rung-4 line:** no CAPTCHA solving, fingerprint spoofing, IP rotation, queue bypass, or switching profiles to dodge a wall. A wall is detected, announced and waited out (`challenge.ts`, `rate.ts`); clearing it is a person's job.
6. **Never sign in to `chrome-profile-watch`.** Only `chrome-profile-buy` is signed in, and it opens only to buy.
7. **No secrets in the repo, in chat or in logs.** The repo is **public**. Tokens live hashed in the DB and in each machine's gitignored `watcher.config.json`; app secrets live in Vercel and `hub/.env.local`. Never commit `*-watcher-token.txt`, `*-invite.txt`, `*-password.txt`, `chrome-profile*`, `logs/`, `probe-artifacts/`. Name env vars, never print their values.
8. **No card, address, credential or order number is stored in the app.** Everything that leaves the PC goes through `scrub()` first; `hub/src/scrub.ts` and `watcher/src/scrub.ts` must stay byte-identical (a test checks).

## Database

- **Schema before code, never in one step.** Put the change in `hub/schema.sql`, idempotent (`create table if not exists`, `add column if not exists`), give the owner the full SQL block to run in the **`watcher`** Supabase project's SQL editor, confirm it's applied, then ship the code that uses it.
- No DROP, DELETE or TRUNCATE from a session; hand the owner the line.
- `residency.test.ts` reads the owned tables from `schema.sql`; keep it passing when you add one.

## Building and shipping

- Tests: `cd watcher && npm test`; `cd hub && npm test` (real Postgres via PGlite). `npm run typecheck` in both. No network in tests, nothing spent.
- **After any change to `hub/src`: `cd hub && npm run bundle` and commit `hub/api/index.js` with it.** Vercel runs no build; an unbundled change never reaches production.
- After a `watcher/` change testers should get: `cd watcher && npm run package` (writes `hub/src/generated/phantom-zip.ts`), then `npm run bundle` in `hub/`, and commit both. `package` refuses a zip whose VERSION isn't a commit or that contains a forbidden file; don't work around it.
- Every setting the handler reads must be passed through `env()` in `hub/src/server.ts`; a name declared in `types.ts` but missing there is silently undefined in production.
- The cross-package contract (`hub/test/phantom-contract.test.ts`) names every field the agent reads from the app. Change both halves together.
- Branch `phantom/<slug>` from `origin/main`, run both test suites, open a PR with the full link. **A session never merges.** The owner merges on github.com as `drussotti88-lab` so the deploy runs.
- Auto-update never restarts a Phantom within 90 minutes of a scheduled drop, and never on a `dev` checkout. Keep both refusals.

## Style

- Comments say why, in plain sentences, with the incident that taught it.
- Test names state the rule they hold (`A REQUESTED CHECK DOES NOT JUMP THE RETAILER`).
- A guard that passes on an empty list is a comment, not a guard: test it against a case that should fail.
- Words: the agent is **Phantom**, the cloud side is **the app**. Keep data and infrastructure names as they are (`'watcher'` enum values, `watcher.config.json`, the `watcher/` folder, the repo, `watcher-gold.vercel.app`).
- Times shown to the owner are Central (CT).

## Linked to DNA Card Vault

The Vault (repo `drussotti88-lab/dna-card-vault`) is boss for identity and the Phantom tier. Messages both ways are HMAC-SHA256 over `PHANTOM_SHARED_SECRET`; `hub/src/vault.ts` and the Vault's `src/lib/phantom.js` must stay byte-compatible. Vault-side changes (SSO, entitlement, acquisitions, `tier.phantom`, PayPal plans) are made in the Vault repo under its own rules, never from here.
