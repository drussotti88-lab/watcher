/**
 * Where the seconds actually go on the buy path.
 *
 * A read now costs about 2.4 seconds, measured. The buy path has never been
 * measured at all: the stopwatch that marks every phase was added AFTER the
 * only real purchases this system has made, so `detail` on all five buy rows
 * in the log is empty. We have been improving a number nobody has seen.
 *
 * This runs the real `attemptBuy` against a real product page, DRY, and prints
 * the breakdown. Same code path as a drop-day purchase up to the line before
 * the button.
 *
 * ── What it will never do ───────────────────────────────────────────────────
 *
 * `live` is hard-coded false here — not read from config, not overridable by a
 * flag. attemptBuy's dry-run branch removes the item and releases the grant
 * before the click, and there is no argument to this script that can reach the
 * other branch. It also never talks to the real Hub: the authorisation is a
 * local stub, so no grant row is created and no spend is recorded against a
 * cap. The only write it performs at Target is adding an item to a cart and
 * taking it back out, which is what the sitting already did.
 *
 * ── Before you run it ───────────────────────────────────────────────────────
 *
 * It opens the BUY profile, which is signed in. Pause Phantom first (npm run
 * stop) so there is only one browser and one lot of activity at Target.
 *
 * Usage:
 *   node --experimental-strip-types scripts/buy-timing.ts <product-url> [ceiling]
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { attemptBuy } from '../src/buy.ts';
import { DEFAULT_SETTINGS, type Hub, type Mission, type Settings } from '../src/hub.ts';
import type { Reading } from '../src/read.ts';

const url = process.argv[2] ?? '';
const ceiling = Number(process.argv[3] ?? '250');

if (!/^https:\/\/www\.target\.com\/p\//.test(url)) {
  console.error(`
  Give me a Target product URL:

    node --experimental-strip-types scripts/buy-timing.ts "https://www.target.com/p/…/-/A-12345678"

  Target only — it is the one retailer with a cart driver. Pick something
  cheap and in stock; it goes in the basket and comes straight back out.
`);
  process.exit(1);
}

/** /p/<slug>/-/A-<tcin> — the tcin is the id every Target reader keys on. */
const tcin = /\/-\/A-(\w+)/i.exec(url)?.[1] ?? '';
if (!tcin) {
  console.error('\n  that URL has no readable Target id in it (expected .../-/A-12345678)\n');
  process.exit(1);
}

const config = loadConfig();
const browser = new Browser(config, 'buy');

/**
 * A Hub that grants and forgets.
 *
 * The real one writes an authorisation row, counts it against the daily cap
 * and expects a resolution. None of that belongs in a measurement — a timing
 * run that eats a day's spend cap is a timing run you stop doing.
 */
const stubHub = {
  settings: { ...DEFAULT_SETTINGS, shippingAllowance: 15 } as Settings,
  async authorise() {
    return {
      granted: true as const,
      id: 0,
      amount: ceiling,
      reason: 'local timing run — no grant was written',
      refusal: 'declined' as const,
    };
  },
  async resolveAuthorisation() {
    return true;
  },
} as unknown as Hub;

const mission: Mission = {
  id: 0,
  listingId: 0,
  productKey: 'timing',
  productName: 'timing run',
  retailer: 'Target',
  externalId: tcin,
  url,
  enabled: true,
  armed: true,
  ceiling,
  quantity: 1,
  sellerPolicy: 'retailer_only',
  preOrderPolicy: 'skip',
  checkEverySeconds: 30,
  state: 'in',
  price: null,
  lastCheckedAt: '',
};

// The reading attemptBuy would have been handed. Only the fields it copies
// onto the run matter here; the cart is what actually decides.
const reading = { state: 'in', price: null, seller: { kind: 'retailer', name: 'Target' } } as Reading;

console.log(`
  Buy-path timing — DRY RUN
  ${url}
  ceiling $${ceiling.toFixed(2)} · live: false, and there is no flag that changes that
`);

try {
  const run = await attemptBuy(
    {
      hub: stubHub,
      openBuyBrowser: async () => ({
        page: () => browser.page(),
        close: () => browser.close(),
      }),
      live: false,
      log: (line) => console.log(line),
    },
    mission,
    reading,
  );
  console.log(`
  outcome  ${run.outcome}
  reason   ${run.reason}
`);
} finally {
  await browser.close();
}
