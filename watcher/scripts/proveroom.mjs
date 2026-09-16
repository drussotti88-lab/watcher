// Prove the Walmart room, then say the live drawings into it.
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
const post = async (path) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token },
  });
  console.log(path, '->', res.status, (await res.text()).replace(/\s+/g, ' ').slice(0, 200));
};
await post('/api/notify/test?kind=hello');
await post('/api/drawings/announce');
