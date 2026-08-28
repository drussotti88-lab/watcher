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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Post everything a set of sweeps found, then mark it announced. */
async function publish(db: Sql, env: Env, results: SweepResult[], now: string): Promise<void> {
  for (const result of results) {
    if (!result.ok || result.fresh.length === 0) continue;
    const source = await store.getSource(db, result.sourceId);
    await announce(
      env.DISCORD_WEBHOOK_URL,
      result.label,
      source?.retailer ?? '',
      result.fresh,
      now,
    );
    await store.markAnnounced(
      db,
      result.sourceId,
      result.fresh.map((f) => f.externalId),
    );
  }
  const opsUrl = env.DISCORD_OPS_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  await reportOps(opsUrl, results, now);
}

function authorised(request: Request, env: Env): boolean {
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') && header.slice(7) === env.INGEST_TOKEN;
}

/** Build the API. Everything it needs arrives as an argument. */
export function createHandler(db: Sql, env: Env): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = new Date().toISOString();

    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      const sources = await store.listSources(db);
      return json({
        ok: true,
        sources: sources.map((s) => ({
          id: s.id,
          label: s.label,
          via: s.via,
          seeded: s.seeded,
          lastSweptAt: s.lastSweptAt,
          lastStatus: s.lastStatus,
          lastCount: s.lastCount,
        })),
      });
    }

    // Everything below changes state or costs requests — token required.
    if (!authorised(request, env)) {
      return json({ error: 'unauthorised' }, 401);
    }

    /** Kick a sweep by hand. `?source=<id>` to do just one. */
    if (request.method === 'POST' && path === '/sweep') {
      const only = url.searchParams.get('source');
      let results: SweepResult[];
      if (only) {
        const source = await store.getSource(db, only);
        if (!source) return json({ error: `no source "${only}"` }, 404);
        results = [await sweepSource(db, source)];
      } else {
        results = await sweepAll(db);
      }
      await publish(db, env, results, now);
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
     * Watcher ingest. The extension posts what it saw on a site the Hub can't
     * reach. Identical downstream handling: diff, seed-or-announce, identity.
     *
     * { "sourceId": "pc-newreleases", "items": [{ externalId, name, url, price }] }
     */
    if (request.method === 'POST' && path === '/ingest') {
      let body: { sourceId?: string; items?: Discovered[] };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }
      const sourceId = (body.sourceId ?? '').trim();
      if (!sourceId || !Array.isArray(body.items)) {
        return json({ error: 'need sourceId and items[]' }, 400);
      }
      const source = await store.getSource(db, sourceId);
      if (!source) return json({ error: `no source "${sourceId}"` }, 404);

      const config = source.config;
      const clean = dedupe(
        applyFilters(
          body.items.filter((i) => i && typeof i.externalId === 'string' && i.externalId),
          config.filters,
        ),
      );

      const known = await store.knownIds(db, sourceId);
      const fresh = clean.filter((i) => !known.has(i.externalId));
      const isFirstSweep = !source.seeded;
      const toAnnounce = await store.recordDiscoveries(db, sourceId, fresh, !isFirstSweep);

      for (const item of toAnnounce) {
        await store.attachIdentity(db, sourceId, source.retailer, item);
      }
      await store.finishSweep(
        db,
        sourceId,
        isFirstSweep ? `seeded ${fresh.length} via watcher` : `watcher: ${fresh.length} new`,
        clean.length,
        true,
      );

      if (toAnnounce.length > 0) {
        await announce(
          env.DISCORD_WEBHOOK_URL,
          source.label,
          source.retailer,
          toAnnounce,
          now,
        );
        await store.markAnnounced(
          db,
          sourceId,
          toAnnounce.map((f) => f.externalId),
        );
      }

      return json({
        received: clean.length,
        new: fresh.length,
        announced: toAnnounce.length,
        seeded: isFirstSweep,
      });
    }

    /**
     * Reachability check. The single most useful thing to run after deploying:
     * it answers, from Cloudflare's own egress, which sources this Worker can
     * actually fetch — and therefore which ones have to move to the Watcher.
     */
    if ((request.method === 'POST' || request.method === 'GET') && path === '/probe') {
      const sources = await store.listAllSources(db);
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
        store.watchlist(db),
        store.listSources(db, 'watcher'),
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
