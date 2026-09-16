// Does each drawing's link actually point at that drawing's item?
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
const r = await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer ' + token } });
const d = await r.json();
for (const x of d.drawings || []) {
  const id = String(x.externalId || '');
  const url = String(x.url || '');
  // Walmart canonical: /ip/<slug>/<usItemId>
  const tail = (url.match(/\/(\d{6,})(?:\?|$)/) || [])[1] || '(no id in url)';
  console.log([
    'externalId : ' + id,
    'name       : ' + String(x.name || '').slice(0, 70),
    'url        : ' + url,
    'url item id: ' + tail + (tail === id ? '   MATCH' : '   *** MISMATCH ***'),
    'image      : ' + String(x.imageUrl || '').slice(0, 90),
    '',
  ].join('\n'));
}
