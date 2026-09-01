/**
 * Look at one product page and report everything usable on it.
 *
 * This exists so the per-retailer readers get written from what a page actually
 * contains, rather than from CSS selectors I guessed at. Selectors invented
 * without looking are the single most common reason a scraper works on the day
 * it ships and silently breaks a fortnight later.
 *
 * Order of preference for reading stock and price, best first:
 *   1. JSON-LD  — schema.org Product markup. Retailers publish it for Google,
 *      it is structured, and it changes far less often than their CSS.
 *   2. Meta tags — og:/product: price fields. Also stable.
 *   3. Embedded state — __NEXT_DATA__ and friends.
 *   4. Visible text — last resort, and the most fragile.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { Browser } from './browser.ts';
import { detectChallenge } from './challenge.ts';
import { readWhenReady } from './settle.ts';
import {
  isInterestingApi,
  fieldPaths,
  scoreCall,
  callSlug,
  extractProductKey,
  type CapturedCall,
} from './apisniff.ts';

const ARTIFACT_DIR = 'probe-artifacts';

/**
 * Take the personal details out of a recorded request.
 *
 * These artifacts get read, pasted into chat and diffed. Target's calls carry a
 * visitor id, a home store, a postcode and a lat/long good to three decimal
 * places, and `page_context` is a base64 blob of all of it. None of that is
 * needed to understand the shape of a response, so none of it gets written
 * down. The response *bodies* are kept whole — that is the evidence — but the
 * index everyone actually reads is clean.
 */
export function redact(text: string): string {
  return text
    .replace(/("page_context"\s*:\s*")[^"]{40,}(")/g, '$1<redacted>$2')
    .replace(/([?&](?:visitor_id|zip|postal_code|scheduled_delivery_zip_code)=)[^&\s"]+/gi, '$1<redacted>')
    .replace(/([?&](?:latitude|longitude)=)-?[\d.]+/gi, '$1<redacted>')
    .replace(/(\bvisitor_id"\s*:\s*")[^"]+/gi, '$1<redacted>');
}

export interface LdOffer {
  price: number | null;
  currency: string;
  availability: string;
  sku: string;
  name: string;
}

export interface Inspection {
  url: string;
  title: string;
  challenged: boolean;
  challengeReason: string;
  textLength: number;
  /** schema.org Product offers found in JSON-LD. The good stuff. */
  ld: LdOffer[];
  /** Price-ish meta tags, name → content. */
  meta: Record<string, string>;
  /** Which embedded state blobs exist, and how big. */
  stateBlobs: { key: string; bytes: number }[];
  /** Buttons whose text suggests buying or unavailability. */
  buttons: string[];
  /** Every distinct $-amount in the visible text, first few. */
  visiblePrices: string[];
  /** The product's own id, taken from its URL. The anchor for ranking calls. */
  productKey: string | null;
  /** JSON calls the page's own script made, best-scoring first. */
  calls: CapturedCall[];
  /** Did the page stop changing before we read it, or did we run out of time? */
  settled: boolean;
  waitedMs: number;
  artifactPath: string;
}

function normaliseAvailability(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return '';
  if (s.includes('instock') || s.includes('in_stock')) return 'InStock';
  if (s.includes('outofstock') || s.includes('out_of_stock')) return 'OutOfStock';
  if (s.includes('preorder')) return 'PreOrder';
  if (s.includes('backorder')) return 'BackOrder';
  if (s.includes('limited')) return 'LimitedAvailability';
  return String(raw);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Pull schema.org Product offers out of parsed JSON-LD. Pure, so it's testable. */
export function offersFromLd(blocks: unknown[]): LdOffer[] {
  const out: LdOffer[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    // @graph wrappers are common and hide the Product one level down.
    if (Array.isArray(obj['@graph'])) obj['@graph'].forEach(visit);

    const type = String(obj['@type'] ?? '').toLowerCase();
    if (type.includes('product')) {
      const name = String(obj.name ?? '');
      const sku = String(obj.sku ?? obj.productID ?? obj.mpn ?? '');
      const offers = Array.isArray(obj.offers) ? obj.offers : obj.offers ? [obj.offers] : [];
      if (offers.length === 0) {
        out.push({ price: null, currency: '', availability: '', sku, name });
      }
      for (const raw of offers) {
        if (raw === null || typeof raw !== 'object') continue;
        const o = raw as Record<string, unknown>;
        out.push({
          price: toNumber(o.price ?? o.lowPrice ?? (o.priceSpecification as never)?.['price']),
          currency: String(o.priceCurrency ?? 'USD'),
          availability: normaliseAvailability(o.availability),
          sku: sku || String(o.sku ?? ''),
          name,
        });
      }
    }

    // Offers can also sit at the top level without a Product wrapper.
    if (type.includes('offer') && !type.includes('aggregate')) {
      out.push({
        price: toNumber(obj.price),
        currency: String(obj.priceCurrency ?? 'USD'),
        availability: normaliseAvailability(obj.availability),
        sku: String(obj.sku ?? ''),
        name: String(obj.name ?? ''),
      });
    }
  };

  blocks.forEach(visit);
  return out;
}

async function scrape(page: Page): Promise<{
  ldRaw: unknown[];
  meta: Record<string, string>;
  stateBlobs: { key: string; bytes: number }[];
  buttons: string[];
}> {
  return page.evaluate(() => {
    const ldRaw: unknown[] = [];
    for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        ldRaw.push(JSON.parse(el.textContent ?? ''));
      } catch {
        /* a malformed block shouldn't lose the good ones */
      }
    }

    const meta: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll('meta'))) {
      const key = el.getAttribute('property') ?? el.getAttribute('name') ?? '';
      const val = el.getAttribute('content') ?? '';
      if (!key || !val) continue;
      if (/price|availability|currency|product|og:title/i.test(key)) meta[key] = val.slice(0, 120);
    }

    const stateBlobs: { key: string; bytes: number }[] = [];
    for (const key of ['__NEXT_DATA__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__NUXT__']) {
      const el = document.getElementById(key);
      if (el?.textContent) stateBlobs.push({ key, bytes: el.textContent.length });
      const w = (window as unknown as Record<string, unknown>)[key];
      if (w) stateBlobs.push({ key: `window.${key}`, bytes: JSON.stringify(w).length });
    }

    const buttons: string[] = [];
    const nodes = document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn');
    for (const el of Array.from(nodes).slice(0, 400)) {
      const t = (el.textContent ?? (el as HTMLInputElement).value ?? '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 60) continue;
      if (/add to cart|add to bag|buy now|pre-?order|sold out|out of stock|notify me|unavailable|ship it|pickup/i.test(t)) {
        if (!buttons.includes(t)) buttons.push(t);
      }
    }
    return { ldRaw, meta, stateBlobs, buttons };
  });
}

export async function inspectUrl(browser: Browser, url: string): Promise<Inspection> {
  const page = await browser.page();
  const productKey = extractProductKey(url);

  // Attach before navigating, or we miss the calls that matter most — the ones
  // fired during hydration, which is exactly when the price arrives.
  const calls: CapturedCall[] = [];
  const bodies = new Map<number, string>(); // keyed by capture id, never by URL
  const pending: Promise<void>[] = [];
  let nextId = 0;

  const onResponse = (res: import('playwright').Response): void => {
    const resUrl = res.url();
    const type = res.headers()['content-type'] ?? '';
    if (!isInterestingApi(resUrl, type)) return;

    // Claim the id synchronously so numbering follows the order calls were
    // actually made, not the order their bodies happened to arrive.
    const id = nextId;
    nextId += 1;

    pending.push(
      (async () => {
        const text = await res.text().catch(() => '');
        if (!text || text.length > 4_000_000) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        const paths = fieldPaths(parsed, { productKey });
        calls.push({
          id,
          method: res.request().method(),
          url: resUrl,
          status: res.status(),
          bytes: text.length,
          // Four POSTs to one URL differ only in what was asked for. Without
          // this they are indistinguishable in the record.
          postData: (res.request().postData() ?? '').slice(0, 4000),
          score: scoreCall({ paths, bodyText: text, productKey }),
          mentionsProduct: Boolean(productKey && text.includes(productKey)),
          paths,
          savedAs: callSlug(resUrl, id),
        });
        bodies.set(id, text);
      })().catch(() => {}),
    );
  };

  page.on('response', onResponse);

  let read;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Settle rather than stop at a character count: the price is one of the
    // last things to land, so "enough text" is not the same as "finished".
    read = await readWhenReady(page, { minText: 800, settleForMs: 2000, timeoutMs: 30_000 });
    await Promise.all(pending);
  } finally {
    page.off('response', onResponse);
  }

  calls.sort((a, b) => b.score - a.score || b.bytes - a.bytes);
  const { challenged, reason } = detectChallenge(read.title, read.text, read.html);
  const { ldRaw, meta, stateBlobs, buttons } = await scrape(page);

  const visiblePrices = Array.from(
    new Set((read.text.match(/\$\s?\d[\d,]*\.\d{2}/g) ?? []).map((s) => s.replace(/\s/g, ''))),
  ).slice(0, 8);

  const dir = resolve(process.cwd(), ARTIFACT_DIR);
  mkdirSync(dir, { recursive: true });
  const slug = url.replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
  writeFileSync(resolve(dir, `${slug}.html`), read.html, 'utf8');
  writeFileSync(resolve(dir, `${slug}.txt`), read.text, 'utf8');
  if (ldRaw.length) {
    writeFileSync(resolve(dir, `${slug}.ld.json`), JSON.stringify(ldRaw, null, 2), 'utf8');
  }

  // Save every body, not just the ones that scored.
  //
  // The first version kept only scoring responses, and threw away the two most
  // interesting things it had caught: Target's sapphire page definition, and a
  // Pokémon Center endpoint literally called `product/status`. A scorer that
  // decides what is worth keeping will eventually discard the answer, so the
  // scorer now decides what to *show* and the disk keeps everything.
  const apiDir = resolve(dir, `${slug}.api`);
  if (calls.length) {
    mkdirSync(apiDir, { recursive: true });
    writeFileSync(
      resolve(apiDir, '_index.json'),
      JSON.stringify(
        calls.map((c) => ({
          id: c.id,
          method: c.method,
          status: c.status,
          bytes: c.bytes,
          score: c.score,
          mentionsProduct: c.mentionsProduct,
          savedAs: `${c.savedAs}.json`,
          url: redact(c.url),
          postData: redact(c.postData),
        })),
        null,
        2,
      ),
      'utf8',
    );
    for (const c of calls) {
      const body = bodies.get(c.id);
      if (body) writeFileSync(resolve(apiDir, `${c.savedAs}.json`), body, 'utf8');
    }
  }

  await page.screenshot({ path: resolve(dir, `${slug}.png`) }).catch(() => {});

  return {
    url,
    title: read.title,
    challenged,
    challengeReason: reason,
    textLength: read.textLength,
    ld: offersFromLd(ldRaw),
    meta,
    stateBlobs,
    buttons,
    visiblePrices,
    productKey,
    calls,
    settled: read.settled,
    waitedMs: read.waitedMs,
    artifactPath: `${ARTIFACT_DIR}/${slug}.*`,
  };
}

export function renderInspection(i: Inspection): string {
  const L: string[] = ['', `  ${i.url}`, '  ' + '─'.repeat(72)];
  L.push(`  title        ${i.title || '(none)'}`);
  L.push(
    `  rendered     ${i.textLength.toLocaleString()} chars ` +
      `(${i.settled ? 'settled' : 'STILL CHANGING'} after ${(i.waitedMs / 1000).toFixed(1)}s)`,
  );
  if (i.challenged) L.push(`  CHALLENGED   ${i.challengeReason}`);

  L.push('');
  if (i.ld.length) {
    L.push('  JSON-LD  ← best case: structured, and it outlives CSS changes');
    for (const o of i.ld.slice(0, 4)) {
      const price = o.price === null ? '—' : `$${o.price.toFixed(2)}`;
      L.push(`    ${price.padEnd(10)} ${(o.availability || '—').padEnd(20)} ${o.name.slice(0, 40)}`);
      if (o.sku) L.push(`    ${''.padEnd(10)} sku ${o.sku}`);
    }
  } else {
    L.push('  JSON-LD      none found');
  }

  L.push('');
  const metaKeys = Object.keys(i.meta);
  if (metaKeys.length) {
    L.push('  meta tags');
    for (const k of metaKeys.slice(0, 6)) L.push(`    ${k.padEnd(28)} ${i.meta[k]}`);
  } else {
    L.push('  meta tags    none price-related');
  }

  L.push('');
  L.push(`  state blobs  ${i.stateBlobs.map((s) => `${s.key} (${Math.round(s.bytes / 1024)}KB)`).join(', ') || 'none'}`);
  L.push(`  buy buttons  ${i.buttons.join(' · ') || 'none matched'}`);
  L.push(`  $ in text    ${i.visiblePrices.join('  ') || 'none'}`);

  L.push('');
  L.push(`  product id   ${i.productKey ?? '(could not read one from the URL)'}`);

  const scoring = i.calls.filter((c) => c.score > 0);
  if (scoring.length) {
    const hits = i.calls.filter((c) => c.paths.some((p) => p.onTarget)).length;
    L.push('');
    L.push(`  the page's own API calls  ← where the price really comes from`);
    L.push(
      `  (${i.calls.length} JSON calls seen · ${scoring.length} carry price or stock · ` +
        `${hits} carry it for THIS product)`,
    );
    for (const c of scoring.slice(0, 3)) {
      const short = c.url.replace(/^https?:\/\//, '').split('?')[0];
      const onTarget = c.paths.filter((p) => p.onTarget);
      const other = c.paths.filter((p) => !p.onTarget);
      L.push('');
      L.push(`    [${c.score}] ${c.status} ${c.method} ${short}`);
      L.push(`         saved as ${c.savedAs}.json`);
      if (onTarget.length) {
        L.push(`         ── this product ──`);
        for (const p of onTarget.slice(0, 10)) L.push(`         ${p.path.padEnd(50)} = ${p.value}`);
        if (onTarget.length > 10) L.push(`         … ${onTarget.length - 10} more`);
      }
      if (other.length) {
        L.push(`         ── other items on the page (${other.length}) ──`);
        for (const p of other.slice(0, 3)) L.push(`         ${p.path.padEnd(50)} = ${p.value}`);
      }
    }
  } else if (i.calls.length) {
    L.push(`  API calls    ${i.calls.length} JSON calls seen, none carrying price/stock`);
    L.push(`               (bodies still saved — the answer may be in one of them)`);
  } else {
    L.push('  API calls    none — this page serves its data in the HTML');
  }

  L.push('');
  L.push(`  saved        ${i.artifactPath}`);
  if (i.calls.length) L.push(`               + full response bodies in the .api/ folder beside it`);
  L.push('');
  return L.join('\n');
}
