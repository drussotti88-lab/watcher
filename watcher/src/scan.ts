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
    out.push({ row: v.row, tcg, foundBy });
  }
  return out;
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
