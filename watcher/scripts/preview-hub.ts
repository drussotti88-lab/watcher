/**
 * Render the Hub dashboard with fixture data and photograph it, so a visual
 * pass is judged on pixels instead of on faith. Local only — nothing here
 * talks to the real Hub.
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { dashboardPage } from '../../hub/src/page.ts';

const swatch = (c: string): string =>
  'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88">` +
    `<rect width="88" height="88" rx="12" fill="${c}"/>` +
    `<circle cx="44" cy="36" r="17" fill="rgba(255,255,255,.35)"/>` +
    `<rect x="20" y="60" width="48" height="9" rx="4" fill="rgba(255,255,255,.25)"/></svg>`);

const days = (n: number): string =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ago = (mins: number): string => new Date(Date.now() - mins * 60000).toISOString();

const mission = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1, listingId: 1, productKey: 'p1', productName: 'Pokémon TCG product',
  imageUrl: swatch('#4a4470'), msrp: 49.99, retailer: 'Target', externalId: '1012644666',
  url: 'https://example.test', label: '', enabled: true, armed: false, ceiling: null,
  quantity: 1, sellerPolicy: 'retailer_only', checkEverySeconds: 60, notes: '',
  state: 'out', confidence: 'exact', price: null, sellerKind: 'retailer', sellerName: 'Target',
  availableQuantity: null, orderLimit: null, isPreOrder: false, releaseDate: null, note: '',
  lastCheckedAt: ago(3), lastChangedAt: ago(200), ...over,
});
const find = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1, sourceId: 'target-tcg', externalId: 'x', name: 'A find', url: 'https://example.test',
  price: 49.99, kind: 'elite trainer box', confidence: 'sealed', foundBy: '',
  imageUrl: swatch('#3c6355'), status: 'new', firstSeenAt: ago(60 * 20), alreadyHave: false,
  retailer: 'Target', state: 'out', isPreOrder: false, releaseDate: '', orderLimit: null,
  signal: '', otherOffers: null, ...over,
});

const DASHBOARD = {
  you: '',
  now: new Date().toISOString(),
  settings: { taxRate: 0.0975, shippingAllowance: 6, spendCapDay: 300, sweepEveryHours: 24 },
  sweep: { queued: false, lastSweptAt: ago(60 * 7), lastStatus: 'ok — 131 seen' },
  authorisations: [], committed: 0, queues: [],
  canCurate: true,
  requests: [],
  capabilities: [
    { name: 'Target', watch: 'live', blocked: null },
    { name: 'Walmart', watch: 'live', blocked: null },
    { name: 'Pokémon Center', watch: 'partial',
      blocked: { since: '2026-09-01', what: 'behind a bot wall since 1 Sep; nothing can be read' } },
  ],
  missions: [
    mission({ id: 1, listingId: 1, productName: 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box', imageUrl: swatch('#6c5fb0'), releaseDate: days(16), state: 'out' }),
    mission({ id: 2, listingId: 2, productName: 'Pokémon Trading Card Game: 30th Celebration Sylveon ex Box', imageUrl: swatch('#a05f8a'), releaseDate: days(16), state: 'out' }),
    mission({ id: 3, listingId: 3, productName: 'Mega Zygarde ex Premium Collection', imageUrl: swatch('#3c6355'), state: 'in', price: 44.99, armed: true, ceiling: 50, msrp: 44.99 }),
    mission({ id: 4, listingId: 4, productName: 'Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box', imageUrl: swatch('#5b7ba6'), retailer: 'Pokemon Center', externalId: '10-10447-111', releaseDate: days(15), isPreOrder: true, state: 'in', price: 59.99 }),
    mission({ id: 5, listingId: 5, productName: 'POKEMON AZURE LEGENDS TIN', imageUrl: swatch('#8a6a3c'), retailer: 'Walmart', externalId: '55531234', state: 'in', price: 49.99, sellerKind: 'marketplace', sellerName: 'Venado Inc' }),
    mission({ id: 6, listingId: 6, productName: 'Pokemon Prismatic Evolutions Mini Tins', imageUrl: swatch('#46356e'), retailer: 'Walmart', externalId: '99881122', state: 'out', enabled: false }),
  ],
  products: [
    { key: 'p1', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', releaseDate: days(16), msrp: 69.99, imageUrl: swatch('#6c5fb0'), notes: '' },
    { key: 'p2', name: '30th Celebration Sylveon ex Box', releaseDate: days(16), msrp: 29.99, imageUrl: swatch('#a05f8a'), notes: '' },
    { key: 'p3', name: 'Mega Zygarde ex Premium Collection', releaseDate: null, msrp: 44.99, imageUrl: swatch('#3c6355'), notes: '' },
  ],
  listings: [
    { id: 1, productKey: 'p1', productName: '30th ETB', retailer: 'Target', externalId: '1012644666', url: 'https://example.test', sellerKind: 'retailer', sellerName: 'Target' },
    { id: 2, productKey: 'p2', productName: 'Sylveon ex Box', retailer: 'Target', externalId: '1012644667', url: 'https://example.test', sellerKind: 'retailer', sellerName: 'Target' },
    { id: 3, productKey: 'p3', productName: 'Mega Zygarde', retailer: 'Target', externalId: '1012644668', url: 'https://example.test', sellerKind: 'retailer', sellerName: 'Target' },
  ],
  runs: [
    { startedAt: ago(4), productName: 'Mega Zygarde ex Premium Collection', retailer: 'Target', outcome: 'in_stock', reason: 'in stock at $44.99 — this mission is watching only', price: 44.99, ms: 812 },
    { startedAt: ago(40), productName: '30th Celebration Elite Trainer Box', retailer: 'Target', outcome: 'declined', reason: 'out of stock', price: null, ms: 640 },
    { startedAt: ago(90), productName: 'POKEMON AZURE LEGENDS TIN', retailer: 'Walmart', outcome: 'declined', reason: 'marketplace seller: Venado Inc — policy is the retailer only', price: 49.99, ms: 4200 },
    { startedAt: ago(60 * 9), productName: 'Pitch Black ETB', retailer: 'Target', outcome: 'failed', reason: 'the page could not be read', price: null, ms: 30000 },
  ],
  changes: [
    { at: ago(4), productName: 'Mega Zygarde ex Premium Collection', retailer: 'Target', state: 'in', price: 44.99 },
    { at: ago(60 * 26), productName: 'POKEMON AZURE LEGENDS TIN', retailer: 'Walmart', state: 'out', price: null },
  ],
  discoveries: [
    find({ id: 1, name: 'Pokémon TCG: Phantasmal Flames Booster Bundle', retailer: 'Target', isPreOrder: true, state: 'in', price: 26.94, releaseDate: days(11), signal: 'scheduled', firstSeenAt: ago(60 * 3), imageUrl: swatch('#6c5fb0'), kind: 'booster bundle' }),
    find({ id: 2, name: 'Pokémon TCG: Mega Evolution—Pitch Black Booster Display Box', retailer: 'Pokemon Center', state: 'in', price: 161.64, signal: 'buyable', firstSeenAt: ago(60 * 30), imageUrl: swatch('#46356e'), kind: 'booster box' }),
    find({ id: 3, name: 'Pokemon Trading Card Game Scarlet & Violet 10 Destined Rivals Booster Bundle', retailer: 'Walmart', state: 'out', price: 26.94, otherOffers: 4, firstSeenAt: ago(60 * 5), imageUrl: swatch('#8a6a3c'), kind: 'booster bundle', signal: 'recent' }),
    find({ id: 4, name: 'Pokemon Prismatic Evolutions Mini Tins', retailer: 'Walmart', state: 'out', price: 65.00, otherOffers: 9, firstSeenAt: ago(60 * 80), imageUrl: swatch('#a05f8a'), kind: 'mini tin' }),
    find({ id: 5, name: 'Pokémon TCG: 30th Celebration Poster Collection', retailer: 'Target', state: 'out', price: 19.99, releaseDate: days(16), firstSeenAt: ago(60 * 49), imageUrl: swatch('#5b7ba6'), kind: 'poster collection' }),
    mission({ id: 6, listingId: 6, productName: 'Pokemon Prismatic Evolutions Mini Tin', imageUrl: swatch('#7a5f8a'), retailer: 'Walmart', externalId: '22201', state: 'out' }),
    mission({ id: 7, listingId: 7, productName: 'Pokemon Mega Heroes Mini Tin Lucario', imageUrl: swatch('#4a6f8a'), retailer: 'Walmart', externalId: '22202', state: 'in', price: 29.99 }),
  ],
};

const html = dashboardPage();
const server = createServer((req, res) => {
  const path = String(req.url ?? '/').split('?')[0]!;
  if (path === '/api/dashboard') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(DASHBOARD));
  } else if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise<void>((r) => server.listen(4173, r));

const tag = process.argv[2] ?? 'shot';
mkdirSync('/home/claude/scratch/hubshots', { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, h, label] of [[390, 844, 'phone'], [1280, 900, 'desktop']] as const) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto('http://localhost:4173/');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-missions.png` });
  await page.evaluate(() => document.getElementById('flt-missions-more')?.click());
  await page.waitForTimeout(250);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-filters.png` });
  await page.evaluate(() => document.getElementById('flt-missions-more')?.click());
  await page.waitForTimeout(250);
  await page.click('[data-tab=finds]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-finds.png` });
  await page.click('[data-tab=activity]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-activity.png` });
  await page.click('[data-tab=missions]');
  await page.waitForTimeout(300);
  await page.click('#tab-missions .vt [data-view=grid]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-grid.png` });
  await page.click('#tab-missions .vt [data-view=list]');
  await page.waitForTimeout(200);
  await page.getByText('Settings').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-popup.png` });
  // The front door, opened by hand — the fixture has missions, so it does not
  // greet on its own.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#wiz-open');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-wizard.png` });
  await page.click('#wiz-next');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/home/claude/scratch/hubshots/${tag}-${label}-wizard2.png` });
  await page.close();
}
await browser.close();
server.close();
console.log('shots written: ' + tag);
