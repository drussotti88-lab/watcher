/**
 * The sitting, run remotely.
 *
 * Every selector in checkout/target.ts is a guess until a person watches it
 * find the right element on the real page. This script does the watching's
 * mechanical half: it walks the flow, highlights what each selector found,
 * photographs it, and reports which candidate matched. The person — on a
 * phone, looking at the screenshots — still makes the call; nothing here
 * flips `verified: true`.
 *
 * ── What this script will never do ──────────────────────────────────────────
 *
 * It never clicks Place Order. There is no code path that does. The deepest it
 * goes is the checkout review page, where it LOCATES the place-order button,
 * draws a box around it, photographs it, and leaves. It never types into any
 * field, never signs in, never touches payment or address forms. Adding an
 * item to a cart and removing it again is the only write it performs.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sitting.ts out          — signed-out
 *       phase in a throwaway profile (never the watch profile, which the
 *       running Phantom owns). Picks a cheap in-stock sold-by-Target item
 *       itself, or takes a product URL as the next argument.
 *   node --experimental-strip-types scripts/sitting.ts buy <url>    — signed-in
 *       phase in the buy profile. Only run when Phantom is paused, and
 *       only after the signed-out screenshots were approved.
 *
 * Output: screenshots in logs/sitting/, one JSON report on stdout.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { TARGET_SELECTORS, type TargetStep } from '../src/checkout/target.ts';
import { scanTargetSearch } from '../src/scan.ts';
import { searchUrl } from '../src/readers/target-search.ts';

const SHOT_DIR = resolve('logs/sitting');

interface Probe {
  step: TargetStep;
  matched: string | null;
  /** What the matched element says, so a wrong match is obvious in the report. */
  text: string;
  enabled: boolean | null;
}

/**
 * Try each candidate the way checkout/target.ts will, but instead of acting,
 * paint what was found and say which selector found it.
 */
async function probe(page: Page, step: TargetStep, timeoutMs = 5000): Promise<Probe> {
  for (const selector of TARGET_SELECTORS[step].candidates) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      const text =
        (await locator.inputValue().catch(() => '')) ||
        (await locator.innerText().catch(() => '')) ||
        '';
      const enabled = await locator.isEnabled().catch(() => null);
      await locator
        .evaluate((el: HTMLElement) => {
          el.style.outline = '5px solid #ff0040';
          el.style.outlineOffset = '2px';
        })
        .catch(() => {});
      return { step, matched: selector, text: text.trim().slice(0, 160), enabled };
    } catch {
      /* next candidate */
    }
  }
  return { step, matched: null, text: '', enabled: null };
}

/** Open the collapsed order summary the way readCart does, so the probes see
 * what the reader will see. */
async function openSummary(page: Page): Promise<void> {
  const toggle = page.locator(TARGET_SELECTORS.summaryToggle.candidates[0]!).first();
  if ((await toggle.getAttribute('aria-expanded').catch(() => null)) === 'false') {
    await toggle.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
}

let shotNo = 0;
async function shot(page: Page, name: string): Promise<string> {
  shotNo += 1;
  const file = resolve(SHOT_DIR, `${String(shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** Scroll a probed element into the middle of the viewport before the photo. */
async function focusOn(page: Page, step: TargetStep): Promise<void> {
  const { candidates } = TARGET_SELECTORS[step];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      return;
    }
  }
}

/** A cheap, in-stock, sold-by-Target item to run the flow against. */
async function pickItem(browser: Browser): Promise<{ url: string; name: string; price: number }> {
  const result = await scanTargetSearch(browser, searchUrl('pokemon trading cards'));
  if (result.challenged) throw new Error(`search challenged: ${result.challengeReason}`);
  const buyable = result.verdicts
    .map((v) => v.row)
    .filter(
      (r) => r.state === 'in' && r.seller.kind === 'retailer' && r.price !== null && r.url,
    )
    .sort((a, b) => a.price! - b.price!);
  const pick = buyable[0];
  if (!pick) throw new Error('nothing in stock and sold by Target in the search — try later');
  return { url: pick.url, name: pick.name, price: pick.price! };
}

async function outPhase(productUrl: string | undefined): Promise<void> {
  // A throwaway profile: the watch profile belongs to the running Phantom and
  // this must not fight it for the lock, and the buy profile has no business
  // in a signed-out rehearsal.
  const config = loadConfig();
  config.browser.watchProfileDir = './chrome-profile-sitting';
  const browser = new Browser(config, 'watch');
  const report: Record<string, unknown> = { phase: 'out' };
  const probes: Probe[] = [];
  try {
    let item: { url: string; name: string; price: number };
    if (productUrl) item = { url: productUrl, name: '(given)', price: 0 };
    else item = await pickItem(browser);
    report.item = item;

    const page = await browser.page();
    await page.goto(item.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // 1 — the add-to-cart button, on the product page.
    probes.push(await probe(page, 'addToCart'));
    await focusOn(page, 'addToCart');
    await shot(page, 'product-addToCart');

    const add = probes[0]!;
    if (!add.matched) throw new Error('no add-to-cart candidate matched; stopping here');
    await page.locator(add.matched).first().click();
    await page.waitForTimeout(3000);
    await shot(page, 'after-add');

    // 2 — the cart page: quantity, subtotal, the remove control, and a look
    // at whether checkout/tax/shipping exist here (informational while signed
    // out — the signed-in cart is the one that counts for those).
    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await openSummary(page);
    for (const step of ['cartItemQuantity', 'subtotal', 'tax', 'shipping', 'checkoutButton', 'removeItem'] as TargetStep[]) {
      probes.push(await probe(page, step, 4000));
    }
    await shot(page, 'cart');

    // 3 — take it back out. A rehearsal must not leave a basket behind.
    const remove = probes.find((p) => p.step === 'removeItem');
    if (remove?.matched) {
      await page.locator(remove.matched).first().click();
      await page.waitForTimeout(3000);
      await shot(page, 'cart-after-remove');
    }
  } finally {
    report.probes = probes;
    await browser.close().catch(() => {});
    // The throwaway profile has served; leaving it would be one more place
    // Target state accumulates on disk.
    rmSync('./chrome-profile-sitting', { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}

async function buyPhase(productUrl: string): Promise<void> {
  const config = loadConfig();
  const browser = new Browser(config, 'buy');
  const report: Record<string, unknown> = { phase: 'buy', item: productUrl };
  const probes: Probe[] = [];
  try {
    const page = await browser.page();
    await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    probes.push(await probe(page, 'addToCart'));
    await focusOn(page, 'addToCart');
    await shot(page, 'product-addToCart');
    const add = probes[0]!;
    if (!add.matched) throw new Error('no add-to-cart candidate matched; stopping here');
    await page.locator(add.matched).first().click();
    await page.waitForTimeout(3000);

    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await openSummary(page);
    for (const step of ['cartItemQuantity', 'subtotal', 'tax', 'shipping', 'checkoutButton'] as TargetStep[]) {
      probes.push(await probe(page, step, 4000));
    }
    await shot(page, 'cart-signed-in');

    // Into checkout — clicking "check out" only navigates; nothing is bought
    // by reaching the review page.
    const co = probes.find((p) => p.step === 'checkoutButton');
    if (!co?.matched) throw new Error('no checkout button matched; stopping at the cart');
    await page.locator(co.matched).first().click();
    await page.waitForTimeout(6000);
    await shot(page, 'checkout-page');

    // The one that matters. LOCATED, PHOTOGRAPHED, NEVER CLICKED. There is no
    // click on this element anywhere in this file, on purpose.
    probes.push(await probe(page, 'placeOrder', 8000));
    await focusOn(page, 'placeOrder');
    await shot(page, 'checkout-placeOrder');

    // Back out and empty the basket.
    await page.goto('https://www.target.com/cart', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    probes.push(await probe(page, 'removeItem', 5000));
    const remove = probes.find((p) => p.step === 'removeItem');
    if (remove?.matched) {
      await page.locator(remove.matched).first().click();
      await page.waitForTimeout(3000);
    }
    await shot(page, 'cart-after-remove');
  } finally {
    report.probes = probes;
    await browser.close().catch(() => {});
  }
  console.log(JSON.stringify(report, null, 2));
}

const [, , phase, url] = process.argv;
mkdirSync(SHOT_DIR, { recursive: true });
if (phase === 'out') {
  await outPhase(url);
} else if (phase === 'buy') {
  if (!url) throw new Error('the buy phase needs the product URL the out phase used');
  await buyPhase(url);
} else {
  console.log('usage: sitting.ts out [productUrl] | sitting.ts buy <productUrl>');
  process.exit(1);
}
