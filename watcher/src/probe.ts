/**
 * Reachability, answered properly.
 *
 * curl from a residential IP proves almost nothing — bot protection reads the
 * TLS handshake and header ordering, and a command-line client fails those
 * whatever address it comes from. The only honest test is a real browser making
 * a real navigation.
 *
 * Probe homepages, not category pages. A guessed category id returns 404, and a
 * 404 says nothing about whether you're allowed in — it says you asked for a
 * page that doesn't exist. The first version of this made exactly that mistake
 * and reported it as a failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from './browser.ts';
import { detectChallenge, readWhenReady } from './browser.ts';
import type { ProbeResult, Retailer } from './types.ts';

export const PROBE_TARGETS: { retailer: Retailer; url: string; label: string }[] = [
  { retailer: 'pokemoncenter', url: 'https://www.pokemoncenter.com/', label: 'Pokémon Center' },
  { retailer: 'target', url: 'https://www.target.com/', label: 'Target' },
  { retailer: 'walmart', url: 'https://www.walmart.com/', label: 'Walmart' },
];

const ARTIFACT_DIR = 'probe-artifacts';

export async function probeOne(
  browser: Browser,
  target: { retailer: Retailer; url: string },
  keepArtifacts: boolean,
): Promise<ProbeResult> {
  const started = Date.now();
  const page = await browser.page();

  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    // Wait for the app to actually render rather than measuring a blank shell.
    const read = await readWhenReady(page, { minText: 500, timeoutMs: 20_000 });

    const status = response?.status() ?? null;
    const { challenged, reason } = detectChallenge(read.title, read.text);
    const ms = Date.now() - started;

    let verdict: string;
    let reachable = false;

    if (challenged) {
      verdict = `CHALLENGED — ${reason}`;
    } else if (status !== null && status >= 400) {
      verdict = `HTTP ${status} — the page itself, not a block`;
    } else if (read.textLength < 200) {
      verdict = `rendered only ${read.textLength} chars of text — inconclusive`;
    } else {
      reachable = true;
      verdict = `reachable — ${read.textLength.toLocaleString()} chars rendered`;
    }

    // Keep the evidence when the answer isn't a clean yes. Guessing at what a
    // page contained after the browser has closed is not debugging.
    if (keepArtifacts && !reachable) {
      const dir = resolve(process.cwd(), ARTIFACT_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${target.retailer}.html`), read.html, 'utf8');
      writeFileSync(resolve(dir, `${target.retailer}.txt`), read.text, 'utf8');
      await page
        .screenshot({ path: resolve(dir, `${target.retailer}.png`), fullPage: false })
        .catch(() => {});
      verdict += `  → saved to ${ARTIFACT_DIR}/${target.retailer}.*`;
    }

    return {
      retailer: target.retailer,
      url: target.url,
      reachable,
      challenged,
      status,
      ms,
      title: read.title.slice(0, 70),
      verdict,
    };
  } catch (err) {
    return {
      retailer: target.retailer,
      url: target.url,
      reachable: false,
      challenged: false,
      status: null,
      ms: Date.now() - started,
      title: '',
      verdict: `failed — ${(err as Error).message.split('\n')[0]}`,
    };
  }
}

export async function probeAll(browser: Browser, keepArtifacts = true): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const target of PROBE_TARGETS) {
    out.push(await probeOne(browser, target, keepArtifacts));
    // Space the requests out. Three loads back to back from one address is
    // exactly the shape that gets you rate-limited.
    await new Promise((r) => setTimeout(r, 3000));
  }
  return out;
}

export function renderProbe(results: ProbeResult[]): string {
  const lines = ['', '  RETAILER          MS   VERDICT', '  ' + '─'.repeat(72)];
  for (const r of results) {
    lines.push(`  ${r.retailer.padEnd(15)}${String(r.ms).padStart(5)}   ${r.verdict}`);
    if (r.title) lines.push(`  ${''.padEnd(20)}“${r.title}”`);
  }

  const ok = results.filter((r) => r.reachable).length;
  const challenged = results.filter((r) => r.challenged).length;

  lines.push('');
  if (ok === results.length) {
    lines.push('  All three reachable from this machine.');
    lines.push('  Phantom is the data path — that settles it.');
  } else if (challenged > 0) {
    lines.push(`  ${ok}/${results.length} clean, ${challenged} challenged.`);
    lines.push('');
    lines.push('  Before concluding anything: run  npm run browser  , sign in to the');
    lines.push('  challenged sites in Phantom\'s own Chrome, then probe again. A');
    lines.push('  signed-in session is treated very differently from a cold one.');
  } else {
    lines.push(`  ${ok}/${results.length} reachable.`);
    lines.push(`  Anything inconclusive has its page saved under ${ARTIFACT_DIR}/ —`);
    lines.push('  open the .png and you can see exactly what the browser saw.');
  }
  lines.push('');
  return lines.join('\n');
}
