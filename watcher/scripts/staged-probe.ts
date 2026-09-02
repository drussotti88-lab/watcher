/**
 * Is there a big number hiding before a drop, and which field is it in?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Phantom has a whole surface for staged stock: units counted in the warehouse
 * against a listing the site still refuses to sell. It opens a drop window, it
 * speeds up checking, it paints a STOCK STAGED banner on the card, it fires a
 * STOCK LOADED alarm at 100 units.
 *
 * It has never fired. Not once. Across 3,671 readings that carried a count,
 * 549 were non-zero, and every single one of those was already sellable:
 *
 *     atp 10 with state "in"   (373 times, limit 10)
 *     atp 99 with state "in"   (176 times, limit 99 — the 99c pens)
 *
 * Zero readings of "counted but not sellable". So either Target zeroes the
 * shipping count until the moment a drop opens and the 30,000 a competitor
 * showed at 11:34pm comes from a field we have never looked at, or it does not
 * exist on target.com at all and that number came from somewhere else.
 *
 * The reader parses two counts. The response carries a whole fulfillment tree.
 * This script stops guessing which field matters and writes down ALL of them.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Opens the product page in a throwaway profile, captures the orchestration
 * responses the page makes for itself, finds the node for this tcin, and dumps
 * every numeric leaf under `fulfillment` with its full path — plus the raw
 * subtree, verbatim, so a field we do not think to look at today is still on
 * disk tomorrow. Then it waits and does it again.
 *
 * Anything above 20 is called out on sight, because 20 is the ceiling every
 * sellable reading has ever obeyed. That is the shape of the answer we want.
 *
 * It reads. It does not click, type, sign in, or add anything to a basket.
 *
 * Usage:
 *   node --experimental-strip-types scripts/staged-probe.ts <url> [rounds] [seconds]
 *
 *   rounds   how many times to look   (default 12)
 *   seconds  how long to wait between (default 300 — five minutes)
 *
 * Point it at something with a street date in the future and leave it running
 * into the evening before the drop. Output lands in logs/staged/<tcin>.ndjson,
 * one JSON line per look, which is the shape you want when the question later
 * turns out to be "when did it change".
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Response } from 'playwright';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { productNodes } from '../src/readers/target.ts';

const url = process.argv[2] ?? '';
const rounds = Number(process.argv[3] ?? 12);
const gapSec = Number(process.argv[4] ?? 300);
const tcin = /\/-\/A-(\w+)/i.exec(url)?.[1] ?? '';

if (!tcin) {
  console.error('\n  Give me a Target product URL: .../-/A-12345678\n');
  process.exit(1);
}

/** The ceiling every sellable reading has obeyed. Above it is the news. */
const CEILING = 20;

const OUT_DIR = resolve('logs/staged');
mkdirSync(OUT_DIR, { recursive: true });
const outFile = resolve(OUT_DIR, `${tcin}.ndjson`);

/** Every numeric leaf under a subtree, by path. The point of the whole script. */
function numbers(node: unknown, path: string, into: Record<string, number>): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'number') {
    if (Number.isFinite(node)) into[path] = node;
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => numbers(v, `${path}[${i}]`, into));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    numbers(v, path ? `${path}.${k}` : k, into);
  }
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-staged';
const browser = new Browser(config, 'watch');

async function look(round: number): Promise<void> {
  const page = await browser.page();
  const bodies: unknown[] = [];
  const pending: Promise<void>[] = [];

  const onResponse = (res: Response): void => {
    if (!/redsky|api\.target\.com/i.test(res.url())) return;
    pending.push(
      res
        .text()
        .then((t) => {
          if (!t || t.length > 4_000_000) return;
          try {
            bodies.push(JSON.parse(t));
          } catch {
            /* not JSON */
          }
        })
        .catch(() => {}),
    );
  };

  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Deliberately unhurried. The live reader races to be fast; this one is
    // trying not to miss a late response, and nobody is waiting on it.
    await page.waitForTimeout(6000);
    await Promise.all(pending).catch(() => {});
  } finally {
    page.off('response', onResponse);
  }

  const at = new Date().toISOString();
  const nodes = bodies.flatMap((b) => productNodes(b, tcin));
  if (nodes.length === 0) {
    console.log(`  ${at}  round ${round}: no product node in ${bodies.length} responses`);
    appendFileSync(outFile, JSON.stringify({ at, round, nodes: 0, bodies: bodies.length }) + '\n');
    return;
  }

  const found: Record<string, number> = {};
  const trees: unknown[] = [];
  for (const node of nodes) {
    numbers((node as Record<string, unknown>).fulfillment, 'fulfillment', found);
    const item = (node as Record<string, unknown>).item;
    if (item && typeof item === 'object') {
      numbers((item as Record<string, unknown>).fulfillment, 'item.fulfillment', found);
    }
    trees.push({
      fulfillment: (node as Record<string, unknown>).fulfillment ?? null,
      item_fulfillment:
        item && typeof item === 'object' ? ((item as Record<string, unknown>).fulfillment ?? null) : null,
      mmbv:
        item && typeof item === 'object' ? ((item as Record<string, unknown>).mmbv_content ?? null) : null,
    });
  }

  // The raw subtree goes to disk whole. Today we care about counts; the day
  // this matters the question will be about some field nobody listed here.
  appendFileSync(
    outFile,
    JSON.stringify({ at, round, tcin, nodes: nodes.length, numbers: found, trees }) + '\n',
  );

  const interesting = Object.entries(found).filter(([, v]) => v > CEILING);
  const counts = Object.entries(found).filter(([k]) => /quantity|available|limit/i.test(k));
  console.log(`  ${at}  round ${round}: ${Object.keys(found).length} numeric fields`);
  for (const [k, v] of counts) console.log(`      ${k} = ${v}`);
  if (interesting.length > 0) {
    console.log(`      ABOVE THE CEILING — this is the thing we came for:`);
    for (const [k, v] of interesting) console.log(`      >>> ${k} = ${v}`);
  }
}

console.log(`\n  Watching tcin ${tcin} — ${rounds} looks, ${gapSec}s apart`);
console.log(`  Writing every field to ${outFile}\n`);

try {
  for (let i = 1; i <= rounds; i++) {
    try {
      await look(i);
    } catch (err) {
      console.log(`  round ${i} failed: ${(err as Error).message}`);
    }
    if (i < rounds) await new Promise((r) => setTimeout(r, gapSec * 1000));
  }
} finally {
  await browser.close().catch(() => {});
  // The profile is deliberately kept: a run that spans an evening should not
  // arrive at each look looking like a brand new visitor.
  console.log(`\n  Done. ${outFile}\n`);
}
