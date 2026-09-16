// How long was each thing actually buyable, and what is it called?
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';

const rows = [];
for (const d of ['2026-09-15', '2026-09-16']) {
  const f = resolve(process.cwd(), 'logs', `activity-${d}.ndjson`);
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
}
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const t = (s) => new Date(s).toLocaleTimeString('en-US', { hour12: false });

let names = new Map();
try {
  const r = await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer ' + token } });
  if (r.ok) {
    const d = await r.json();
    for (const m of d.missions || []) names.set(m.listingId, m.productName);
    console.log('=== DISCORD / ALERT STATE (from the Hub) ===');
    for (const m of (d.missions || []).filter((x) => [5, 7, 9, 13].includes(x.listingId))) {
      console.log(' lst' + String(m.listingId).padEnd(3), 'alerts=' + m.alerts,
        'state=' + m.state, 'armed=' + m.armed, 'ceiling=' + (m.ceiling ?? '—'),
        '|', String(m.productName).slice(0, 50));
    }
  }
} catch (e) { console.log('hub unreachable:', e.message); }

console.log('\n=== BUYABLE WINDOWS (from every check, in order) ===');
const seen = new Map();
for (const r of rows) {
  if (r.kind !== 'check' || r.listingId == null) continue;
  if (r.listingId === 36) continue; // the test listing
  const id = r.listingId;
  const st = r.state === 'in' || r.state === 'in_stock' ? 'in' : r.state;
  const prev = seen.get(id);
  if (!prev || prev.st !== st) {
    if (st === 'in' || (prev && prev.st === 'in')) {
      console.log(' ', t(r.at), 'lst' + String(id).padEnd(4),
        (prev ? prev.st : '?') + ' -> ' + st,
        r.price != null ? ('$' + r.price) : '',
        '|', String(names.get(id) || '').slice(0, 44));
    }
    seen.set(id, { st, at: r.at });
  }
}

console.log('\n=== WHEN WAS PHANTOM ALIVE? (gaps over 10 min in ALL activity) ===');
let prev = null;
for (const r of rows) {
  const ms = Date.parse(r.at);
  if (prev && ms - prev > 10 * 60000) {
    console.log('  DARK', Math.round((ms - prev) / 60000) + 'm', 'from', t(prev), 'to', t(r.at),
      '(' + new Date(prev).toDateString().slice(0, 10) + ')');
  }
  prev = ms;
}
