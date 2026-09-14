import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
const res = await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer ' + token } });
const d = await res.json();
const pad = (v, n) => String(v ?? '—').padEnd(n);
console.log('MISSIONS matching 30th/Celebration');
console.log('mid  lst  release     every  state  armed  retailer  name');
for (const m of d.missions || []) {
  if (!/30th|celebration/i.test(m.productName || m.label || '')) continue;
  console.log(
    pad(m.id, 4), pad(m.listingId, 4),
    pad(String(m.releaseDate ?? '—').slice(0, 10), 11),
    pad(m.checkEverySeconds + 's', 6),
    pad(m.state, 6), pad(m.armed ? 'ARMED' : m.enabled ? 'watch' : 'off', 6),
    pad(m.retailer, 9), String(m.productName || '').slice(0, 42),
  );
}
console.log('\nLISTINGS matching 30th/Celebration with no mission');
const withMission = new Set((d.missions || []).map((m) => m.listingId));
for (const l of d.listings || []) {
  if (!/30th|celebration/i.test(l.productName || '')) continue;
  if (withMission.has(l.id)) continue;
  console.log(pad(l.id, 4), pad(l.retailer, 9), String(l.productName || '').slice(0, 50));
}
