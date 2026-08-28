/**
 * Keyword filtering.
 *
 * Target's catalogue is millions of items; without this, one sweep would
 * announce the entire store. A source declares filters in its config and a
 * product must match at least one to survive. No filters means keep everything,
 * which is right for a source that is already scoped (a Pokémon-only feed).
 */
import type { Discovered } from './types.ts';

/** Fold accents so "Pokémon" matches a filter written "pokemon". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function matches(item: Discovered, filters: string[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  const hay = fold(`${item.name} ${item.url}`);
  return filters.some((f) => {
    const needle = fold(f).trim();
    return needle.length > 0 && hay.includes(needle);
  });
}

export function applyFilters(items: Discovered[], filters?: string[]): Discovered[] {
  if (!filters || filters.length === 0) return items;
  return items.filter((i) => matches(i, filters));
}

/** Drop repeats within a single sweep — sitemaps do contain duplicates. */
export function dedupe(items: Discovered[]): Discovered[] {
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const item of items) {
    if (!item.externalId || seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    out.push(item);
  }
  return out;
}
