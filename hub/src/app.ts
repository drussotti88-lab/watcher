/**
 * The Hub's HTTP surface, as a plain function of Request → Response.
 *
 * Deliberately not a framework handler. `createHandler` takes its database and
 * environment as arguments and returns something you can call directly with a
 * `Request`, which means the whole API is testable in-process with no server,
 * no port, and no mocking of a platform's request object. `api/index.ts` is a
 * twelve-line adapter that turns Vercel's Node request into one of these.
 *
 * It also means the platform is swappable. This code ran on Cloudflare Workers
 * yesterday; the only part that had to change was the adapter and the SQL.
 *
 * ── On the missing cron ──────────────────────────────────────────────────────
 *
 * There is no scheduled entrypoint any more, and that is not a regression.
 * Vercel's Hobby plan runs cron once a day with an hour of slop, which is
 * useless for this. But the Hub never needed a scheduler: Phantom on the
 * desk already runs every minute, and it calls POST /sweep on whatever rhythm
 * we choose. The one thing cloud-side cron could have added — sweeping while
 * that machine is off — was ruled out when this Hub got 403 from all three
 * retailers. It cannot usefully watch them from a datacentre regardless.
 */
import type { Env, Discovered, SweepResult } from './types.ts';
import type { Sql } from './db.ts';
import { sweepAll, sweepSource } from './discover.ts';
import * as store from './store.ts';
import { announce, reportOps } from './notify.ts';
import { applyFilters, dedupe } from './filter.ts';
import { probeUrl } from './fetcher.ts';
import {
  identify,
  mintSession,
  sessionCookie,
  clearCookie,
  sessionSecret,
  signIn,
} from './auth.ts';
import { scrub, looksSensitive } from './scrub.ts';
import {
  verifyLaunchToken,
  checkEntitlement,
  deliverAcquisition,
  searchVaultSealed,
  vaultConfigured,
} from './vault.ts';
import { loginPage, ssoPage, dashboardPage } from './page.ts';
import { identifyListing } from './parsers/identify.ts';
import { MANIFEST, SERVICE_WORKER, iconResponse } from './pwa.ts';
import { capabilityTable } from './capabilities.ts';

/**
 * The source a Phantom-side sweep reports into.
 *
 * One name, in one place. Phantom posts here and the Hub reads its
 * last_swept_at to decide when the next one is due, so the two must agree —
 * and a typo would mean sweeping forever because nothing ever recorded one.
 */
const SWEEP_SOURCE = 'target-tcg';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Post everything a set of sweeps found, then mark it announced. */
async function publish(
  db: Sql,
  userId: number,
  env: Env,
  results: SweepResult[],
  now: string,
): Promise<void> {
  for (const result of results) {
    if (!result.ok || result.fresh.length === 0) continue;
    const source = await store.getSource(db, userId, result.sourceId);
    await announce(
      env.DISCORD_WEBHOOK_URL,
      result.label,
      source?.retailer ?? '',
      result.fresh,
      now,
    );
    await store.markAnnounced(
      db,
      userId,
      result.sourceId,
      result.fresh.map((f) => f.externalId),
    );
  }
  const opsUrl = env.DISCORD_OPS_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  await reportOps(opsUrl, results, now);
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

function redirect(to: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: to, ...headers } });
}

/** Build the API. Everything it needs arrives as an argument. */
export function createHandler(db: Sql, env: Env): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = new Date().toISOString();

    // `/health` only. `/` belongs to the page now, and a health check that also
    // answered `/` would shadow it — the dashboard would never be reachable.
    if (request.method === 'GET' && path === '/health') {
      // Public, so it says nothing about anybody. It used to list source
      // labels, which was a small leak with one user and is somebody else's
      // data now. What a health check has to answer is whether the database
      // answers — nothing more.
      try {
        await store.countUsers(db);
        return json({ ok: true });
      } catch (err) {
        return json({ ok: false, error: (err as Error).message }, 503);
      }
    }

    // ── Installing ───────────────────────────────────────────────────────────
    //
    // Public, and they have to be. A manifest is fetched without credentials
    // unless it is marked otherwise, and a service worker registers before
    // anything has signed in — put these behind the session and the browser
    // silently never offers to install the app. None of the three carries any
    // data; they are a name, three icons and a fetch handler.
    if (request.method === 'GET' && path === '/manifest.webmanifest') {
      return new Response(JSON.stringify(MANIFEST, null, 2), {
        headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
      });
    }
    if (request.method === 'GET' && path === '/sw.js') {
      return new Response(SERVICE_WORKER, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          // Never cache the worker itself, or a fix to it can take a day to land.
          'Cache-Control': 'no-cache',
        },
      });
    }
    // iOS falls back to probing these fixed paths when a page carries no
    // apple-touch-icon link. Serving them means no page on this app can ever
    // hand the home screen a blank tile.
    if (request.method === 'GET' &&
        (path === '/apple-touch-icon.png' || path === '/apple-touch-icon-precomposed.png')) {
      const icon = iconResponse('192');
      if (icon) return icon;
    }

    /**
     * What Phantom can do, per retailer — read by DNA Card Vault's membership
     * page so its claims cannot drift from this code.
     *
     * Public and unauthenticated on purpose: it describes the product, not any
     * person, and a page that must sign in to learn the feature list is a page
     * that will hard-code the feature list instead. CORS is open for the same
     * reason — the vault may render it on the server or in the browser.
     *
     * Cached for an hour at the edge. A capability changes when code ships, not
     * by the minute, and a marketing page should not be a load on this app.
     */
    if (path === '/api/capabilities' && (request.method === 'GET' || request.method === 'OPTIONS')) {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      return json(capabilityTable(), 200, headers);
    }

    if (request.method === 'GET' && path.startsWith('/icon-') && path.endsWith('.png')) {
      const icon = iconResponse(path.slice('/icon-'.length, -'.png'.length));
      if (icon) return icon;
    }

    // ── The browser's way in ─────────────────────────────────────────────────
    const secure = url.protocol === 'https:';

    if (path === '/login') {
      if (request.method === 'GET') return html(loginPage());
      const form = await request.formData().catch(() => null);
      const handle = String(form?.get('handle') ?? '').trim();
      const given = String(form?.get('password') ?? '');

      const secret = sessionSecret(env);
      if (!secret) {
        return html(loginPage('No password is set on this deployment.'), 500);
      }

      const userId = await signIn(env, handle, given, (name) => store.userForLogin(db, name));
      if (!userId) {
        // Deliberately vague and deliberately slow-ish: no hint about length,
        // and no distinction between a name that exists and one that does not.
        await new Promise((r) => setTimeout(r, 400));
        return html(loginPage('That name and password do not go together.', handle), 401);
      }
      return redirect('/', {
        'Set-Cookie': sessionCookie(await mintSession(secret, userId), secure),
      });
    }

    if (path === '/logout') {
      return redirect('/login', { 'Set-Cookie': clearCookie(secure) });
    }

    /**
     * The vault's door. DNA Card Vault redirects a Phantom-tier member here
     * with a 60-second launch token in the URL FRAGMENT — which never reaches
     * this server — so GET serves a tiny page whose script lifts the token out
     * of location.hash and posts it straight back. The POST verifies the HMAC,
     * finds or creates the account mapped to that vault user, and mints the
     * same session cookie the login form would. One account, the vault is boss.
     */
    if (request.method === 'GET' && path === '/sso') {
      return html(ssoPage());
    }
    if (request.method === 'POST' && path === '/api/sso') {
      const secret = sessionSecret(env);
      if (!secret) return json({ error: 'no session secret is set on this deployment' }, 500);
      const b = (await request.json().catch(() => null)) as { token?: string } | null;
      const claims = await verifyLaunchToken(env, b?.token ?? null);
      if (!claims) {
        return json({ error: 'that sign-in link has expired — open Phantom from the vault again' }, 401);
      }
      const userId = await store.ensureVaultUser(db, claims.userId, claims.email);
      await store.markEntitlementChecked(db, userId);
      return json({ ok: true }, 200, {
        'Set-Cookie': sessionCookie(await mintSession(secret, userId), secure),
      });
    }

    // Everything below is either Phantom with its token or a signed-in
    // browser. Fail closed: an unset password or token shuts that door rather
    // than opening it.
    const caller = await identify(request, env, (hash) => store.userByTokenHash(db, hash));
    const userId = caller.userId;

    if (caller.kind === 'none') {
      // A browser gets a login page; anything else gets an honest 401.
      const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
      if (wantsHtml) return redirect('/login');
      return json({ error: 'unauthorised' }, 401);
    }

    /**
     * Vault-linked accounts re-prove the tier daily. Checked only on the
     * dashboard read — the request every open page makes — so the cost is one
     * signed call a day per member, not one per click. Three-valued on
     * purpose: the vault EXPLICITLY saying no ends the session (the tier
     * lapsed); the vault being unreachable changes nothing, because a member
     * must never be locked out mid-drop by somebody else's outage.
     */
    if (request.method === 'GET' && path === '/api/dashboard') {
      const link = await store.vaultLinkFor(db, userId);
      const staleMs = 24 * 3600 * 1000;
      if (link && !link.enabled) {
        // Lapsed earlier and never renewed. The way back in is the vault's
        // Open Phantom button, which only works while the tier is held.
        return json(
          { error: 'your Phantom membership has lapsed — renew it in DNA Card Vault' },
          401,
          { 'Set-Cookie': clearCookie(secure) },
        );
      }
      if (link && (!link.checkedAt || Date.now() - Date.parse(link.checkedAt) > staleMs)) {
        const ent = await checkEntitlement(env, link.vaultUserId);
        if (ent.answer === 'yes') await store.markEntitlementChecked(db, userId);
        if (ent.answer === 'no') {
          await store.disableVaultUser(db, userId);
          return json(
            { error: 'your Phantom membership has lapsed — renew it in DNA Card Vault' },
            401,
            { 'Set-Cookie': clearCookie(secure) },
          );
        }
      }
    }

    // ── The page ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && (path === '/' || path === '/dashboard' || path === '/add')) {
      // `/add` is the share target and the app shortcut. Same document — the
      // page notices the path and the shared link and opens the quick-add box.
      return html(dashboardPage());
    }

    /** Everything the page renders, in one request. */
    if (request.method === 'GET' && path === '/api/dashboard') {
      const [missions, runs, changes, products, listings, settings, discoveries] =
        await Promise.all([
          store.listMissions(db, userId),
          store.recentRuns(db, userId, 40),
          store.recentObservations(db, userId, 40),
          store.listProducts(db, userId),
          store.listListings(db, userId),
          store.getSettings(db, userId),
          store.discoveriesToReview(db, userId),
        ]);
      const sweep = await store.sweepState(db, userId, SWEEP_SOURCE, settings.sweepEveryHours);
      // Whose dashboard this is. Sent on every load rather than stored in the
      // page, because "which account am I looking at" is exactly the question
      // you need answered correctly when the answer is surprising.
      const you = await store.userHandle(db, userId);
      // The money picture: what is committed right now, and any grant still
      // open. An open grant on the dashboard is either a buy in progress or a
      // Phantom that died mid-checkout — both worth seeing at a glance.
      const authorisations = await store.openAuthorisations(db, userId);
      const committed = await store.committedLast24h(db, userId);
      // Waiting rooms seen in the last half hour. A queue is the loudest
      // early signal a retailer gives — it belongs on the front of the app,
      // not buried in the activity log.
      const queues = await store.queueSightings(db, userId, 30);
      // Warehouse load-ins in the last 12 hours — the pre-drop tell.
      const stockLoads = await store.stockLoadSightings(db, userId, 720);
      // Confirmed purchases waiting for their review-then-send to the vault.
      const acquisitions = await store.listAcquisitions(db, userId);
      // Links people sent in. For the owner this is an inbox to work; for a
      // member it is the receipt for what they sent, which is the half that
      // stops a submission feeling like a hole in the ground.
      const requests = await store.listProductRequests(db, userId);
      const canCurate = await store.canWriteCatalogue(db, userId);
      // Is the machine still there? Silence is the failure this cannot afford,
      // and it is the one that looks like nothing at all.
      const agentSeenAt = await store.agentLastSeen(db, userId);
      // What each shop can actually do, from the same table the vault's perks
      // page reads. The front door tells a new member which retailers are
      // watched — and a hard-coded list of three would go on promising a shop
      // the day it goes behind a wall.
      const shopStatus = capabilityTable().retailers.map((r) => ({
        name: r.name,
        watch: r.abilities.watch ?? 'none',
        blocked: r.blocked ?? null,
      }));
      return json({
        missions, runs, changes, products, listings, settings, discoveries, sweep, now, you,
        authorisations, committed, queues, stockLoads, acquisitions, requests, canCurate,
        capabilities: shopStatus, agentSeenAt,
      });
    }

    /** A single mission's whole run history. */
    if (request.method === 'GET' && path.startsWith('/api/missions/') && path.endsWith('/runs')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad mission id' }, 400);
      const mission = await store.getMission(db, userId, id);
      if (!mission) return json({ error: 'no such mission' }, 404);
      return json({ mission, runs: await store.missionRuns(db, userId, id, 200) });
    }

    // ── Managing what is watched ─────────────────────────────────────────────
    //
    // Everything below is a plain JSON verb the page calls. Deliberately not
    // REST-pure: one endpoint per thing a person actually does, so the failure
    // messages can say what went wrong in words rather than in status codes.

    const body = async <T>(): Promise<T | null> =>
      (await request.json().catch(() => null)) as T | null;

    if (request.method === 'POST' && path === '/api/products') {
      const b = await body<store.ProductInput>();
      if (!b) return json({ error: 'body must be JSON' }, 400);
      try {
        return json({ product: await store.upsertProduct(db, userId, b) });
      } catch (err) {
        // validateProduct speaks in sentences. Pass it through unchanged.
        return json({ error: (err as Error).message }, 400);
      }
    }

    if (request.method === 'DELETE' && path.startsWith('/api/products/')) {
      const key = decodeURIComponent(path.slice('/api/products/'.length));
      if (!key) return json({ error: 'no product key' }, 400);
      // 404 rather than a cheerful 200 when nothing matched. The store filters
      // by user_id, so "nothing matched" is also what another account's delete
      // looks like, and it should not be told it succeeded.
      if (!(await store.deleteProduct(db, userId, key))) return json({ error: 'no such product' }, 404);
      return json({ deleted: key });
    }

    /**
     * Add a listing, working out the retailer and its id from the URL.
     *
     * The person pastes a product URL; asking them to also type the retailer
     * and the SKU is asking them to repeat what the URL already says, and to
     * get it wrong occasionally.
     */
    if (request.method === 'POST' && path === '/api/listings') {
      const b = await body<{ productKey?: string; url?: string }>();
      if (!b?.productKey || !b?.url) return json({ error: 'need a product and a URL' }, 400);

      const parsed = identifyListing(b.url);
      if (!parsed) {
        return json(
          {
            error:
              'could not read a retailer and product id out of that URL. Expected a ' +
              'target.com/p/…/A-123, pokemoncenter.com/product/100-123/… or ' +
              'walmart.com/ip/…/123 link.',
          },
          400,
        );
      }
      const listing = await store.addListing(db, userId, {
        productKey: b.productKey,
        retailer: parsed.retailer,
        externalId: parsed.externalId,
        url: b.url.trim(),
      });
      return json({ listing });
    }

    /**
     * Quick add: one URL in, a watched mission out.
     *
     * The whole point of the installed app. On a phone you have a Target link
     * and thirty seconds, and the three-step path — create a product, add a
     * listing to it, then a mission to watch it — is three steps too many.
     *
     * Two rules it keeps rather than skipping:
     *   · a URL already tracked returns the existing mission rather than a
     *     duplicate. Two missions on one listing is two buyers.
     *   · the mission arrives **watching, never armed, with no ceiling**.
     *     Arming is a decision, and a decision does not belong in a shortcut.
     */
    if (request.method === 'POST' && path === '/api/quick-add') {
      const b = await body<{
        url?: string;
        name?: string;
        msrp?: number | null;
        releaseDate?: string | null;
        notes?: string;
        imageUrl?: string;
      }>();
      const raw = (b?.url ?? '').trim();
      if (!raw) return json({ error: 'need a URL' }, 400);

      const parsed = identifyListing(raw);
      if (!parsed) {
        return json(
          {
            error:
              'could not read a retailer and product id out of that URL. Expected a ' +
              'target.com/p/…/A-123, pokemoncenter.com/product/100-123/… or ' +
              'walmart.com/ip/…/123 link.',
          },
          400,
        );
      }

      const typedName = (b?.name ?? '').trim();
      const details = {
        msrp: b?.msrp ?? null,
        releaseDate: b?.releaseDate ?? null,
        notes: b?.notes ?? '',
        imageUrl: b?.imageUrl ?? '',
      };

      const existing = await store.findListing(db, userId, parsed.retailer, parsed.externalId);

      // ── A member sending in a link ─────────────────────────────────────────
      //
      // Same button, different outcome, said plainly. A member cannot write to
      // the catalogue, but they are the ones out there finding things, and the
      // worst answer to "here's a link" is a permissions error.
      //
      // If the listing already EXISTS they need no favour at all — the shelf is
      // shared, so they just get a mission on it, same as the owner would.
      // Only a link nobody has catalogued yet becomes a request.
      if (!(await store.canWriteCatalogue(db, userId))) {
        if (existing) {
          const mission =
            (await store.missionForListing(db, userId, existing.id)) ??
            (await store.upsertMission(db, userId, {
              listingId: existing.id,
              label: existing.productName,
            }));
          return json({ product: null, listing: existing, mission, alreadyTracked: true });
        }
        const req = await store.requestProduct(db, userId, parsed.url || raw, [typedName, (b?.notes ?? '').trim()].filter(Boolean).join(' — '));
        return json(
          {
            requested: true,
            request: req,
            message:
              req.status === 'declined'
                ? 'this link was sent in before and turned down'
                : 'sent to the catalogue — you will see it on your watchlist once it is added',
          },
          202,
        );
      }

      if (existing) {
        // Only touch the product when a person actually typed something. The
        // slug-derived name is a guess, and letting a guess overwrite a name
        // someone chose is how "Ascended Heroes Elite Trainer Box" becomes
        // "pokemon-tcg-mega-evolution-tin".
        let product = null;
        if (typedName || details.msrp !== null || details.releaseDate || details.notes) {
          product = await store.upsertProduct(db, userId, {
            key: existing.productKey,
            name: typedName || existing.productName,
            ...details,
          });
        }
        const mission =
          (await store.missionForListing(db, userId, existing.id)) ??
          (await store.upsertMission(db, userId, { listingId: existing.id, label: existing.productName }));
        return json({ product, listing: existing, mission, alreadyTracked: true });
      }

      // A name from the URL slug is a guess, and it is labelled as one on the
      // page rather than presented as the product's real name.
      const product = await store.upsertProduct(db, userId, {
        name: typedName || parsed.name || `${parsed.retailer} ${parsed.externalId}`,
        // Only a slug-derived name is a guess. Once Phantom reads the page
        // it replaces it; a name typed here is final.
        nameIsGuess: !typedName,
        ...details,
      });
      const listing = await store.addListing(db, userId, {
        productKey: product.key,
        retailer: parsed.retailer,
        externalId: parsed.externalId,
        url: parsed.url || raw,
      });
      const mission = await store.upsertMission(db, userId, {
        listingId: listing.id,
        label: product.name,
      });
      return json({ product, listing, mission, alreadyTracked: false }, 201);
    }

    // ── The request queue ────────────────────────────────────────────────────
    //
    // A member's route to the catalogue. GET is safe for everyone — a member
    // sees their own links and what became of them, the owner sees the inbox.
    // Deciding is the owner's, enforced in the store, not here.
    if (request.method === 'GET' && path === '/api/requests') {
      const status = url.searchParams.get('status') as
        | 'pending'
        | 'approved'
        | 'declined'
        | null;
      const requests = await store.listProductRequests(db, userId, status ?? undefined);
      return json({ requests });
    }

    if (request.method === 'POST' && path === '/api/requests') {
      const b = await body<{ url?: string; note?: string }>();
      const raw = (b?.url ?? '').trim();
      if (!raw) return json({ error: 'need a URL' }, 400);
      const req = await store.requestProduct(db, userId, raw, b?.note ?? '');
      return json({ request: req }, 201);
    }

    // Approving is quick-add with a name on it: the same parse, the same
    // upsert, and then the request is stamped with the listing it became so
    // the person who sent it can see it land on their watchlist.
    if (request.method === 'POST' && path.startsWith('/api/requests/') && path.endsWith('/approve')) {
      const id = Number(path.slice('/api/requests/'.length, -'/approve'.length));
      if (!Number.isInteger(id)) return json({ error: 'bad request id' }, 400);
      // Checked here as well as in the store. Approving writes a product and a
      // listing before it stamps the request, and those would throw first —
      // giving a member a 500 for something that is simply not theirs to do.
      if (!(await store.canWriteCatalogue(db, userId))) {
        return json({ error: 'this account may not decide requests for the catalogue' }, 403);
      }
      const req = await store.getProductRequest(db, userId, id);
      if (!req) return json({ error: 'no such request' }, 404);

      const b = await body<{ name?: string; msrp?: number | null; note?: string }>();
      const parsed = identifyListing(req.url);
      if (!parsed) return json({ error: 'that URL is not a product page we can read' }, 400);

      const typedName = (b?.name ?? '').trim();
      let listing = await store.findListing(db, userId, parsed.retailer, parsed.externalId);
      if (!listing) {
        const product = await store.upsertProduct(db, userId, {
          name: typedName || parsed.name || `${parsed.retailer} ${parsed.externalId}`,
          nameIsGuess: !typedName,
          msrp: b?.msrp ?? null,
        });
        listing = await store.addListing(db, userId, {
          productKey: product.key,
          retailer: parsed.retailer,
          externalId: parsed.externalId,
          url: parsed.url || req.url,
        });
      }

      // The mission belongs to the person who ASKED, not to whoever approved
      // it. Otherwise the owner's watchlist fills up with other people's finds
      // and the member who sent the link still cannot see it.
      await store.upsertMission(db, req.userId, {
        listingId: listing.id,
        label: listing.productName,
      });

      let decided;
      try {
        decided = await store.decideProductRequest(db, userId, id, 'approved', {
          listingId: listing.id,
          note: b?.note ?? '',
        });
      } catch (err) {
        return json({ error: (err as Error).message }, 403);
      }
      return json({ request: decided, listing });
    }

    if (request.method === 'POST' && path.startsWith('/api/requests/') && path.endsWith('/decline')) {
      const id = Number(path.slice('/api/requests/'.length, -'/decline'.length));
      if (!Number.isInteger(id)) return json({ error: 'bad request id' }, 400);
      const b = await body<{ note?: string }>();
      let decided;
      try {
        decided = await store.decideProductRequest(db, userId, id, 'declined', {
          note: b?.note ?? '',
        });
      } catch (err) {
        return json({ error: (err as Error).message }, 403);
      }
      if (!decided) return json({ error: 'no such request' }, 404);
      return json({ request: decided });
    }

    if (request.method === 'DELETE' && path.startsWith('/api/listings/')) {
      const id = Number(path.slice('/api/listings/'.length));
      if (!Number.isInteger(id)) return json({ error: 'bad listing id' }, 400);
      if (!(await store.deleteListing(db, userId, id))) return json({ error: 'no such listing' }, 404);
      return json({ deleted: id });
    }

    if (request.method === 'POST' && path === '/api/missions') {
      const b = await body<store.MissionInput>();
      if (!b) return json({ error: 'body must be JSON' }, 400);

      // The arm gate. A mission may not be armed until a daily spend cap
      // exists, because the cap is what bounds a night's worst case — per-
      // mission ceilings bound one purchase, and six ceilings at once is
      // exactly the morning the cap exists to prevent. Checked here rather
      // than in the store so the refusal can say what to do about it.
      if (b.armed === true) {
        const current = await store.getSettings(db, userId);
        if (current.spendCapDay === null) {
          return json(
            {
              error:
                'nothing can be armed until a daily spend cap is set — ' +
                'Settings → "Most to spend in 24 hours"',
            },
            400,
          );
        }
      }

      try {
        return json({ mission: await store.upsertMission(db, userId, b) });
      } catch (err) {
        // validateMission speaks in sentences, so pass it straight through.
        return json({ error: (err as Error).message }, 400);
      }
    }

    /**
     * Permission to spend. Phantom asks; this is the only yes there is.
     *
     * Deliberately allowed for both callers: Phantom asks for real, and a
     * signed-in browser may ask to see what the answer would be. The grant
     * itself is idempotent-hostile on purpose — one live grant per mission,
     * ever, until something resolves it.
     */
    if (request.method === 'POST' && path === '/api/authorise') {
      const b = await body<{ missionId?: number }>();
      const missionId = Number(b?.missionId);
      if (!Number.isInteger(missionId)) return json({ error: 'need missionId' }, 400);
      const result = await store.requestAuthorisation(db, userId, missionId);
      return json(result, result.granted ? 201 : 200);
    }

    /**
     * What became of a grant. 'spent' also disarms the mission — a mission is
     * a pre-authorisation for one purchase, and the purchase happened.
     *
     * A grant that is never resolved stays live and keeps counting against the
     * cap. That is the fail-closed answer to a Phantom dying mid-checkout:
     * nobody knows whether money moved, so the money stays committed until a
     * person looks at their orders page and releases it by hand.
     */
    if (request.method === 'POST' && path.startsWith('/api/authorisations/') && path.endsWith('/resolve')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad authorisation id' }, 400);
      const b = await body<{ result?: string; note?: string }>();
      const result = b?.result === 'spent' ? 'spent' : b?.result === 'released' ? 'released' : null;
      if (!result) return json({ error: "result must be 'spent' or 'released'" }, 400);
      const row = await store.resolveAuthorisation(db, userId, id, result, String(b?.note ?? ''));
      if (!row) return json({ error: 'no live authorisation with that id' }, 404);
      return json({ authorisation: row });
    }

    /**
     * "Test run" — check this mission on the next pass, whatever its schedule.
     *
     * Answers 202, not 200, and the wording matters: the Hub has no browser and
     * cannot make a check happen. It records the request; Phantom honours it
     * next pass, jumping the mission queue but never the per-retailer floor.
     */
    if (request.method === 'POST' && path.endsWith('/check-now') && path.startsWith('/api/missions/')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad mission id' }, 400);
      if (!(await store.requestCheckNow(db, userId, id))) return json({ error: 'no such mission' }, 404);
      return json({ queued: id, note: 'Phantom will check this on its next pass' }, 202);
    }

    if (request.method === 'DELETE' && path.startsWith('/api/missions/')) {
      const id = Number(path.slice('/api/missions/'.length));
      if (!Number.isInteger(id)) return json({ error: 'bad mission id' }, 400);
      if (!(await store.deleteMission(db, userId, id))) return json({ error: 'no such mission' }, 404);
      return json({ deleted: id });
    }

    /**
     * The vault leg of a purchase. Confirmed buys queue as acquisitions; a
     * person confirms the product match against the vault's own catalog and
     * sends — review-then-send, because a wrong auto-match writes wrong data
     * into a real portfolio. The delivery is idempotent (the vault dedupes on
     * external_key), so a timeout retried later can never double-add.
     */
    if (request.method === 'GET' && path === '/api/acquisitions') {
      return json({
        acquisitions: await store.listAcquisitions(db, userId),
        vaultLinked: vaultConfigured(env),
      });
    }

    if (request.method === 'GET' && path === '/api/vault/search') {
      const q = url.searchParams.get('q') ?? '';
      if (!q.trim()) return json({ products: [] });
      const found = await searchVaultSealed(env, q);
      if ('error' in found) return json({ error: found.error }, 502);
      return json(found);
    }

    if (request.method === 'POST' && path.startsWith('/api/acquisitions/') && path.endsWith('/send')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad acquisition id' }, 400);
      const b = await body<{ tcgId?: string; name?: string; setName?: string; imageUrl?: string }>();
      const link = await store.vaultLinkFor(db, userId);
      const vaultUserId = link?.vaultUserId ?? env.VAULT_OWNER_USER_ID ?? '';
      if (!vaultUserId) {
        return json({ error: 'this account is not linked to a vault account — set VAULT_OWNER_USER_ID or sign in through the vault' }, 400);
      }
      const rows = await store.listAcquisitions(db, userId);
      const acq = rows.find((a) => a.id === id);
      if (!acq) return json({ error: 'no such acquisition' }, 404);
      if (acq.status !== 'queued') return json({ error: `already ${acq.status}` }, 409);

      const delivered = await deliverAcquisition(env, {
        externalKey: acq.externalKey,
        vaultUserId,
        name: String(b?.name ?? '').trim() || acq.name,
        quantity: acq.quantity,
        priceCents: acq.unitPriceCents,
        acquiredOn: acq.orderedOn || now.slice(0, 10),
        retailer: acq.retailer,
        tcgId: String(b?.tcgId ?? '').trim() || null,
        setName: b?.setName ?? null,
        imageUrl: b?.imageUrl ?? acq.imageUrl ?? null,
      });
      if (!delivered.ok) return json({ error: delivered.error }, 502);
      const row = await store.markAcquisitionSent(db, userId, id, String(b?.tcgId ?? ''), delivered.itemIds);
      return json({ acquisition: row });
    }

    if (request.method === 'POST' && path.startsWith('/api/acquisitions/') && path.endsWith('/dismiss')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad acquisition id' }, 400);
      if (!(await store.dismissAcquisition(db, userId, id))) return json({ error: 'no queued acquisition with that id' }, 404);
      return json({ dismissed: id });
    }

    if (request.method === 'GET' && path === '/api/settings') {
      return json({ settings: await store.getSettings(db, userId) });
    }

    if (request.method === 'POST' && path === '/api/settings') {
      const b = await body<Partial<store.Settings>>();
      if (!b) return json({ error: 'body must be JSON' }, 400);
      try {
        return json({ settings: await store.setSettings(db, userId, b) });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // ── Reviewing what a sweep found ─────────────────────────────────────────
    //
    // A sweep proposes, a person decides. Keeping creates something watchable
    // and nothing more: no mission, nothing armed. A machine's guess and a
    // decision about money are kept a deliberate click apart.

    /** Ask for a catalogue sweep on Phantom's next pass. */
    if (request.method === 'POST' && path === '/api/sweep-now') {
      const asked = await store.requestSweep(db, userId, SWEEP_SOURCE);
      if (!asked) {
        return json(
          { error: `no enabled source "${SWEEP_SOURCE}" — run db:seed on the Hub` },
          404,
        );
      }
      return json({ queued: true, sourceId: SWEEP_SOURCE });
    }

    if (request.method === 'GET' && path === '/api/discoveries') {
      return json({ discoveries: await store.discoveriesToReview(db, userId) });
    }

    if (request.method === 'POST' && path.startsWith('/api/discoveries/') && path.endsWith('/keep')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad discovery id' }, 400);
      try {
        return json({ kept: await store.keepDiscovery(db, userId, id) });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    if (request.method === 'POST' && path.startsWith('/api/discoveries/') && path.endsWith('/forget')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad discovery id' }, 400);
      const done = await store.forgetDiscovery(db, userId, id);
      if (!done) return json({ error: 'no such discovery, or it was already decided' }, 404);
      return json({ forgotten: id });
    }

    // ── The activity log ─────────────────────────────────────────────────────

    /**
     * Phantom posting what it did.
     *
     * Lines arrive already scrubbed on the machine that produced them. This
     * endpoint does not re-scrub on the way in, deliberately: doing it here
     * would put the guarantee at the wrong boundary and make the local copy on
     * that machine the unprotected one. The second pass happens on export,
     * where the data actually leaves.
     *
     * Pruning runs on every ingest rather than on a schedule. There is no cron
     * — see the note at the top of this file — so the only reliable moment to
     * enforce retention is when somebody is writing.
     */
    if (request.method === 'POST' && path === '/api/activity') {
      const b = await body<{ lines?: store.ActivityIn[] }>();
      if (!b || !Array.isArray(b.lines)) return json({ error: 'need lines[]' }, 400);

      // A cap, so a runaway Phantom cannot post a million rows in one request.
      const lines = b.lines.slice(0, 500);
      const result = await store.recordActivity(db, userId, lines);
      const pruned = await store.pruneActivity(db, userId);
      return json({ ...result, pruned });
    }

    /**
     * The whole diagnostic picture, in one file.
     *
     * Built to be handed to somebody else — which is the entire reason for the
     * second scrub. Everything in here has supposedly been cleaned already;
     * `warnings` is what says so out loud rather than assuming it.
     */
    if (request.method === 'GET' && path === '/api/activity/export') {
      const hours = Math.min(Math.max(Number(url.searchParams.get('hours') ?? 24) || 24, 1), 168);
      const [lines, summary, missions, runs, changes] = await Promise.all([
        store.recentActivity(db, userId, { sinceHours: hours, limit: 20_000 }),
        store.activitySummary(db, userId, hours),
        store.listMissions(db, userId),
        store.recentRuns(db, userId, 200),
        store.recentObservations(db, userId, 200),
      ]);

      // The two values this Hub knows are secret. Neither should ever appear in
      // a log line; both are removed by value in case one ever does.
      const secrets = [env.INGEST_TOKEN, env.APP_PASSWORD].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      const clean = (text: string): string => scrub(text ?? '', secrets);

      const byLevel: Record<string, number> = {};
      const byKind: Record<string, number> = {};
      const scrubbed = lines.map((l) => {
        byLevel[l.level] = (byLevel[l.level] ?? 0) + 1;
        byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
        return { ...l, message: clean(l.message), detail: clean(l.detail) };
      });

      const bundle = {
        generatedAt: now,
        windowHours: hours,
        note:
          'Scrubbed twice: once on the machine that produced each line, once here on the ' +
          'way out. Contains no credentials, no addresses and no account identifiers. ' +
          'It does say what you are watching and what it costs.',
        counts: { lines: scrubbed.length, byLevel, byKind },
        summary,
        missions: missions.map((m) => ({
          id: m.id,
          product: clean(m.productName ?? ''),
          retailer: m.retailer,
          enabled: m.enabled,
          armed: m.armed,
          ceiling: m.ceiling,
          quantity: m.quantity,
          checkEverySeconds: m.checkEverySeconds,
          state: m.state,
          price: m.price,
          lastCheckedAt: m.lastCheckedAt,
        })),
        runs: runs.map((r) => ({ ...r, reason: clean(r.reason ?? '') })),
        changes: changes.map((c) => ({ ...c, note: clean(c.note ?? '') })),
        lines: scrubbed,
      };

      // Ask the question from the reader's side rather than asserting the
      // answer. If anything still looks like it should not be here, the file
      // says so at the top instead of being quietly wrong.
      const warnings = looksSensitive(JSON.stringify(bundle));

      return new Response(JSON.stringify({ ...bundle, warnings }, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="phantom-activity-${now.slice(0, 10)}.json"`,
        },
      });
    }

    /**
     * What Phantom polls: enabled missions, with their mandate attached —
     * and the account settings, because the mandate is not complete without
     * them. A ceiling means item plus tax, and tax needs a rate.
     */
    /*
     * The fast lane.
     *
     * Phantom polls this every few seconds. It is deliberately the cheapest
     * endpoint in the app — one indexed column, no joins, a handful of
     * integers — because "check now" is only ever as fast as the next poll,
     * and the Hub cannot ring a machine behind somebody's router.
     *
     * It does not clear the flag. Clearing belongs to the observation landing,
     * so a poll that Phantom never acts on cannot swallow the request.
     */
    if (request.method === 'GET' && path === '/api/check-now') {
      return json({ listingIds: await store.urgentListings(db, userId) });
    }

    if (request.method === 'GET' && path === '/api/missions/active') {
      const [missions, settings] = await Promise.all([
        store.activeMissions(db, userId),
        store.getSettings(db, userId),
      ]);
      // Whether to sweep is answered here rather than on Phantom, because
      // Phantom restarts and the Hub remembers. See store.isSweepDue.
      const state = await store.sweepState(db, userId, SWEEP_SOURCE, settings.sweepEveryHours);
      const sweep = {
        due: await store.sweepDue(db, userId, SWEEP_SOURCE, settings.sweepEveryHours),
        // Asked for by hand, as opposed to falling due. Phantom jumps the
        // queue for one of these: somebody is watching the button.
        manual: state.queued,
        sourceId: SWEEP_SOURCE,
      };
      return json({ missions, settings, sweep });
    }

    /** Phantom reporting a run it has already finished. */
    if (request.method === 'POST' && path === '/api/runs') {
      const b = await body<{
        missionId?: number;
        outcome?: store.RunOutcome;
        reason?: string;
        state?: string;
        price?: number | null;
        sellerKind?: string;
        sellerName?: string;
        quantity?: number | null;
        total?: number | null;
      }>();
      if (!b?.missionId || !b?.outcome || b.outcome === 'running') {
        return json({ error: 'need missionId and a settled outcome' }, 400);
      }
      const id = await store.recordRun(db, userId, b.missionId, {
        outcome: b.outcome,
        reason: b.reason,
        state: b.state,
        price: b.price,
        sellerKind: b.sellerKind,
        sellerName: b.sellerName,
        quantity: b.quantity,
        total: b.total,
      });
      return json({ run: id });
    }

    /**
     * Phantom reporting what it saw.
     *
     * Accepts a batch, and answers per-item rather than all-or-nothing: one
     * unreadable listing must not throw away the other eleven readings in the
     * same run.
     */
    if (request.method === 'POST' && path === '/observations') {
      let body: { observations?: store.ObservationIn[] };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }
      if (!Array.isArray(body.observations)) {
        return json({ error: 'need observations[]' }, 400);
      }

      const results: { listingId: number; changed: boolean; error?: string }[] = [];
      const changes: { obs: store.ObservationIn; was: string | null }[] = [];

      for (const obs of body.observations) {
        if (!obs?.listingId || !obs?.state) {
          results.push({
            listingId: obs?.listingId ?? 0,
            changed: false,
            error: 'need listingId and state',
          });
          continue;
        }
        try {
          const outcome = await store.recordObservation(db, userId, obs);
          results.push({ listingId: obs.listingId, changed: outcome.changed });
          if (outcome.changed) changes.push({ obs, was: outcome.previousState });
        } catch (err) {
          results.push({ listingId: obs.listingId, changed: false, error: (err as Error).message });
        }
      }

      // Discord is optional and always has been — notify.ts posts nothing when
      // no webhook is configured. The page is the primary surface now.
      const cameIntoStock = changes.filter((c) => c.obs.state === 'in' && c.was !== 'in');
      if (cameIntoStock.length > 0 && env.DISCORD_WEBHOOK_URL) {
        await announce(
          env.DISCORD_WEBHOOK_URL,
          'In stock',
          '',
          cameIntoStock.map((c) => ({
            externalId: String(c.obs.listingId),
            name: c.obs.note || `listing ${c.obs.listingId}`,
            url: '',
            price: c.obs.price ?? null,
          })),
          now,
        );
      }

      return json({
        recorded: results.length,
        changed: results.filter((r) => r.changed).length,
        failed: results.filter((r) => r.error).length,
        results,
      });
    }

    /** Kick a sweep by hand. `?source=<id>` to do just one. */
    if (request.method === 'POST' && path === '/sweep') {
      const only = url.searchParams.get('source');
      let results: SweepResult[];
      if (only) {
        const source = await store.getSource(db, userId, only);
        if (!source) return json({ error: `no source "${only}"` }, 404);
        results = [await sweepSource(db, userId, source)];
      } else {
        results = await sweepAll(db, userId);
      }
      await publish(db, userId, env, results, now);
      return json({
        swept: results.map((r) => ({
          source: r.sourceId,
          ok: r.ok,
          seen: r.seen,
          new: r.fresh.length,
          error: r.error,
        })),
      });
    }

    /**
     * Phantom ingest — the *discovery* path, not the watching one.
     *
     * Phantom posts what it saw on a category page the Hub cannot reach.
     * Identical downstream handling to a sweep: diff, seed-or-announce, mint
     * identity. This is how a SKU nobody has seen before becomes a product you
     * can then point a mission at.
     *
     * { "sourceId": "target-tcg", "items": [{ externalId, name, url, price }] }
     */
    if (request.method === 'POST' && path === '/ingest') {
      let body: {
        sourceId?: string;
        items?: Discovered[];
        final?: boolean;
        /** Queries still to run in this sweep. Drives the progress the page shows. */
        remaining?: number;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }
      const sourceId = (body.sourceId ?? '').trim();
      if (!sourceId || !Array.isArray(body.items)) {
        return json({ error: 'need sourceId and items[]' }, 400);
      }
      const source = await store.getSource(db, userId, sourceId);
      if (!source) return json({ error: `no source "${sourceId}"` }, 404);

      const config = source.config;
      const clean = dedupe(
        applyFilters(
          body.items.filter((i) => i && typeof i.externalId === 'string' && i.externalId),
          config.filters,
        ),
      );

      const known = await store.knownIds(db, userId, sourceId);
      const fresh = clean.filter((i) => !known.has(i.externalId));
      const isFirstSweep = !source.seeded;

      // Record everything seen, not only what is new.
      //
      // This used to pass `fresh`, which meant a product already in the ledger
      // was never written again — so its price, its stock state and its street
      // date were frozen at the first sighting, however long ago that was. The
      // upsert's whole DO UPDATE branch was unreachable in practice, and the
      // review card was describing last week.
      //
      // New and seen-again are still different things; that difference belongs
      // to *announcing*, below, not to recording.
      await store.recordDiscoveries(db, userId, sourceId, clean, !isFirstSweep);

      // A first sweep is a baseline: everything is "new" against an empty
      // memory, so announcing it would be thirty alerts saying nothing.
      const toAnnounce = isFirstSweep ? [] : fresh;

      for (const item of toAnnounce) {
        await store.attachIdentity(db, userId, sourceId, source.retailer, item);
      }
      // A Phantom-side sweep arrives as many posts, one per query. Only the
      // last one finishes it — see the note on finishSweep. Absent means true,
      // so a caller that posts once (the CLI, a curl by hand) still completes.
      const complete = body.final !== false;
      const left = Number(body.remaining);
      const status = complete
        ? isFirstSweep
          ? `seeded ${fresh.length} via Phantom`
          : `Phantom: ${fresh.length} new`
        : `sweeping — ${Number.isFinite(left) && left > 0 ? left : '?'} to go`;
      await store.finishSweep(db, userId, sourceId, status, clean.length, true, 0, complete);

      if (toAnnounce.length > 0) {
        await announce(env.DISCORD_WEBHOOK_URL, source.label, source.retailer, toAnnounce, now);
        await store.markAnnounced(
          db,
          userId,
          sourceId,
          toAnnounce.map((f) => f.externalId),
        );
      }

      return json({
        received: clean.length,
        new: fresh.length,
        announced: toAnnounce.length,
        seeded: isFirstSweep,
        // What was new, by name. The caller cannot work this out for itself —
        // "new" is a question about everything ever seen, and Phantom is a
        // process that restarts. Empty on a first sweep, which is the point of
        // seeding silently rather than announcing a whole catalogue.
        names: toAnnounce.map((i) => i.name),
      });
    }


    /**
     * Reachability check. The single most useful thing to run after deploying:
     * it answers, from Cloudflare's own egress, which sources this Worker can
     * actually fetch — and therefore which ones have to move to Phantom.
     */
    if ((request.method === 'POST' || request.method === 'GET') && path === '/probe') {
      const sources = await store.listAllSources(db, userId);
      const checks = [];
      for (const source of sources) {
        if (source.via === 'watcher' || !source.url) {
          checks.push({
            id: source.id,
            retailer: source.retailer,
            via: source.via,
            enabled: source.enabled,
            verdict: 'Phantom — never fetched from here',
          });
          continue;
        }
        const config = source.config;
        const result = await probeUrl(source.url, config.headers ?? {});
        checks.push({
          id: source.id,
          retailer: source.retailer,
          via: source.via,
          enabled: source.enabled,
          status: result.status,
          ms: result.ms,
          verdict: result.ok
            ? `reachable — ${result.note}`
            : result.blocked
              ? `BLOCKED (${result.status}) — move this source to via='watcher'`
              : `failed (${result.status}) — ${result.note}`,
        });
      }
      const blocked = checks.filter((c) => String(c.verdict).startsWith('BLOCKED')).length;
      return json({
        summary:
          blocked === 0
            ? 'every hub source is reachable from here'
            : `${blocked} source(s) blocked — those belong to Phantom`,
        checks,
      });
    }

    /**
     * What Phantom should be looking at.
     *
     * Two lists, and the distinction matters. `products` is the real answer —
     * every known product with a retailer id and a URL, which is what gets
     * polled for stock. `sources` is where to go hunting for products that
     * aren't known yet.
     *
     * Phantom holds no list of its own. Adding something to watch is a row
     * here, never a redeploy of the thing on the desk.
     */
    if (request.method === 'GET' && path === '/watchlist') {
      const [products, sources] = await Promise.all([
        store.watchlist(db, userId),
        store.listSources(db, userId, 'watcher'),
      ]);
      return json({
        products,
        sources: sources.map((s) => ({
          id: s.id,
          label: s.label,
          retailer: s.retailer,
          url: s.url,
          config: s.config,
        })),
      });
    }

    return json({ error: 'not found' }, 404);
  };
}
