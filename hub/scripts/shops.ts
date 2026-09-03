/**
 * Turn a shop off, and back on again.
 *
 *   npm run shops                  what is on and what is off
 *   npm run shops off Walmart
 *   npm run shops on Walmart Target
 *
 * ── Why a CLI and not just the app ──────────────────────────────────────────
 *
 * Because of what it is FOR. On 3 Sep 2026 this system made 3,194 page reads
 * in a day from one house, and both Walmart and Target began putting a
 * press-and-hold in front of Roberto's own browsing. The cure is to ask for
 * less for a while — which means turning a shop off tonight and back on at
 * three in the morning, or next Wednesday before a drop. A person cannot be
 * expected to be awake for that, so it has to be something a scheduled task
 * can run, and a scheduled task cannot press a toggle on a web page.
 *
 * Reads and writes the same settings row the app does, so the toggle in
 * Settings and this command can never disagree.
 */
import postgres from 'postgres';

import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';
import * as store from '../src/store.ts';

/** Whose settings. The owner is user 1; a tester runs their own Phantom. */
const USER = Number(process.env.SHOPS_USER_ID ?? 1);

function usage(): never {
  console.error(`
  npm run shops                     what is on and what is off
  npm run shops off <shop> [shop…]  stop checking it, and stop sweeping it
  npm run shops on  <shop> [shop…]  start again

  Shops: ${store.KNOWN_RETAILERS.join(', ')}
`);
  process.exit(1);
}

/** Accept "walmart", "pokemon center", "Pokemon Center" — reject the rest. */
function canonical(name: string): string {
  const want = name.trim().toLowerCase();
  const hit = store.KNOWN_RETAILERS.find((r) => r.toLowerCase() === want);
  if (!hit) {
    console.error(`\n  "${name}" is not a shop this system watches.\n`);
    process.exit(1);
  }
  return hit;
}

async function main(): Promise<void> {
  const [action, ...names] = process.argv.slice(2);
  if (action && action !== 'on' && action !== 'off') usage();
  if (action && names.length === 0) usage();

  let url: string;
  try {
    url = connectionStringFrom(process.env);
  } catch (err) {
    console.error(`\n  ${(err as Error).message}`);
    console.error('  Run this through npm — the npm script is what loads .env.local.\n');
    process.exit(1);
  }

  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
  const db = fromPostgres(client as unknown as PostgresLike);

  try {
    const before = await store.getSettings(db, USER);
    let off = new Set(before.pausedRetailers);

    if (action) {
      const shops = names.map(canonical);
      for (const shop of shops) {
        if (action === 'off') off.add(shop);
        else off.delete(shop);
      }
      // Written through setSettings, so the same validation the app applies
      // applies here. A name this file allowed but the store refuses is a
      // disagreement worth failing on rather than papering over.
      const after = await store.setSettings(db, USER, { pausedRetailers: [...off] });
      off = new Set(after.pausedRetailers);
      console.log(`\n  ${shops.join(', ')} — now ${action === 'off' ? 'OFF' : 'on'}.`);
    }

    console.log('');
    for (const shop of store.KNOWN_RETAILERS) {
      console.log(`  ${shop.padEnd(16)}  ${off.has(shop) ? 'OFF — not checked, not swept' : 'on'}`);
    }
    console.log(
      off.size === store.KNOWN_RETAILERS.length
        ? '\n  Every shop is off. Phantom will run and find nothing to do.\n'
        : '\n',
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
