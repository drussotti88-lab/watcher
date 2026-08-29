/**
 * The sweep: fetch a source, parse it, filter it, and work out what's new.
 *
 * The whole of step 1 lives here. Note what it does NOT do — it never checks
 * whether anything is in stock. Catalog discovery is a different, cheaper and
 * far less contested signal: knowing a SKU exists before it is buyable.
 */
import type { Discovered, SourceRow, SweepResult } from './types.ts';
import type { Sql } from './db.ts';
import { fetchText as realFetchText, FetchError } from './fetcher.ts';
import { extractLocs, sitemapKind } from './parsers/sitemap.ts';
import { parseJsonList } from './parsers/jsonList.ts';
import { fromUrl } from './parsers/identify.ts';
import { applyFilters, dedupe } from './filter.ts';
import * as store from './store.ts';

/** Cap the work one sweep can do, so a huge sitemap can't blow the CPU budget. */
const DEFAULT_CHILD_LIMIT = 3;
const MAX_ITEMS_PER_SWEEP = 5000;

/**
 * The network is injected rather than imported directly, so the sweep can be
 * driven from saved fixtures in tests. Every retailer parser breaks eventually
 * and you need to fix it without waiting for a live drop to reproduce against.
 */
export type Fetcher = (url: string, headers?: Record<string, string>) => Promise<string>;

/**
 * Take `limit` items starting at `cursor`, wrapping around.
 *
 * This is what stops a big sitemap index from being half-blind: sweep children
 * 0–2 this hour, 3–5 next, and eventually you have seen all of them. Pure, so
 * it's easy to prove it covers the whole list.
 */
export function rotate<T>(items: T[], cursor: number, limit: number): T[] {
  if (items.length === 0 || limit <= 0) return [];
  if (limit >= items.length) return items.slice();
  const start = ((cursor % items.length) + items.length) % items.length;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[(start + i) % items.length]!);
  return out;
}

/** Where the next sweep of this source should start. */
export function nextCursor(cursor: number, limit: number, total: number): number {
  if (total <= 0 || limit <= 0) return 0;
  return (cursor + limit) % total;
}

/** Turn sitemap XML into candidate products. Pure given the text. */
export function productsFromSitemap(xml: string, retailer: string): Discovered[] {
  const locs = extractLocs(xml);
  const out: Discovered[] = [];
  for (const loc of locs) {
    const item = fromUrl(loc, retailer);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Collect everything a source currently lists.
 *
 * For a sitemap index this walks a bounded number of children — enough to see
 * new products without downloading a retailer's entire catalogue every hour.
 */
async function collect(
  source: SourceRow,
  fetchText: Fetcher,
): Promise<{ items: Discovered[]; childTotal: number }> {
  const config = source.config;
  const headers = config.headers ?? {};

  if (source.kind === 'json_list') {
    const text = await fetchText(source.url, headers);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new FetchError('response was not valid JSON', 0, false);
    }
    return { items: parseJsonList(payload, config), childTotal: 0 };
  }

  if (source.kind === 'sitemap' || source.kind === 'sitemap_index') {
    const text = await fetchText(source.url, headers);
    const kind = sitemapKind(text);

    if (kind === 'index' || source.kind === 'sitemap_index') {
      const children = extractLocs(text);
      const limit = config.childLimit ?? DEFAULT_CHILD_LIMIT;
      const window = rotate(children, source.cursor ?? 0, limit);
      const all: Discovered[] = [];
      for (const child of window) {
        try {
          const childXml = await fetchText(child, headers);
          all.push(...productsFromSitemap(childXml, source.retailer));
        } catch (err) {
          // One bad child shouldn't void the sweep — note it and carry on.
          console.warn('child sitemap failed', child, String(err));
        }
        if (all.length >= MAX_ITEMS_PER_SWEEP) break;
      }
      return { items: all, childTotal: children.length };
    }
    return { items: productsFromSitemap(text, source.retailer), childTotal: 0 };
  }

  // 'watcher' sources are never fetched here; the extension posts them in.
  return { items: [], childTotal: 0 };
}

/**
 * Sweep one source end to end.
 *
 * The first sweep of a source seeds silently: everything is recorded, nothing
 * is announced. Otherwise turning on a source with 800 products in it would
 * fire 800 alerts and you'd mute the channel forever.
 */
export async function sweepSource(
  db: Sql,
  userId: number,
  source: SourceRow,
  fetchText: Fetcher = realFetchText,
): Promise<SweepResult> {
  const config = source.config;
  const base: SweepResult = {
    sourceId: source.id,
    label: source.label,
    ok: true,
    seen: 0,
    fresh: [],
    seeded: source.seeded,
  };

  let collected: { items: Discovered[]; childTotal: number };
  try {
    collected = await collect(source, fetchText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishSweep(db, userId, source.id, `error: ${message}`, 0, source.seeded, source.cursor ?? 0);
    await store.logEvent(db, userId, 'sweep_error', `${source.label}: ${message}`);
    return { ...base, ok: false, error: message };
  }

  const items = dedupe(applyFilters(collected.items, config.filters)).slice(0, MAX_ITEMS_PER_SWEEP);
  const known = await store.knownIds(db, userId, source.id);
  const fresh = items.filter((i) => !known.has(i.externalId));

  // Announce only once this source is FULLY seeded. With a rotating cursor a
  // single window covers part of the index, so declaring "seeded" after one
  // pass would make the next window look entirely new and fire a storm.
  const alreadySeeded = source.seeded;
  const announced = await store.recordDiscoveries(db, userId, source.id, fresh, alreadySeeded);

  for (const item of announced) {
    await store.attachIdentity(db, userId, source.id, source.retailer, item);
  }

  const limit = config.childLimit ?? DEFAULT_CHILD_LIMIT;
  const advanced = nextCursor(source.cursor ?? 0, limit, collected.childTotal);
  // A lap is complete when there was nothing to rotate through (a plain
  // sitemap or JSON list), or when the cursor has wrapped back to the start.
  const lapComplete = collected.childTotal === 0 || advanced === 0;
  const nowSeeded = alreadySeeded || lapComplete;

  const status = alreadySeeded
    ? `ok, ${fresh.length} new of ${items.length}`
    : lapComplete
      ? `seeded ${fresh.length} on final pass`
      : `seeding, pass ends at child ${advanced} of ${collected.childTotal}`;

  await store.finishSweep(db, userId, source.id, status, items.length, nowSeeded, advanced);

  if (!alreadySeeded) {
    await store.logEvent(
      db,
      userId,
      'seed',
      `${source.label}: recorded ${fresh.length} silently (${status})`,
    );
  }

  return { ...base, seen: items.length, fresh: announced, seeded: nowSeeded };
}

/** Sweep everything the Hub can reach itself. */
export async function sweepAll(
  db: Sql,
  userId: number,
  fetchText: Fetcher = realFetchText,
): Promise<SweepResult[]> {
  const sources = await store.listSources(db, userId, 'hub');
  const results: SweepResult[] = [];
  for (const source of sources) {
    results.push(await sweepSource(db, userId, source, fetchText));
  }
  return results;
}
