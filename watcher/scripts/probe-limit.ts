/**
 * How fast may we look before Target objects?
 *
 * The ordinary floor is one request every 20s, chosen by reasoning rather than
 * by measurement. A drop is over in ninety seconds, so the difference between
 * 20s and 8s is the difference between seeing a drop three times and seeing it
 * ten — and nobody has ever measured where the real wall is.
 *
 * ── The rules this test runs under ───────────────────────────────────────────
 *
 * Gentle ramp, instant backoff (owner's decision, 1 Sep 2026):
 *
 *   · It steps DOWN one rung at a time — 20, 15, 10, 7, 5 — and never below 5s,
 *     because 5s is the hard floor the pacer clamps to and probing a speed we
 *     have forbidden ourselves is pure risk for no answer.
 *   · The FIRST challenge ends the whole run. Not a retry, not the next rung:
 *     it stops, reports the last rung that was clean, and closes the browser.
 *     Arguing with a bot check is how a soft flag becomes a hard block, and
 *     this is being run against the connection that also does the buying.
 *   · It reads ONE product, repeatedly. A second product would double the
 *     traffic while answering the same question.
 *   · It is bounded: a handful of reads per rung, and the whole run is over in
 *     a few minutes. There is no "leave it running overnight" mode on purpose.
 *
 * Run it with the live Watcher STOPPED, or the two of you are both spending
 * Target's patience and neither number means anything.
 *
 *   node --experimental-strip-types scripts/probe-limit.ts [tcin] [url]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { readListing } from '../src/read.ts';

/** Seconds between reads, slowest first. Never below the pacer's hard floor. */
const RUNGS = [20, 15, 10, 7, 5];
/** Reads per rung. Enough to be more than luck, few enough to stay brief. */
const READS_PER_RUNG = 6;

const TCIN = process.argv[2] ?? '95267143';
const URL = process.argv[3] ?? `https://www.target.com/p/-/A-${TCIN}`;

interface RungResult {
  spacingSeconds: number;
  reads: number;
  latenciesMs: number[];
  medianMs: number;
  worstMs: number;
  challenged: boolean;
  challengeReason: string;
  unreadable: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  const browser = new Browser(config.browser);
  const results: RungResult[] = [];
  let stoppedBy = '';

  console.log(`\n  Probe-limit test — ${URL}`);
  console.log(`  Rungs: ${RUNGS.join('s, ')}s · ${READS_PER_RUNG} reads each`);
  console.log(`  The first challenge ends the run.\n`);

  try {
    for (const spacing of RUNGS) {
      const rung: RungResult = {
        spacingSeconds: spacing,
        reads: 0,
        latenciesMs: [],
        medianMs: 0,
        worstMs: 0,
        challenged: false,
        challengeReason: '',
        unreadable: 0,
      };
      console.log(`  ── every ${spacing}s ──`);

      for (let i = 0; i < READS_PER_RUNG; i += 1) {
        const started = Date.now();
        const reading = await readListing(browser, 'Target', TCIN, URL);
        const ms = Date.now() - started;
        rung.reads += 1;
        rung.latenciesMs.push(ms);

        if (reading.challenged) {
          rung.challenged = true;
          rung.challengeReason = reading.challengeReason;
          console.log(`    read ${i + 1}: CHALLENGED — ${reading.challengeReason}`);
          break;
        }
        if (reading.state === 'unknown' && reading.confidence === 'unknown') {
          rung.unreadable += 1;
        }
        console.log(
          `    read ${i + 1}: ${String(ms).padStart(5)}ms  ${reading.state}` +
            `${reading.price === null ? '' : ` $${reading.price}`}` +
            `${reading.availableQuantity === null ? '' : ` atp ${reading.availableQuantity}`}`,
        );

        // The gap is measured from the START of the read, so "every 8s" means
        // every 8s, not 8s plus however long the page took.
        if (i < READS_PER_RUNG - 1) {
          const elapsed = Date.now() - started;
          await sleep(Math.max(0, spacing * 1000 - elapsed));
        }
      }

      rung.medianMs = median(rung.latenciesMs);
      rung.worstMs = Math.max(0, ...rung.latenciesMs);
      results.push(rung);
      console.log(`    median ${rung.medianMs}ms · worst ${rung.worstMs}ms\n`);

      if (rung.challenged) {
        stoppedBy = `a challenge at ${spacing}s: ${rung.challengeReason}`;
        break;
      }
    }
  } finally {
    await browser.close();
  }

  const clean = results.filter((r) => !r.challenged);
  const fastestClean = clean.length ? clean[clean.length - 1]!.spacingSeconds : null;

  console.log('  ── what this run says ──');
  for (const r of results) {
    console.log(
      `    ${String(r.spacingSeconds).padStart(2)}s: ${r.reads} reads · ` +
        `median ${r.medianMs}ms · ${r.challenged ? 'CHALLENGED' : 'clean'}` +
        `${r.unreadable ? ` · ${r.unreadable} unreadable` : ''}`,
    );
  }
  if (stoppedBy) console.log(`\n  Stopped by ${stoppedBy}`);
  console.log(
    `\n  Fastest clean spacing: ${fastestClean === null ? 'none' : `${fastestClean}s`}` +
      `${fastestClean === RUNGS[RUNGS.length - 1] ? ' (the floor — it never objected)' : ''}`,
  );
  // One rung of margin is the honest recommendation: this ran for minutes, and
  // a drop window runs for an hour. The number that survived a short test is
  // not automatically the number to live at.
  const idx = clean.length ? RUNGS.indexOf(clean[clean.length - 1]!.spacingSeconds) : -1;
  const suggested = idx > 0 ? RUNGS[idx - 1] : fastestClean;
  console.log(
    `  Suggested drop-window setting: ${suggested === null ? 'leave it off' : `${suggested}s`}` +
      ` — one rung of margin over what was measured.\n`,
  );

  mkdirSync('logs', { recursive: true });
  const out = {
    at: new Date().toISOString(),
    url: URL,
    readsPerRung: READS_PER_RUNG,
    results,
    stoppedBy,
    fastestClean,
    suggested,
  };
  writeFileSync('logs/probe-limit.json', JSON.stringify(out, null, 2));
  console.log('  Written to logs/probe-limit.json\n');
}

await main();
