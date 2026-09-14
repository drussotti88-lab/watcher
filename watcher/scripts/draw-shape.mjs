/**
 * The exact shape of the drawing module, from the saved capture.
 *
 * Reads probe-artifacts/ locally and prints ONLY the drawing fields. The raw
 * file carries the account's own identifiers - visitor id, store, postcode -
 * and the rule since 4 Sep is that a diagnostic is not exempt from the rule it
 * was written to investigate. Nothing here prints a whole node.
 */
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'C:/Users/danru/Pokemon/watcher/probe-artifacts';
const file = readdirSync(dir).filter((n) => /^draw-.*\.json$/.test(n)).sort().pop();
console.log('\n  reading', file, '\n');
const d = JSON.parse(readFileSync(dir + '/' + file, 'utf8'));

const modules = d?.props?.pageProps?.initialData?.contentLayout?.modules ?? [];
console.log('  modules on the page:');
for (let i = 0; i < modules.length; i++) {
  const m = modules[i];
  console.log(`   [${i}] ${String(m?.type ?? '?').padEnd(22)} ${String(m?.name ?? '').slice(0, 62)}`);
}

// The carousel: every field on a product, so the reader is built from the
// real key names rather than from the four I happened to grep for.
for (let i = 0; i < modules.length; i++) {
  const products = modules[i]?.configs?.productsConfig?.products;
  if (!Array.isArray(products) || products.length === 0) continue;
  console.log(`\n  module[${i}] carries ${products.length} products. Keys on one:`);
  console.log('   ', Object.keys(products[0]).join(' '));
  console.log('\n  each product:');
  for (const p of products) {
    console.log(`   ${String(p.usItemId).padEnd(13)} $${String(p.price).padEnd(8)} ` +
      `showDrawCTA=${p.showDrawCTA}  ${String(p.name).slice(0, 58)}`);
  }
  // Anything on the module itself that might carry the window.
  const cfg = modules[i]?.configs ?? {};
  console.log('\n  module config keys:', Object.keys(cfg).join(' '));
}

// Where does "starts Sep 16, 2:00pm PDT" live? Find every string that looks
// like a date or a time, with the path to it - that is the window.
const found = [];
const walk = (n, at = '$', depth = 0) => {
  if (depth > 14 || found.length > 60) return;
  if (typeof n === 'string') {
    if (/\b(starts?|ends?|closes?|opens?)\b/i.test(n) ||
        /\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(n) ||
        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/.test(n) ||
        /\d{4}-\d{2}-\d{2}T/.test(n)) {
      found.push(`${at}  ${n.slice(0, 90)}`);
    }
    return;
  }
  if (n === null || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    walk(v, Array.isArray(n) ? `${at}[${k}]` : `${at}.${k}`, depth + 1);
  }
};
walk(d?.props?.pageProps?.initialData ?? {});
console.log('\n  strings that look like a date or a window:');
for (const f of found.slice(0, 40)) console.log('   ', f);

console.log('\n  runtimeConfig draw keys:');
for (const [k, v] of Object.entries(d?.runtimeConfig ?? {})) {
  if (/draw/i.test(k)) console.log(`    ${k} = ${String(v).slice(0, 80)}`);
}
