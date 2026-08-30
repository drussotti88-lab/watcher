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
 * useless for this. But the Hub never needed a scheduler: the Watcher on the
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
import { identify, mintSession, safeEqual, sessionCookie, clearCookie } from './auth.ts';
import { scrub, looksSensitive } from './scrub.ts';
import { loginPage, dashboardPage } from './page.ts';
import { identifyListing } from './parsers/identify.ts';
import { MANIFEST, SERVICE_WORKER, iconResponse } from './pwa.ts';

/**
 * The source a Watcher-side sweep reports into.
 *
 * One name, in one place. The Watcher posts here and the Hub reads its
 * last_swept_at to decide when the next one is due, so the two must agree —
 * and a typo would mean sweeping forever because nothing ever recorded one.
 */
const SWEEP_SOURCE = 'target-tcg';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
    if (request.method === 'GET' && path.startsWith('/icon-') && path.endsWith('.png')) {
      const icon = iconResponse(path.slice('/icon-'.length, -'.png'.length));
      if (icon) return icon;
    }

    // ── The browser's way in ─────────────────────────────────────────────────
    const secure = url.protocol === 'https:';

    if (path === '/login') {
      if (request.method === 'GET') return html(loginPage());
      const form = await request.formData().catch(() => null);
      const given = String(form?.get('password') ?? '');
      if (!env.APP_PASSWORD) {
        return html(loginPage('No password is set on this deployment.'), 500);
      }
      if (!safeEqual(given, env.APP_PASSWORD)) {
        // Deliberately vague and deliberately slow-ish: no hint about length,
        // no distinction between empty and wrong.
        await new Promise((r) => setTimeout(r, 400));
        return html(loginPage('That is not the password.'), 401);
      }
      return redirect('/', {
        'Set-Cookie': sessionCookie(await mintSession(env.APP_PASSWORD), secure),
      });
    }

    if (path === '/logout') {
      return redirect('/login', { 'Set-Cookie': clearCookie(secure) });
    }

    // Everything below is either the Watcher with its token or a signed-in
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
      return json({
        missions, runs, changes, products, listings, settings, discoveries, sweep, now,
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
      await store.deleteProduct(db, userId, key);
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
        // Only a slug-derived name is a guess. Once the Watcher reads the page
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

    if (request.method === 'DELETE' && path.startsWith('/api/listings/')) {
      const id = Number(path.slice('/api/listings/'.length));
      if (!Number.isInteger(id)) return json({ error: 'bad listing id' }, 400);
      await store.deleteListing(db, userId, id);
      return json({ deleted: id });
    }

    if (request.method === 'POST' && path === '/api/missions') {
      const b = await body<store.MissionInput>();
      if (!b) return json({ error: 'body must be JSON' }, 400);
      try {
        return json({ mission: await store.upsertMission(db, userId, b) });
      } catch (err) {
        // validateMission speaks in sentences, so pass it straight through.
        return json({ error: (err as Error).message }, 400);
      }
    }

    /**
     * "Test run" — check this mission on the next pass, whatever its schedule.
     *
     * Answers 202, not 200, and the wording matters: the Hub has no browser and
     * cannot make a check happen. It records the request; the Watcher honours it
     * next pass, jumping the mission queue but never the per-retailer floor.
     */
    if (request.method === 'POST' && path.endsWith('/check-now') && path.startsWith('/api/missions/')) {
      const id = Number(path.split('/')[3]);
      if (!Number.isInteger(id)) return json({ error: 'bad mission id' }, 400);
      if (!(await store.requestCheckNow(db, userId, id))) return json({ error: 'no such mission' }, 404);
      return json({ queued: id, note: 'the Watcher will check this on its next pass' }, 202);
    }

    if (request.method === 'DELETE' && path.startsWith('/api/missions/')) {
      const id = Number(path.slice('/api/missions/'.length));
      if (!Number.isInteger(id)) return json({ error: 'bad mission id' }, 400);
      await store.deleteMission(db, userId, id);
      return json({ deleted: id });
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

    /** Ask for a catalogue sweep on the Watcher's next pass. */
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
     * The Watcher posting what it did.
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

      // A cap, so a runaway Watcher cannot post a million rows in one request.
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
          'Content-Disposition': `attachment; filename="watcher-activity-${now.slice(0, 10)}.json"`,
        },
      });
    }

    /**
     * What the Watcher polls: enabled missions, with their mandate attached —
     * and the account settings, because the mandate is not complete without
     * them. A ceiling means item plus tax, and tax needs a rate.
     */
    if (request.method === 'GET' && path === '/api/missions/active') {
      const [missions, settings] = await Promise.all([
        store.activeMissions(db, userId),
        store.getSettings(db, userId),
      ]);
      // Whether to sweep is answered here rather than on the Watcher, because
      // the Watcher restarts and the Hub remembers. See store.isSweepDue.
      const sweep = {
        due: await store.sweepDue(db, userId, SWEEP_SOURCE, settings.sweepEveryHours),
        sourceId: SWEEP_SOURCE,
      };
      return json({ missions, settings, sweep });
    }

    /** The Watcher reporting a run it has already finished. */
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
     * The Watcher reporting what it saw.
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
     * Watcher ingest — the *discovery* path, not the watching one.
     *
     * The Watcher posts what it saw on a category page the Hub cannot reach.
     * Identical downstream handling to a sweep: diff, seed-or-announce, mint
     * identity. This is how a SKU nobody has seen before becomes a product you
     * can then point a mission at.
     *
     * { "sourceId": "target-tcg", "items": [{ externalId, name, url, price }] }
     */
    if (request.method === 'POST' && path === '/ingest') {
      let body: { sourceId?: string; items?: Discovered[]; final?: boolean };
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
      const toAnnounce = await store.recordDiscoveries(db, userId, sourceId, fresh, !isFirstSweep);

      for (const item of toAnnounce) {
        await store.attachIdentity(db, userId, sourceId, source.retailer, item);
      }
      // A Watcher-side sweep arrives as many posts, one per query. Only the
      // last one finishes it — see the note on finishSweep. Absent means true,
      // so a caller that posts once (the CLI, a curl by hand) still completes.
      const complete = body.final !== false;
      await store.finishSweep(
        db,
        userId,
        sourceId,
        isFirstSweep ? `seeded ${fresh.length} via watcher` : `watcher: ${fresh.length} new`,
        clean.length,
        true,
        0,
        complete,
      );

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
        // "new" is a question about everything ever seen, and the Watcher is a
        // process that restarts. Empty on a first sweep, which is the point of
        // seeding silently rather than announcing a whole catalogue.
        names: toAnnounce.map((i) => i.name),
      });
    }


    /**
     * Reachability check. The single most useful thing to run after deploying:
     * it answers, from Cloudflare's own egress, which sources this Worker can
     * actually fetch — and therefore which ones have to move to the Watcher.
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
            verdict: 'watcher — never fetched from here',
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
            : `${blocked} source(s) blocked — those belong to the Watcher`,
        checks,
      });
    }

    /**
     * What the Watcher should be looking at.
     *
     * Two lists, and the distinction matters. `products` is the real answer —
     * every known product with a retailer id and a URL, which is what gets
     * polled for stock. `sources` is where to go hunting for products that
     * aren't known yet.
     *
     * The Watcher holds no list of its own. Adding something to watch is a row
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
