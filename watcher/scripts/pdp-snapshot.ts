/**
 * The whole page, written down — so a field we do not know about can be found
 * by subtraction rather than by guesswork.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Competing trackers publish national pre-drop unit counts ("Available Stock:
 * 30k+") for Target listings we watch, and every reading we have ever taken of
 * a *sellable* item is capped at a small ceiling. The obvious question is
 * whether Target says something different while an item is loaded but not yet
 * launched — and the honest answer is that we do not know, because our reader
 * parses two of the thirty-six modules the page fetches and fifteen of the two
 * hundred and fifty-five fields on our own product node.
 *
 * Guessing which field to add is how you spend a week and learn nothing. This
 * takes the whole response instead, twice, and diffs it. A field that only
 * exists in the pre-drop state is then NAMED BY THE DIFF, in the response we
 * already fetch on every check.
 *
 * ── The bug this script was born from ───────────────────────────────────────
 *
 * staged-probe.ts reported "no product node in 36 responses" and I read that as
 * Target blocking us. It was not. Its capture filter was `/redsky|api.target/`,
 * and Target's PDP has not served product data from redsky for some time — it
 * comes from
 *
 *     www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules
 *
 * which that regex does not match. The 403s in the log were the recommendations
 * carousel and the store locator: noise. So this script uses the SAME filter
 * the live reader uses (`isInterestingApi`), because a probe that captures a
 * different set from the reader is measuring a different program.
 *
 * Read only. One navigation, after a homepage warm-up.
 *
 *   node --experimental-strip-types scripts/pdp-snapshot.ts <tcin>
 *   node --experimental-strip-types scripts/pdp-snapshot.ts diff <fileA> <fileB>
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Response } from 'playwright';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { isInterestingApi } from '../src/apisniff.ts';

const OUT_DIR = resolve('logs/snapshots');

/** Every leaf in a body, by path, with the values seen at it. */
function leaves(node: unknown, path: string, into: Map<string, Set<string>>): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((v) => leaves(v, `${path}[]`, into));
    return;
  }
  if (typeof node !== 'object') {
    if (!path) return;
    const set = into.get(path) ?? new Set<string>();
    // Capped: one field can hold a 40KB description and we want the shape.
    if (set.size < 6) set.add(String(node).slice(0, 60));
    into.set(path, set);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    leaves(v, path ? `${path}.${k}` : k, into);
  }
}

/** Just the module names the orchestration returned. */
function modules(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v) => modules(v, into));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.module_type === 'string') into.add(obj.module_type);
  for (const v of Object.values(obj)) modules(v, into);
}

/** Pull every readable sentence out of a Target TextQuill blob. */
function quillText(node: unknown, into: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v) => quillText(v, into));
    return;
  }
  const obj = node as Record<string, unknown>;
  const ins = obj.insert as Record<string, unknown> | undefined;
  if (ins && typeof ins.text === 'string' && ins.text.trim()) into.push(ins.text.trim());
  for (const v of Object.values(obj)) quillText(v, into);
}

async function snapshot(tcin: string): Promise<void> {
  const url = `https://www.target.com/p/-/A-${tcin}`;
  const config = loadConfig();
  // Not the watch profile: the running Phantom owns it. This one keeps its
  // history between runs on purpose — a profile with no past is the thing
  // Akamai is looking for.
  config.browser.watchProfileDir = './chrome-profile-snapshot';
  const browser = new Browser(config, 'watch');

  const calls: { url: string; status: number; body: unknown }[] = [];
  const page = await browser.page();
  const pending: Promise<void>[] = [];

  const onResponse = (res: Response): void => {
    const type = res.headers()['content-type'] ?? '';
    if (!isInterestingApi(res.url(), type)) return;
    pending.push(
      res
        .text()
        .then((t) => {
          if (!t || t.length > 8_000_000) return;
          try {
            calls.push({ url: res.url(), status: res.status(), body: JSON.parse(t) });
          } catch {
            /* not JSON after all */
          }
        })
        .catch(() => {}),
    );
  };

  console.log('  warming on the homepage first...');
  await page.goto('https://www.target.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);

  page.on('response', onResponse);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // ── Why this scrolls ──────────────────────────────────────────────────────
  //
  // The first baseline caught 9 modules where a full probe of the same page
  // once caught 36. The name of the endpoint says why: DEFERRED enrichment.
  // Target sends the page in batches and holds most of them until the reader
  // looks further down, so a script that loads and waits sees a quarter of the
  // page and a diff built on it would report a dozen fields as "new" that were
  // always there.
  //
  // This is not a trick to see hidden data. It is doing what a person does.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(1800);
  }
  await page.waitForTimeout(6000);
  await Promise.all(pending).catch(() => {});
  page.off('response', onResponse);

  const mods = new Set<string>();
  const paths = new Map<string, Set<string>>();
  for (const c of calls) {
    modules(c.body, mods);
    leaves(c.body, '', paths);
  }

  const at = new Date().toISOString();
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, `${tcin}-${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        tcin,
        at,
        url,
        landed: page.url(),
        title: await page.title().catch(() => ''),
        calls: calls.map((c) => ({ url: c.url, status: c.status })),
        modules: [...mods].sort(),
        paths: Object.fromEntries([...paths].map(([k, v]) => [k, [...v]])),
        bodies: calls,
      },
      null,
      1,
    ),
  );

  console.log(`\n  ${tcin}  ${at}`);
  console.log(`  title       ${await page.title().catch(() => '')}`);
  console.log(`  captured    ${calls.length} JSON responses`);
  console.log(`  modules     ${mods.size}`);
  console.log(`  field paths ${paths.size}`);

  // What the page SAYS about availability, in its own words. This is the module
  // the reader has never opened, and on a pre-launch page it is the one most
  // likely to say something a status enum cannot.
  for (const c of calls) {
    const found: unknown[] = [];
    const hunt = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(hunt);
      const o = n as Record<string, unknown>;
      if (o.module_type === 'ProductDetailAvailabilitySneakPeek') found.push(o);
      Object.values(o).forEach(hunt);
    };
    hunt(c.body);
    for (const f of found) {
      const words: string[] = [];
      quillText(f, words);
      console.log(`  SNEAK PEEK  ${words.join(' / ') || '(no text)'}`);
    }
  }

  const interesting = [...paths.keys()]
    .filter((p) => /quant|avail|stock|inventor|limit|launch|street|sellable|promise|reason/i.test(p))
    .sort();
  console.log(`\n  stock and timing fields present (${interesting.length}):`);
  for (const p of interesting) {
    console.log(`    ${p} = ${[...(paths.get(p) ?? [])].slice(0, 4).join(' | ')}`);
  }
  console.log(`\n  written to ${file}\n`);

  await browser.close().catch(() => {});
}

/** Which field paths are new, gone, or changed between two snapshots. */
function diff(a: string, b: string): void {
  const A = JSON.parse(readFileSync(a, 'utf8')) as {
    paths: Record<string, string[]>;
    modules: string[];
    at: string;
  };
  const B = JSON.parse(readFileSync(b, 'utf8')) as typeof A;

  const added = Object.keys(B.paths).filter((k) => !(k in A.paths));
  const gone = Object.keys(A.paths).filter((k) => !(k in B.paths));
  const modAdded = B.modules.filter((m) => !A.modules.includes(m));

  console.log(`\n  ${A.at}  ->  ${B.at}\n`);
  console.log(`  NEW MODULES (${modAdded.length}): ${modAdded.join(', ') || 'none'}`);
  console.log(`\n  NEW FIELDS (${added.length}) — this is the list that answers the question:`);
  for (const k of added) console.log(`    + ${k} = ${(B.paths[k] ?? []).slice(0, 4).join(' | ')}`);
  console.log(`\n  FIELDS THAT DISAPPEARED (${gone.length}):`);
  for (const k of gone) console.log(`    - ${k}`);

  console.log('\n  CHANGED VALUES on stock and timing fields:');
  for (const k of Object.keys(B.paths)) {
    if (!(k in A.paths)) continue;
    if (!/quant|avail|stock|inventor|limit|launch|street|sellable|promise|reason/i.test(k)) continue;
    const before = (A.paths[k] ?? []).join(',');
    const after = (B.paths[k] ?? []).join(',');
    if (before !== after) console.log(`    ~ ${k}: ${before}  ->  ${after}`);
  }
  console.log();
}

const [, , first, second, third] = process.argv;
if (first === 'diff') {
  if (!second || !third) throw new Error('diff needs two snapshot files');
  diff(second, third);
} else if (/^\d+$/.test(first ?? '')) {
  await snapshot(first!);
} else {
  console.log('usage: pdp-snapshot.ts <tcin>   |   pdp-snapshot.ts diff <fileA> <fileB>');
  process.exit(1);
}
