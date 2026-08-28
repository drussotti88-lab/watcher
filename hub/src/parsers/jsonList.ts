/**
 * Generic JSON list extraction — pure.
 *
 * Retailer search/browse endpoints all return "an array of things somewhere in
 * a nested object". Rather than a bespoke parser per retailer, a source
 * declares where the array lives and which fields to read. New retailer with a
 * JSON endpoint = a config row, not a code change.
 */
import type { Discovered, SourceConfig } from '../types.ts';

/** Walk a dotted path. Supports [0] indexing. Returns undefined if absent. */
export function pluck(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const rawPart of path.split('.')) {
    const part = rawPart.trim();
    if (!part) continue;
    const idx = /^\[(\d+)\]$/.exec(part);
    if (idx) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
      continue;
    }
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseJsonList(payload: unknown, config: SourceConfig): Discovered[] {
  const raw = pluck(payload, config.itemsPath ?? '');
  if (!Array.isArray(raw)) return [];

  const idField = config.idField ?? 'id';
  const nameField = config.nameField ?? 'title';
  const urlField = config.urlField ?? 'url';

  const out: Discovered[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const externalId = str(pluck(item, idField)).trim();
    if (!externalId) continue;
    out.push({
      externalId,
      name: str(pluck(item, nameField)).trim() || externalId,
      url: str(pluck(item, urlField)).trim(),
      price: config.priceField ? num(pluck(item, config.priceField)) : null,
    });
  }
  return out;
}
