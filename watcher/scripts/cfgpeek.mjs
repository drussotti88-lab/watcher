import { readFileSync } from 'node:fs';
const c = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
console.log('intervalSec :', c.intervalSec);
console.log('drawWatch   :', c.drawWatch);
console.log('shops       :', JSON.stringify(c.shops ?? c.retailers ?? null));
console.log('neverTouch  :', JSON.stringify(c.neverTouch ?? null));
