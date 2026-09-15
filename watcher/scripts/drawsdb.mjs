// What drawings does the Hub hold, and where do its alerts go? Nothing secret.
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
if (!base || !token) { console.log('no hub url/token in watcher.config.json'); process.exit(1); }
const res = await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer ' + token } });
console.log('GET /api/dashboard ->', res.status);
if (!res.ok) { console.log((await res.text()).slice(0, 400)); process.exit(1); }
const data = await res.json();
console.log('discord main channel   :', data.discord === true);
console.log('discord walmart channel:', data.discordWalmart === true);
console.log('discord wins channel   :', data.discordWins === true);
const rows = data.drawings || [];
console.log('drawings held:', rows.length);
for (const r of rows) {
  console.log(
    ' ', String(r.phase || '?').padEnd(10),
    String(r.windowText || '—').padEnd(22),
    String(r.externalId || '—').padEnd(12),
    String(r.name || '').slice(0, 46),
  );
}
