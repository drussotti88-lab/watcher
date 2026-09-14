import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
const res = await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer ' + token } });
const d = await res.json();
for (const l of d.listings || []) {
  if (![79, 81].includes(l.id)) continue;
  console.log(JSON.stringify(l, null, 1));
  const p = (d.products || []).find((p) => p.key === l.productKey);
  console.log('PRODUCT:', JSON.stringify(p, null, 1));
}
