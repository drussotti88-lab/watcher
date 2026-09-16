// How late were we? The gap between the last "out" read and the first "in" one
// is the window in which it went live unseen. That is our detection lag, bounded.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

const prev = new Map();
console.log('lst   went in at   last seen out   blind window   alerts?');
for (const r of rows) {
  if (r.kind !== 'check' || r.listingId == null || r.listingId === 36) continue;
  const st = (r.state === 'in' || r.state === 'in_stock') ? 'in' : r.state;
  const p = prev.get(r.listingId);
  if (st === 'in' && p && p.st !== 'in') {
    const mins = ((Date.parse(r.at) - Date.parse(p.at)) / 60000).toFixed(1);
    console.log(
      String(r.listingId).padEnd(5), t(r.at).padEnd(12), t(p.at).padEnd(15),
      (mins + ' min').padStart(12),
    );
  }
  prev.set(r.listingId, { st, at: r.at });
}

console.log('\n=== HUB TRAFFIC AROUND THE DROP (kind=hub, 02:00-05:00) ===');
let k = 0;
for (const r of rows) {
  if (r.kind !== 'hub') continue;
  const hh = Number(t(r.at).slice(0, 2));
  const d = new Date(r.at).getDate();
  if (d !== 16 || hh < 2 || hh > 5) continue;
  k++;
  if (k <= 20) console.log(' ', t(r.at), String(r.level || '').padEnd(5), String(r.message || '').slice(0, 90));
}
console.log('  total hub lines in window:', k);

console.log('\n=== ANY LINE MENTIONING ALERT / DISCORD / NOTIFIED ===');
let a = 0;
for (const r of rows) {
  const s = String(r.message || '') + ' ' + String(r.detail || '');
  if (!/alert|discord|notifi/i.test(s)) continue;
  a++;
  if (a <= 15) console.log(' ', t(r.at), String(r.kind).padEnd(7), s.slice(0, 90));
}
console.log('  total:', a);
