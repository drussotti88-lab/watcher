// Drop-night picture: what is watched, how fast, and who has walled us.
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
const get = async (p) => {
  const r = await fetch(base + p, { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) { console.log(p, '->', r.status, (await r.text()).slice(0, 200)); return null; }
  return r.json();
};
const d = await get('/api/dashboard');
if (!d) process.exit(1);
const pad = (v, n) => String(v ?? '—').padEnd(n);

console.log('=== TARGET MISSIONS (all) ===');
console.log('mid  lst  every  state  armed  ceil  qty  lastChecked          name');
for (const m of (d.missions || []).filter((m) => m.retailer === 'Target')) {
  console.log(
    pad(m.id, 4), pad(m.listingId, 4), pad(m.checkEverySeconds + 's', 6),
    pad(m.state, 6), pad(m.armed ? 'ARMED' : m.enabled ? 'watch' : 'OFF', 6),
    pad(m.ceiling, 5), pad(m.quantity, 4),
    pad(String(m.lastCheckedAt || '').slice(11, 19), 20),
    String(m.productName || '').slice(0, 40),
  );
}
console.log('\n=== READINESS ===');
console.log(JSON.stringify(d.readiness, null, 1).slice(0, 1200));
console.log('\n=== QUEUES / STOCK LOADS ===');
console.log('queues:', JSON.stringify(d.queues));
console.log('stockLoads:', JSON.stringify(d.stockLoads).slice(0, 400));
console.log('\n=== TARGET LISTINGS NOT ON A MISSION ===');
const withM = new Set((d.missions || []).map((m) => m.listingId));
for (const l of (d.listings || []).filter((l) => l.retailer === 'Target')) {
  if (!withM.has(l.id)) console.log(' ', pad(l.id, 4), String(l.productName || '').slice(0, 56));
}
