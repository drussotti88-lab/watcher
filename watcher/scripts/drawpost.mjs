/**
 * Does the drawings POST work with a REAL row, not an empty list?
 *
 * The first version of this sent { drawings: [] }, got a clean 200, and proved
 * nothing about the payload Phantom actually sends. An empty list exercises no
 * column, no type and no constraint.
 */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('C:/Users/danru/Pokemon/watcher/watcher.config.json', 'utf8'));
const url = String(cfg.hub?.url ?? '').replace(/\/+$/, '');
const token = String(cfg.hub?.token ?? '');

const row = {
  usItemId: '21009455186',
  name: 'Pokemon TCG: 30th Celebration ex Box Bundle - Sylveon ex and Greninja ex',
  url: 'https://www.walmart.com/ip/x/21009455186',
  price: 69.49,
  orderLimit: 3,
  imageUrl: '',
  phase: 'announced',
  showDrawCTA: false,
  windowLabel: 'Drawing starts',
  windowText: 'Sep 16, 2:00pm PDT',
  windowAt: '2026-09-16T21:00:00.000Z',
  sellerName: 'Walmart.com',
  sellerId: 'F55CDC31AB754BB68FE0B39041159D63',
  state: 'out',
};

const res = await fetch(`${url}/api/drawings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ retailer: 'Walmart', drawings: [row] }),
});
console.log('\n  POST with one real row ->', res.status, res.statusText);
console.log('  body:', (await res.text()).slice(0, 600));
