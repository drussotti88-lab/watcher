/**
 * Did the drawings report reach the Hub, and if not, what did it say?
 *
 * reportDrawings swallows its error and returns null so a bad minute cannot
 * stop a pass - which is right, and which also made a failure invisible. This
 * asks once, loudly, and prints the status. Nothing sensitive: the token goes
 * in a header and is never printed.
 */
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('C:/Users/danru/Pokemon/watcher/watcher.config.json', 'utf8'));
const url = String(cfg.hub?.url ?? '').replace(/\/+$/, '');
const token = String(cfg.hub?.token ?? '');
console.log('\n  hub:', url || '(none)');
console.log('  token:', token ? `present (${token.length} chars)` : 'ABSENT');

const res = await fetch(`${url}/api/drawings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ retailer: 'Walmart', drawings: [] }),
});
console.log('\n  POST /api/drawings ->', res.status, res.statusText);
const text = await res.text();
console.log('  body:', text.slice(0, 400));
