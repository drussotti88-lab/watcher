/**
 * Scanning a category instead of a product.
 *
 * `readListing` answers "what is true of this one listing". This answers "which
 * listings are worth having a mission at all", which is a different job and a
 * far cheaper one: Target's search endpoint returns the same fulfilment
 * structure the product page does, for every result at once.
 *
 * The mechanism is identical to the product read — open a real page, listen to
 * the calls its own JavaScript makes, parse the response it parsed — so the
 * only new thing here is which reader the captured bodies go to. The
 * interesting half is pure and lives in readers/target-search.ts; this file is
 * the browser around it.
 *
 * Nothing here buys, arms, or changes anything. A scan is a way of looking.
 */
import type { Response } from 'playwright';
import type { Browser } from './browser.ts';
import { detectChallenge } from './challenge.ts';
import { readWhenReady } from './settle.ts';
import { isInterestingApi } from './apisniff.ts';
import {
  readTargetSearch,
  rankScan,
  searchMeta,
  type ScanRow,
  type ScanVerdict,
} from './readers/target-search.ts';
import { classifyTcg, type TcgClassification } from './tcg.ts';
import {
  readWalmartSearch,
  walmartMeta,
  soldByWalmart,
  nextData as walmartNextData,
  type WalmartRow,
} from './readers/walmart-search.ts';
import {
  nextData,
  readPokemonCenterCategory,
  pokemonCenterMeta,
  rankPokemonCenter,
  worthReviewing,
  type PcVerdict,
} from './readers/pokemoncenter-search.ts';

export interface ScanResult {
  url: string;
  verdicts: ScanVerdict[];
  challenged: boolean;
  challengeReason: string;
  /** How many API responses were captured. Zero means the read, not the shop. */
  bodies: number;
  ms: number;
  note: string;
  /** How many results the search says exist, and where this page sat in them. */
  total: number | null;
  offset: number | null;
}

/** Open a Target search page and read every result on it. */
export async function scanTargetSearch(browser: Browser, url: string): Promise<ScanResult> {
  const started = Date.now();
  const page = await browser.page();

  const bodies: unknown[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: Response): void => {
    const type = res.headers()['content-type'] ?? '';
    if (!isInterestingApi(res.url(), type)) return;
    pending.push(
      (async () => {
        const text = await res.text().catch(() => '');
        if (!text || text.length > 8_000_000) return;
        try {
          bodies.push(JSON.parse(text));
        } catch {
          /* not JSON after all */
        }
      })().catch(() => {}),
    );
  };

  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // A search page fills in progressively and the fulfilment call is one of
    // the last things to land. Same reasoning as the product read, longer
    // settle: there are twenty-eight of everything.
    const read = await readWhenReady(page, { minText: 1200, settleForMs: 2500, timeoutMs: 40_000 });
    await Promise.all(pending);

    const challenge = detectChallenge(read.title, read.text);
    if (challenge.challenged) {
      return {
        url,
        verdicts: [],
        challenged: true,
        challengeReason: challenge.reason,
        bodies: bodies.length,
        ms: Date.now() - started,
        note: `challenged: ${challenge.reason}`,
        total: null,
        offset: null,
      };
    }

    const rows = readTargetSearch(bodies);
    const meta = searchMeta(bodies);
    return {
      url,
      verdicts: rankScan(rows),
      challenged: false,
      challengeReason: '',
      bodies: bodies.length,
      ms: Date.now() - started,
      total: meta.total,
      offset: meta.offset,
      note:
        rows.length === 0
          ? `no search results in ${bodies.length} captured responses — the page may have ` +
            `rendered without the fulfilment call, or the response shape has moved`
          : '',
    };
  } catch (err) {
    return {
      url,
      verdicts: [],
      challenged: false,
      challengeReason: '',
      bodies: bodies.length,
      ms: Date.now() - started,
      note: `could not read the page: ${(err as Error).message}`,
      total: null,
      offset: null,
    };
  } finally {
    page.off('response', onResponse);
  }
}

function money(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

/**
 * The scan as something to read at a glance.
 *
 * Deliberately grouped by signal rather than printed as one long table: the
 * whole point is that three or four rows matter and the rest are resellers.
 * A table sorted correctly still makes you read all twenty-eight.
 */
export function renderScan(result: ScanResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${result.url}`);
  lines.push(
    `  ${result.verdicts.length} results · ${result.bodies} responses captured · ${result.ms}ms`,
  );

  if (result.note) {
    lines.push('');
    lines.push(`  ${result.note}`);
    lines.push('');
    return lines.join('\n');
  }

  const groups: { signal: string; heading: string }[] = [
    { signal: 'in-stores', heading: 'STOCK HAS LANDED — online has not opened yet' },
    { signal: 'buyable', heading: 'Buyable from Target right now' },
    { signal: 'due-today', heading: 'On sale today' },
    { signal: 'scheduled', heading: 'Scheduled — Target has published a date' },
    { signal: 'overdue', heading: 'Street date passed, still nothing' },
    { signal: 'quiet', heading: 'Out of stock, no date' },
    { signal: 'resale', heading: 'Marketplace resellers — not Target stock' },
  ];

  for (const group of groups) {
    const rows = result.verdicts.filter((v) => v.signal === group.signal);
    if (rows.length === 0) continue;
    lines.push('');
    lines.push(`  ${group.heading}  (${rows.length})`);
    for (const v of rows) {
      lines.push(`    ${money(v.row.price).padStart(9)}  ${v.row.name.slice(0, 58)}`);
      lines.push(`               ${v.why}`);
      lines.push(`               ${v.row.url || 'tcin ' + v.row.tcin}`);
    }
  }

  lines.push('');
  const worth = result.verdicts.filter(
    (v) => v.signal === 'in-stores' || v.signal === 'due-today' || v.signal === 'scheduled',
  );
  if (worth.length) {
    lines.push(`  ${worth.length} worth pointing a mission at. Add them in the app.`);
  } else {
    lines.push('  Nothing here is close to stocking. Nothing to do.');
  }
  lines.push('');
  return lines.join('\n');
}

// ── Discovery ────────────────────────────────────────────────────────────────


export interface Candidate {
  row: ScanRow;
  tcg: TcgClassification;
  /** The query that turned it up. Blank when a scan was run without one. */
  foundBy: string;
  /** Which shop. The review card's most-missed fact by a distance. */
  retailer: string;
  /** A pre-order is a different decision from a restock, not a variety of one. */
  isPreOrder: boolean;
  /** Why it was surfaced: 'buyable', 'scheduled', 'recent'. May be blank. */
  signal: string;
  /** Other sellers holding an offer on the same listing. Null when unknown. */
  otherOffers: number | null;
}

/**
 * What a scan found that is worth remembering.
 *
 * Two filters, and the second one is a judgement worth stating.
 *
 * The first is the classifier: a search for "elite trainer box" returns action
 * figures, a t-shirt and a binder, and a feed that cries wolf five times in
 * twenty-eight gets ignored — along with the one that mattered.
 *
 * The second is **Target-sold only**. A discovery feed exists to say what the
 * retailer is about to sell. Marketplace listings appear and vanish daily as
 * resellers list and delist, and letting them in would bury a genuine new SKU
 * under a stream of the same boxes at four times MSRP. They are still shown in
 * the scan; they are just not news.
 */
export function candidates(verdicts: ScanVerdict[], foundBy = ''): Candidate[] {
  const out: Candidate[] = [];
  for (const v of verdicts) {
    if (v.row.seller.kind === 'marketplace') continue;
    const tcg = classifyTcg(v.row.name);
    // 'unsure' is included on purpose. Showing you a poster collection costs
    // two seconds; dropping a real drop costs the drop.
    if (tcg.verdict === 'no') continue;
    out.push({
      row: v.row,
      tcg,
      foundBy,
      retailer: 'Target',
      otherOffers: null,
      // Target publishes no pre-order flag; a street date in the future on
      // something buyable is the only tell there is.
      isPreOrder: v.row.state === 'in' && isFuture(v.row.releaseDate),
      signal: v.signal,
    });
  }
  return out;
}

/** Is this date still ahead of us? Blank and malformed both mean no. */
function isFuture(date: string | null, now = Date.now()): boolean {
  if (!date) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && t > now;
}

/** What the Hub needs to be told about one candidate. */
export function toDiscovered(c: Candidate): {
  externalId: string;
  name: string;
  url: string;
  price: number | null;
  kind: string;
  confidence: string;
  foundBy: string;
  imageUrl: string;
  retailer: string;
  state: string;
  isPreOrder: boolean;
  releaseDate: string | null;
  orderLimit: number | null;
  availableQuantity: number | null;
  signal: string;
  otherOffers: number | null;
} {
  return {
    externalId: c.row.tcin,
    name: c.row.name,
    url: c.row.url,
    price: c.row.price,
    imageUrl: c.row.imageUrl,
    // Carried through so the review list can group, explain itself, and show
    // which query is earning its place in the sweep.
    kind: c.tcg.kind,
    confidence: c.tcg.verdict,
    foundBy: c.foundBy,
    // And these so that keeping or forgetting is a decision made on what the
    // sweep actually saw, rather than on a name and a price.
    retailer: c.retailer,
    state: c.row.state,
    isPreOrder: c.isPreOrder,
    releaseDate: c.row.releaseDate,
    orderLimit: c.row.orderLimit,
    // Read all along, and dropped on the floor at the Hub boundary. A count
    // beside a listing the shop is not selling is staged stock, and a find
    // nobody is watching yet is exactly where that is worth knowing.
    availableQuantity: c.row.availableQuantity,
    signal: c.signal,
    otherOffers: c.otherOffers,
  };
}

export interface DiscoverReport {
  scan: ScanResult;
  candidates: Candidate[];
  /** Names the Hub had never seen. Empty on the very first run, by design. */
  fresh: string[];
  received: number;
  seeded: boolean;
  error: string;
}

/** Render what discovery found, which is a different question from what a scan sees. */
export function renderDiscover(report: DiscoverReport): string {
  const lines: string[] = [''];
  const { scan, candidates: found } = report;

  lines.push(`  ${scan.url}`);
  lines.push(
    `  ${scan.verdicts.length} results · ${found.length} sealed Pokémon TCG sold by Target`,
  );

  if (scan.note) {
    lines.push('');
    lines.push(`  ${scan.note}`);
    lines.push('');
    return lines.join('\n');
  }
  if (report.error) {
    lines.push('');
    lines.push(`  the Hub could not be told: ${report.error}`);
    lines.push('  (nothing was lost — run this again once it answers)');
    lines.push('');
    return lines.join('\n');
  }

  if (report.seeded) {
    lines.push('');
    lines.push(`  First run for this source — ${report.received} items recorded as the baseline.`);
    lines.push('  Nothing is "new" against an empty memory, so nothing is announced.');
    lines.push('  From here on, only things that were not here today will be.');
  } else if (report.fresh.length === 0) {
    lines.push('');
    lines.push('  Nothing new since the last run.');
  } else {
    lines.push('');
    lines.push(`  NEW SINCE LAST RUN  (${report.fresh.length})`);
    for (const name of report.fresh) lines.push(`    · ${name}`);
  }

  const unsure = found.filter((c) => c.tcg.verdict === 'unsure');
  if (unsure.length) {
    lines.push('');
    lines.push(`  Not sure about these — your call  (${unsure.length})`);
    for (const c of unsure) {
      lines.push(`    · ${c.row.name.slice(0, 60)}`);
      lines.push(`      ${c.tcg.why}`);
    }
  }

  const flagged = found.filter((c) => c.tcg.language || c.tcg.isBundle);
  if (flagged.length) {
    lines.push('');
    lines.push('  Sealed, but not a US retail drop');
    for (const c of flagged) {
      const why = [c.tcg.language, c.tcg.isBundle ? 'reseller multipack' : ''].filter(Boolean);
      lines.push(`    · ${c.row.name.slice(0, 54)} — ${why.join(', ')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}


// ── Pokémon Center ───────────────────────────────────────────────────────────

export interface PcScanResult {
  url: string;
  verdicts: PcVerdict[];
  challenged: boolean;
  challengeReason: string;
  ms: number;
  note: string;
  total: number | null;
  startIndex: number | null;
}

/**
 * Read a whole Pokémon Center category.
 *
 * No response listening here, unlike Target: the category page ships its entire
 * result set in a __NEXT_DATA__ script tag, so the HTML *is* the API. One
 * navigation, thirty-two products, already parsed.
 */
export async function scanPokemonCenterCategory(
  browser: Browser,
  url: string,
  today: string,
): Promise<PcScanResult> {
  const started = Date.now();
  const page = await browser.page();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const read = await readWhenReady(page, { minText: 600, settleForMs: 1500, timeoutMs: 40_000 });

    const challenge = detectChallenge(read.title, read.text);
    if (challenge.challenged) {
      return {
        url,
        verdicts: [],
        challenged: true,
        challengeReason: challenge.reason,
        ms: Date.now() - started,
        note: `challenged: ${challenge.reason}`,
        total: null,
        startIndex: null,
      };
    }

    // The blob is in the served HTML rather than anything rendered, so this
    // reads content() rather than the settled text.
    const html = await page.content();
    const data = nextData(html);
    const rows = readPokemonCenterCategory(data);
    const meta = pokemonCenterMeta(data);

    return {
      url,
      verdicts: rankPokemonCenter(rows, today),
      challenged: false,
      challengeReason: '',
      ms: Date.now() - started,
      total: meta.total,
      startIndex: meta.startIndex,
      note:
        rows.length === 0
          ? data === null
            ? 'no __NEXT_DATA__ in the page — it may have redirected, or the shape has moved'
            : 'the page had __NEXT_DATA__ but no products in it'
          : '',
    };
  } catch (err) {
    return {
      url,
      verdicts: [],
      challenged: false,
      challengeReason: '',
      ms: Date.now() - started,
      note: `could not read the page: ${(err as Error).message}`,
      total: null,
      startIndex: null,
    };
  }
}

/**
 * What a Pokémon Center scan found that is worth remembering.
 *
 * Two filters, and they are not the same two as Target's. There is no
 * marketplace here — everything on pokemoncenter.com is sold by Pokémon Center,
 * which is the whole reason this source is worth having. What replaces it is
 * the age filter: their catalogue runs back to 2020 and most of it has been out
 * of stock for years, so `worthReviewing` keeps what is buyable, scheduled, or
 * recent enough to plausibly restock.
 *
 * The name classifier still runs, but as a second opinion rather than the
 * gate — their own category crumb has already said whether this is sealed
 * cards, and a retailer's own taxonomy beats our guess at one.
 */
export function pcCandidates(verdicts: PcVerdict[], foundBy = ''): Candidate[] {
  return worthReviewing(verdicts).map((v) => ({
    row: {
      tcin: v.row.code,
      name: v.row.name,
      url: v.row.url,
      price: v.row.price,
      seller: { kind: 'retailer' as const, name: 'Pokemon Center' },
      state: (v.row.outOfStock ? 'out' : 'in') as 'in' | 'out',
      availableQuantity: null,
      orderLimit: null,
      releaseDate: v.row.releaseDate,
      outOfStockInAllStores: null,
      storeQuantity: null,
      preOrderStoreQuantity: null,
      imageUrl: v.row.imageUrl,
    },
    tcg: classifyTcg(v.row.name),
    // The category, not the signal. Writing the signal in here is what made
    // the review card say `found by "recent"`.
    foundBy,
    retailer: 'Pokemon Center',
    otherOffers: null,
    // Pokémon Center says PreOrder in its own markup on the product page; on a
    // category page the tell is the same as Target's — a future street date on
    // something that is not simply out of stock.
    isPreOrder: v.signal === 'scheduled',
    signal: v.signal,
  }));
}


// ── Walmart ──────────────────────────────────────────────────────────────────

export interface WalmartScanResult {
  url: string;
  rows: WalmartRow[];
  challenged: boolean;
  challengeReason: string;
  ms: number;
  note: string;
  total: number | null;
  maxPage: number | null;
}

/** Read one page of Walmart search results. */
export async function scanWalmartSearch(
  browser: Browser,
  url: string,
): Promise<WalmartScanResult> {
  const started = Date.now();
  const page = await browser.page();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const read = await readWhenReady(page, { minText: 600, settleForMs: 2000, timeoutMs: 40_000 });

    const challenge = detectChallenge(read.title, read.text);
    if (challenge.challenged) {
      return {
        url,
        rows: [],
        challenged: true,
        challengeReason: challenge.reason,
        ms: Date.now() - started,
        note: `challenged: ${challenge.reason}`,
        total: null,
        maxPage: null,
      };
    }

    // A dead category answers 200 with a page that says so. The seeded browse
    // URL had been doing exactly that, unnoticed, for as long as it existed —
    // because nothing ever swept Walmart to notice.
    if (/couldn.t be found|page not found/i.test(read.text)) {
      return {
        url,
        rows: [],
        challenged: false,
        challengeReason: '',
        ms: Date.now() - started,
        note: 'Walmart says this page does not exist — the URL has rotted',
        total: null,
        maxPage: null,
      };
    }

    const html = await page.content();
    const data = walmartNextData(html);
    const rows = readWalmartSearch(data);
    const meta = walmartMeta(data);

    return {
      url,
      rows,
      challenged: false,
      challengeReason: '',
      ms: Date.now() - started,
      total: meta.total,
      maxPage: meta.maxPage,
      note:
        rows.length === 0
          ? data === null
            ? 'no __NEXT_DATA__ in the page — it may have redirected, or the shape has moved'
            : 'the page had __NEXT_DATA__ but no products in it'
          : '',
    };
  } catch (err) {
    return {
      url,
      rows: [],
      challenged: false,
      challengeReason: '',
      ms: Date.now() - started,
      note: `could not read the page: ${(err as Error).message}`,
      total: null,
      maxPage: null,
    };
  }
}

/**
 * What a Walmart scan found that is worth remembering.
 *
 * Sold-by-Walmart is checked here rather than trusted from the facet, for the
 * reason given in the reader: the facet is a request, and Target has already
 * demonstrated once what a marketplace listing wearing a first-party badge does
 * to an armed mission.
 *
 * Out of stock is kept, deliberately. Every Walmart-sold Pokémon result was out
 * of stock on the day this was written — that is the normal state of their
 * catalogue and precisely the thing worth watching, because it is what
 * restocks.
 */
export function walmartCandidates(rows: WalmartRow[], foundBy = ''): Candidate[] {
  const out: Candidate[] = [];
  for (const row of rows) {
    // The id, not the name. Measured 2 Sep 2026: an unfaceted Pokémon search
    // returned 49 rows from 27 sellers, one of them Walmart. If the facet is
    // ever dropped, changed or quietly ignored, this is what stops two dozen
    // resellers walking into Discovery.
    if (!soldByWalmart(row.sellerName, row.sellerId)) continue;
    const tcg = classifyTcg(row.name);
    if (tcg.verdict === 'no') continue;
    out.push({
      retailer: 'Walmart',
      otherOffers: row.otherOffers,
      // The one retailer of the three that states it outright.
      isPreOrder: row.isPreOrder,
      signal: row.isPreOrder ? 'scheduled' : row.state === 'in' ? 'buyable' : 'recent',
      row: {
        tcin: row.usItemId,
        name: row.name,
        url: row.url,
        price: row.price,
        seller: { kind: 'retailer' as const, name: row.sellerName },
        state: row.state,
        availableQuantity: null,
        orderLimit: null,
        releaseDate: row.releaseDate,
        outOfStockInAllStores: null,
        storeQuantity: null,
        preOrderStoreQuantity: null,
        imageUrl: row.imageUrl,
      },
      tcg,
      foundBy,
    });
  }
  return out;
}
