// What actually happened last night. Reads the raw activity ndjson, not the Hub.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), 'logs');
const days = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (days.length === 0) { console.log('usage: node scripts/postmortem.mjs 2026-09-15 2026-09-16'); process.exit(1); }

const rows = [];
for (const d of days) {
  const f = resolve(dir, `activity-${d}.ndjson`);
  if (!existsSync(f)) { console.log('missing', f); continue; }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
}
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const t = (r) => new Date(r.at).toLocaleTimeString('en-US', { hour12: false });
const day = (r) => new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

console.log('rows:', rows.length, '| first', rows[0] && day(rows[0]) + ' ' + t(rows[0]),
  '| last', rows.at(-1) && day(rows.at(-1)) + ' ' + t(rows.at(-1)));

// ── 1. Every state change worth knowing about ──
console.log('\n=== STOCK / STAGED / PREORDER EVENTS ===');
let n = 0;
for (const r of rows) {
  const m = String(r.message || '');
  const inStock = r.state === 'in' || r.state === 'in_stock';
  const staged = /staged|load|warehouse/i.test(m) || r.kind === 'staged';
  if (!inStock && !staged) continue;
  if (/Test pens/i.test(String(r.detail || '') + m)) continue;
  n++;
  console.log(' ', day(r), t(r), String(r.retailer || '').padEnd(8),
    'lst' + String(r.listingId ?? '-').padEnd(4), String(r.state || '').padEnd(6), m.slice(0, 80));
}
if (!n) console.log('  (none)');

// ── 2. Walls and queues ──
console.log('\n=== WALLS / QUEUES / CHALLENGES ===');
let w = 0;
for (const r of rows) {
  const m = String(r.message || '');
  const dt = String(r.detail || '');
  if (!/^blocked:/.test(m) && !/waiting room|QUEUE:|challenge/i.test(m + dt)) continue;
  w++;
  console.log(' ', day(r), t(r), String(r.retailer || '').padEnd(8),
    'lst' + String(r.listingId ?? '-').padEnd(4), (m + ' | ' + dt).slice(0, 96));
}
if (!w) console.log('  (none — nothing was ever walled or queued)');

// ── 3. Errors and failed reads ──
console.log('\n=== ERRORS / UNREADABLE ===');
const errs = rows.filter((r) => r.level === 'error');
console.log('  count:', errs.length);
for (const r of errs.slice(0, 25)) {
  console.log(' ', day(r), t(r), String(r.retailer || '').padEnd(8),
    'lst' + String(r.listingId ?? '-').padEnd(4), String(r.message || '').slice(0, 80));
}

// ── 4. Coverage: reads per hour, and the biggest gap per listing ──
console.log('\n=== READS PER HOUR (kind=check) ===');
const byHour = new Map();
for (const r of rows) {
  if (r.kind !== 'check') continue;
  const k = day(r) + ' ' + t(r).slice(0, 2) + ':00';
  byHour.set(k, (byHour.get(k) || 0) + 1);
}
for (const [k, v] of byHour) console.log(' ', k, String(v).padStart(4), '#'.repeat(Math.min(60, Math.round(v / 3))));

console.log('\n=== BIGGEST UNWATCHED GAP PER LISTING (checks only) ===');
const last = new Map(); const gap = new Map(); const gapAt = new Map(); const count = new Map();
for (const r of rows) {
  if (r.kind !== 'check' || r.listingId == null) continue;
  const id = r.listingId; const ms = Date.parse(r.at);
  count.set(id, (count.get(id) || 0) + 1);
  if (last.has(id)) {
    const d = ms - last.get(id);
    if (d > (gap.get(id) || 0)) { gap.set(id, d); gapAt.set(id, r.at); }
  }
  last.set(id, ms);
}
const ids = [...gap.keys()].sort((a, b) => (gap.get(b) || 0) - (gap.get(a) || 0));
console.log('  lst   reads  worst gap   ended at');
for (const id of ids.slice(0, 20)) {
  console.log('  ' + String(id).padEnd(5), String(count.get(id)).padStart(5),
    (Math.round(gap.get(id) / 60000) + 'm').padStart(9), '  ' + day({ at: gapAt.get(id) }) + ' ' + t({ at: gapAt.get(id) }));
}
