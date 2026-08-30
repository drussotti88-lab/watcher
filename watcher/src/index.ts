/**
 * Watcher CLI.
 *
 * `watch` is the real one. The others exist to answer questions that would
 * otherwise be guesses: can this machine see these sites at all, and what does
 * a given product page actually contain.
 */
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig, CONFIG_PATH } from './config.ts';
import { Browser } from './browser.ts';
import { probeAll, renderProbe, PROBE_TARGETS } from './probe.ts';
import { inspectUrl, renderInspection } from './inspect.ts';
import { Hub } from './hub.ts';
import { Pacer } from './rate.ts';
import { isAwake, overrides } from './hours.ts';
import { pass } from './watch.ts';
import {
  scanTargetSearch,
  renderScan,
  candidates,
  toDiscovered,
  renderDiscover,
} from './scan.ts';
import { Activity } from './activity.ts';

/**
 * What to sweep when nothing is named.
 *
 * One query cannot find what one query does not rank for. Target's search is
 * loose and personalised — it put an action figure first for "elite trainer
 * box" — so the way to see the catalogue is to ask several narrow questions
 * rather than one broad one, and let the discovery table union the answers.
 *
 * The last entry is deliberately the broadest: it is the one that can turn up
 * a product form nobody has thought of, which is the entire point of a
 * discovery feed as opposed to a watchlist.
 */
const DEFAULT_QUERIES = [
  'pokemon elite trainer box',
  'pokemon booster box',
  'pokemon booster bundle',
  'pokemon booster pack',
  'pokemon build and battle box',
  'pokemon ex box',
  'pokemon premium collection',
  'pokemon ultra premium collection',
  'pokemon upc',
  'pokemon spc',
  'pokemon tin',
  'pokemon blister pack',
  'pokemon trading card game',
];

/**
 * Whose budget a sweep spends.
 *
 * Must be spelled exactly as missions spell it, or the sweep and the watching
 * would each think they had the retailer to themselves and between them poll
 * at twice the intended rate.
 */
const SWEEP_RETAILER = 'Target';

/**
 * How to stop the Watcher without killing it.
 *
 * Ctrl+C works when you are sitting at the window. Nothing did when you were
 * not — and on Windows there is no polite way to send an interrupt to another
 * process — so every remote restart was a hard kill. That skipped the shutdown
 * path twice over: buffered log lines died with the process, and Chrome was
 * never closed, which is why the profile came back saying "Restore pages?
 * Chrome didn't shut down correctly".
 *
 * A file is the least clever thing that works from anywhere.
 */
const STOP_FILE = 'logs/.stop';

/**
 * Target's own facet id for "Sold by: Target".
 *
 * Read off the search response rather than guessed: `d_sellers_all` lists
 * `dq4mn = Target` alongside the marketplace sellers. Applying it is the
 * difference between five useful results in twenty-four and twenty-four.
 *
 * Nineteen of every twenty-four results for "pokemon booster box" were Target
 * Plus resellers, and the sweep threw every one of them away *after* paying
 * for the page. Now the page is not paid for.
 */
const SOLD_BY_TARGET = 'dq4mn';

/** How many pages deep to go per query. */
const MAX_PAGES = 3;

/** Results per page, as Target's own request declares it. */
const PAGE_SIZE = 24;

const searchUrl = (query: string, offset = 0): string => {
  const params = new URLSearchParams({
    searchTerm: query,
    facetedValue: SOLD_BY_TARGET,
  });
  // Nao is the offset the storefront uses. Absent means the first page, and a
  // zero would be harmless but noisy in the log.
  if (offset > 0) params.set('Nao', String(offset));
  return 'https://www.target.com/s?' + params.toString();
};

const COMMANDS = [
  'watch',
  'stop',
  'once',
  'scan',
  'discover',
  'probe',
  'browser',
  'signin',
  'inspect',
  'help',
] as const;
type Command = (typeof COMMANDS)[number];

function help(): void {
  console.log(`
  Watcher — watches retailers from your own machine, on your own connection.

  npm run watch      The real thing. Pulls your missions from the Hub, checks
                     whatever is due, and reports what it saw. Ctrl+C to stop.

  npm run once       One pass, then exit. Use this first.

  npm run stop       Ask a running Watcher to stop cleanly, from anywhere.
                     It closes Chrome and flushes its log first; killing it
                     does neither.

  npm run scan "<target search url>"
                     Reads a whole Target category in one request and sorts it
                     into what is worth watching. Says which items Target has
                     scheduled, which have stock sitting in a store while the
                     site still says no, and which are resellers wearing a
                     Target URL. Changes nothing — it is a way of looking.

  npm run discover   The same scan, remembered. Keeps only sealed Pokémon TCG
                     sold by Target, hands it to the Hub, and tells you what
                     was not there last time. The first run is the baseline
                     and announces nothing.

  npm run probe      Can this machine see the three retailers at all?

  npm run signin     Opens the BUY profile so you can log in to the retailers.
                     Watching is done signed out, on a separate profile, so the
                     noisy half can never cost you the account that holds your
                     payment details.

  npm run inspect <product-url>
                     Reports everything readable on one product page and saves
                     it to probe-artifacts/. This is how the per-retailer
                     readers get written from what a page really contains.

  Config: ${CONFIG_PATH}
`);
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

async function runPasses(once: boolean): Promise<void> {
  const config = loadConfig();

  if (!config.hub.url || !config.hub.token) {
    console.error(`
  No Hub configured.

  The Watcher gets its missions from the Hub and reports back to it; without
  one there is nothing to watch and nowhere to put what it sees.

  Set hub.url and hub.token in ${CONFIG_PATH}.
  The token is the INGEST_TOKEN from your Hub's environment.
`);
    process.exitCode = 1;
    return;
  }

  const hub = new Hub({ url: config.hub.url, token: config.hub.token });
  // Signed out, always. See the Persona comment in browser.ts.
  const browser = new Browser(config, 'watch');
  const pacer = new Pacer();

  // The log. Its own token goes in as a known secret so that even a Hub error
  // that quotes the Authorization header back at us cannot write it down.
  const activity = new Activity({
    sink: hub,
    secrets: [config.hub.token],
    dir: 'logs',
  });

  browser.onEvent = (level, message) => {
    activity.record({ kind: 'browser', level, message });
    console.log(`  ${timestamp()}  ${message}`);
  };

  // Once per run: what this machine is, so a failure that turns out to be a
  // Chrome upgrade or a Node version is answerable without asking.
  activity.record({
    kind: 'startup',
    message: `watcher started, checking every ${config.intervalSec}s`,
    detail:
      `node ${process.version} · ${process.platform}/${process.arch} · ` +
      `chrome channel ${config.browser.channel}${config.browser.headed ? ' (headed)' : ''} · ` +
      `hub ${hub.configured ? 'configured' : 'missing'}`,
  });

  console.log(`\n  Watching via ${config.hub.url}`);
  console.log(`  Browser profile: ${browser.profileDir} (signed out, deliberately)`);
  if (!once) console.log(`  Ctrl+C to stop.\n`);

  /** Pages still to fetch in the current sweep. Empty means none in progress. */
  let sweepPlan: { query: string; offset: number }[] = [];
  /** Alternates while a sweep is planned, so watching and sweeping share the budget. */
  let sweepTurn = false;

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    console.log('\n  stopping…\n');
  });

  // A stop file left over from last time would stop this run before it began.
  try {
    mkdirSync('logs', { recursive: true });
    if (existsSync(STOP_FILE)) rmSync(STOP_FILE);
  } catch {
    /* a logs directory we cannot manage is reported by Activity, not here */
  }

  /**
   * Run at most one sweep query, if one is planned and the retailer will have us.
   *
   * Called *before* the pass, on alternate turns. Calling it only afterwards
   * starved it completely, which is what happened the first time this ran
   * against a real watchlist: every mission is on Target, so every pass spent
   * Target's budget on a check and the sweep never got a look in. Alternating
   * splits the one budget evenly between watching and looking for new things.
   */
  const sweepOnce = async (): Promise<void> => {
    if (sweepPlan.length > 0 && pacer.waitMs(SWEEP_RETAILER, Date.now()) <= 0) {
      const { query, offset } = sweepPlan.shift() as { query: string; offset: number };
      const page = Math.floor(offset / PAGE_SIZE) + 1;
      const label = page === 1 ? `"${query}"` : `"${query}" p${page}`;
      pacer.record(SWEEP_RETAILER, Date.now());
      const scan = await scanTargetSearch(browser, searchUrl(query, offset));

      if (scan.challenged) {
        // Standing down is about the retailer, not about this query. Drop
        // the rest of the plan rather than walking into the same wall
        // thirteen times.
        const until = pacer.challenged(SWEEP_RETAILER, Date.now());
        const mins = Math.round((until - Date.now()) / 60000);
        sweepPlan = [];
        console.log(`  ${timestamp()}  sweep challenged — standing down ${mins}m`);
        activity.record({
          kind: 'sweep',
          level: 'warn',
          retailer: SWEEP_RETAILER,
          message: `challenged during sweep — standing down ${mins}m, plan abandoned`,
        });
      } else if (scan.note) {
        console.log(`  ${timestamp()}  sweep ${label}: ${scan.note}`);
        activity.record({
          kind: 'sweep',
          level: 'error',
          retailer: SWEEP_RETAILER,
          ms: scan.ms,
          message: `sweep ${label} failed: ${scan.note}`,
        });
      } else {
        const found = candidates(scan.verdicts, query);
        let line = `sweep ${label}: ${scan.verdicts.length} results, ${found.length} kept`;

        // Follow the pages. A query for "pokemon booster box" reports 314
        // results and hands back 24; reading one page was seeing seven per
        // cent of the catalogue and calling it a sweep. Queued at the front so
        // a query finishes before the next one starts, and capped, because a
        // broad query can run to fourteen pages and the point is coverage of
        // what is new, not a full crawl.
        // Stop as soon as a page yields nothing.
        //
        // Results come back by relevance, so the sealed product clusters at the
        // front and everything after it is merchandise. Measured, not assumed:
        // page two of "pokemon elite trainer box", filtered to Target's own
        // stock, is twenty-four items of band-aids, paper plates, bed sheets
        // and throw pillows, and the classifier rejected all of them correctly.
        // Paging deeper spends the retailer's patience on party napkins.
        const more = scan.total !== null && offset + PAGE_SIZE < scan.total;
        if (more && page < MAX_PAGES && found.length > 0) {
          sweepPlan.unshift({ query, offset: offset + PAGE_SIZE });
          line += ` · ${scan.total} total, fetching p${page + 1}`;
        } else if (scan.total !== null) {
          line += ` · ${scan.total} total`;
          if (more && found.length === 0) line += ', nothing on this page — next query';
          else if (more) line += `, stopping at p${MAX_PAGES}`;
        }
        if (found.length > 0) {
          // shift() has already run, so an empty plan means this was the last
          // query. Only that one finishes the sweep; the others must not, or a
          // restart part-way through loses the rest and nothing is due again
          // until tomorrow.
          const result = await hub.ingest(
            'target-tcg',
            found.map(toDiscovered),
            sweepPlan.length === 0,
            sweepPlan.length,
          );
          const fresh = result.names ?? [];
          if (result.seeded) line += ' (baseline)';
          else if (fresh.length) line += ` — NEW: ${fresh.join(', ')}`;
        }
        if (sweepPlan.length) line += ` · ${sweepPlan.length} pages left`;
        console.log(`  ${timestamp()}  ${line}`);
        activity.record({
          kind: 'sweep',
          retailer: SWEEP_RETAILER,
          ms: scan.ms,
          message: line,
        });
      }
    }
  };

  try {
    do {
      // Fail open on watching. A Hub that is briefly cold must not stop us
      // looking at pages — we keep watching the last list it gave us, and the
      // readings buffer until it comes back.
      // Asked to stop? Do it here rather than mid-check, so the browser closes
      // properly and the log queue is flushed.
      try {
        if (existsSync(STOP_FILE)) {
          rmSync(STOP_FILE);
          stopped = true;
          console.log(`  ${timestamp()}  stop file seen — shutting down cleanly`);
          activity.record({ kind: 'startup', message: 'asked to stop, shutting down cleanly' });
          break;
        }
      } catch {
        /* an unreadable stop file is not a reason to stop */
      }

      const { missions, stale, reason } = await hub.missionsOrCached();
      if (stale) {
        const said = reason || 'the Hub did not answer';
        console.log(`  ${timestamp()}  ${said}`);
        activity.record({ kind: 'hub', level: 'warn', message: said });
      }

      // ── Should we be looking at all? ──────────────────────────────────
      //
      // The Hub call above is cheap and stays: it is how a settings change or a
      // "check now" reaches a sleeping Watcher. What quiet hours switch off is
      // the expensive half — opening real pages at a retailer that is not going
      // to change them.
      const sleep_ = isAwake(hub.settings);
      const why = sleep_.awake ? '' : overrides(missions, new Date().toISOString().slice(0, 10));
      if (!sleep_.awake && !why) {
        console.log(`  ${timestamp()}  ${sleep_.reason}`);
        activity.record({ kind: 'pass', message: sleep_.reason });
        await activity.flush(once);
        if (once) break;
        // Capped, so a change of mind in the app is picked up in minutes rather
        // than at dawn.
        await sleep(Math.min(sleep_.opensInMs ?? 300_000, 300_000));
        continue;
      }
      if (!sleep_.awake && why) {
        console.log(`  ${timestamp()}  outside watching hours, but ${why} — looking anyway`);
      }

      // ── Sweeping the catalogue, one query at a time ───────────────────
      //
      // Not a five-minute block once a day. One query per turn, sharing this
      // browser and this per-retailer budget, so a sweep needs no politeness
      // rules of its own and can never delay a check by more than one page
      // load. Quiet hours are inherited by sitting inside the same loop.
      //
      // The plan lives in memory. A restart part-way through defers the
      // remaining queries to the next window rather than resuming — a mild
      // cost, and the alternative is another piece of state to keep honest.
      if (sweepPlan.length === 0 && hub.sweepDue) {
        sweepPlan = DEFAULT_QUERIES.map((query) => ({ query, offset: 0 }));
        // Pressed by hand means somebody is looking at the button. Take the
        // next turn rather than waiting for one — the alternation exists to
        // stop a background sweep starving the watching, not to make a person
        // wait three minutes for the thing they just asked for.
        if (hub.sweepManual) sweepTurn = false;
        console.log(`  ${timestamp()}  sweep due — ${sweepPlan.length} queries, one page per turn`);
        activity.record({
          kind: 'sweep',
          message: `sweep starting: ${sweepPlan.length} queries, one page per turn`,
        });
      }

      // Whose turn it is. Alternating rather than "sweep with whatever is left
      // over", because there is never anything left over: with every mission on
      // one retailer, the pass spends that retailer's whole budget every time.
      if (sweepPlan.length > 0) {
        sweepTurn = !sweepTurn;
        if (sweepTurn) await sweepOnce();
      }

      if (missions.length === 0) {
        const why = stale
          ? 'nothing to fall back on — skipping this pass'
          : 'no active missions — add one in the app';
        console.log(`  ${timestamp()}  ${why}`);
        activity.record({ kind: 'pass', level: stale ? 'warn' : 'info', message: why });
      } else {
        const result = await pass(missions, pacer, {
          browser,
          hub,
          activity,
          log: (line) => console.log(line),
        });
        const parts = [`${result.checked} checked`];
        if (result.runs) parts.push(`${result.runs} runs`);
        if (result.failed) parts.push(`${result.failed} failed`);
        if (hub.backlog) {
          parts.push(`${hub.backlog} queued to send`);
          // Never let a growing buffer be the only symptom.
          if (hub.lastError) parts.push(`Hub said: ${hub.lastError}`);
        }
        if (result.waitingOn.length) parts.push(`waiting on ${result.waitingOn.join(', ')}`);
        if (result.nextDueInMs !== null) {
          parts.push(`nothing due — next in ${Math.ceil(result.nextDueInMs / 1000)}s`);
        }
        if (activity.backlog) parts.push(`${activity.backlog} log lines queued`);
        if (activity.lost) parts.push(`${activity.lost} log lines dropped`);
        if (activity.fileError) parts.push(`log file: ${activity.fileError}`);
        console.log(`  ${timestamp()}  ${parts.join(' · ')}`);

        // The summary line, kept. This is the row that gives every check row
        // around it its meaning: one failure among nine successes is a page
        // being slow, and nine failures out of nine is something else.
        activity.record({
          kind: 'pass',
          level: result.failed > 0 && result.failed === result.checked ? 'error' : 'info',
          message: parts.join(' · '),
          detail: result.blocked.join('; '),
        });
      }

      // Force on the last pass so a `once` run, or a Ctrl+C, does not leave
      // the most interesting lines sitting in memory.
      await activity.flush(once || stopped);

      if (once) break;
      await sleep(config.intervalSec * 1000);
    } while (!stopped);
  } finally {
    await activity.flush(true);
    await browser.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'help') as Command;

  if (command === 'help' || !COMMANDS.includes(command)) {
    help();
    return;
  }

  if (command === 'stop') {
    try {
      mkdirSync('logs', { recursive: true });
      writeFileSync(STOP_FILE, new Date().toISOString());
      console.log(`
  Asked the Watcher to stop. It finishes the pass it is on, closes Chrome and
  sends anything still queued — usually within a pass. Kill it instead and you
  lose the queued lines and Chrome comes back saying it did not shut down
  correctly.
`);
    } catch (err) {
      console.error(`\n  could not write the stop file: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'watch' || command === 'once') {
    try {
      await runPasses(command === 'once');
    } catch (err) {
      console.error(`\n  ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n  ${(err as Error).message}\n`);
    process.exit(1);
  }

  const persona = command === 'signin' ? 'buy' : 'watch';
  const browser = new Browser(config, persona);

  try {
    if (command === 'probe') {
      console.log('\n  Opening a real Chrome and visiting each retailer…');
      console.log('  (a window will appear — that is the point; let it work)\n');
      console.log(renderProbe(await probeAll(browser)));
      return;
    }

    if (command === 'scan') {
      const url = process.argv[3];
      if (!url || url.slice(0, 4) !== 'http') {
        console.error(`
  Give me a Target search URL:

    npm run scan "https://www.target.com/s?searchTerm=pokemon+elite+trainer+box"

  Target only, for now. It is the one of the three that publishes an on-sale
  date and a per-store count, so it is the only one where a scan can say
  anything the product page could not.
`);
        process.exitCode = 1;
        return;
      }
      console.log('\n  Opening it — this uses the signed-out watch profile…');
      const result = await scanTargetSearch(browser, url);
      console.log(renderScan(result));
      if (result.challenged || result.note) process.exitCode = 1;
      return;
    }

    if (command === 'discover') {
      const queries = process.argv.slice(3).filter(Boolean);
      const plan = queries.length ? queries : DEFAULT_QUERIES;
      if (!config.hub.url || !config.hub.token) {
        console.error(`
  Discovery needs the Hub — "new" is a question about everything ever seen,
  and this process restarts. Set hub.url and hub.token in ${CONFIG_PATH}.
`);
        process.exitCode = 1;
        return;
      }

      console.log(`
  Sweeping ${plan.length} ${plan.length === 1 ? 'query' : 'queries'} — signed-out watch profile.
  Paced at one page every 20s or so, which is the same budget watching uses.
`);

      const hub = new Hub({ url: config.hub.url, token: config.hub.token });
      const all = new Map<string, ReturnType<typeof candidates>[number]>();
      let stopped = false;
      let lastScan = null as Awaited<ReturnType<typeof scanTargetSearch>> | null;

      for (const [i, query] of plan.entries()) {
        if (i > 0) {
          // The same politeness the watching loop keeps. A sweep that hammers
          // ten searches back to back is the thing that earns a challenge, and
          // a challenge costs the next four hours of watching too.
          await sleep(20_000 + Math.floor(Math.random() * 8_000));
        }
        process.stdout.write(`  ${query} … `);
        const scan = await scanTargetSearch(browser, searchUrl(query));
        lastScan = scan;

        if (scan.challenged) {
          console.log('challenged — stopping the sweep here');
          stopped = true;
          break;
        }
        if (scan.note) {
          console.log(scan.note);
          continue;
        }

        const found = candidates(scan.verdicts, query);
        for (const c of found) {
          // First query to find something gets the credit, so `found_by` names
          // the narrowest query that works rather than the last one that ran.
          if (!all.has(c.row.tcin)) all.set(c.row.tcin, c);
        }
        console.log(`${scan.verdicts.length} results, ${found.length} kept`);
      }

      const found = [...all.values()];
      let fresh: string[] = [];
      let received = 0;
      let seeded = false;
      let error = '';
      if (found.length > 0) {
        try {
          // The CLI accumulates every query and posts once, so this is final.
          const result = await hub.ingest('target-tcg', found.map(toDiscovered), true);
          fresh = result.names ?? [];
          received = result.received;
          seeded = result.seeded;
        } catch (err) {
          error = (err as Error).message;
        }
      }

      console.log(
        renderDiscover({
          scan: lastScan ?? {
            url: `${plan.length} queries`,
            verdicts: [],
            challenged: false,
            challengeReason: '',
            bodies: 0,
            ms: 0,
            note: '',
            total: null,
            offset: null,
          },
          candidates: found,
          fresh,
          received,
          seeded,
          error,
        }),
      );
      if (found.length > 0 && !error) {
        console.log('  Review them in the app, under Finds.\n');
      }
      if (stopped || error) process.exitCode = 1;
      return;
    }

    if (command === 'inspect') {
      const url = process.argv[3];
      if (!url || !/^https?:\/\//.test(url)) {
        console.error('\n  Give me a product URL:  npm run inspect "https://www.target.com/p/..."\n');
        process.exitCode = 1;
        return;
      }
      console.log('\n  Opening it…');
      console.log(renderInspection(await inspectUrl(browser, url)));
      return;
    }

    if (command === 'browser' || command === 'signin') {
      await browser.open();
      const page = await browser.page();
      await page.goto(PROBE_TARGETS[0]!.url).catch(() => {});
      console.log(`
  The ${persona === 'buy' ? 'BUY' : 'WATCH'} profile is open (${browser.profileDir}).
${
  persona === 'buy'
    ? `
  Sign in to the retailers here:
    · https://www.pokemoncenter.com
    · https://www.target.com
    · https://www.walmart.com

  This is the profile that will eventually place orders. Watching uses a
  separate, signed-out profile, so all the polling traffic is anonymous and
  cannot put this account at risk.`
    : `
  This is the profile that does the watching. Leave it signed OUT — that is
  the point of it being separate.`
}

  Press Ctrl+C in this terminal when you are done.
`);
      await new Promise(() => {}); // hold the browser open until Ctrl+C
    }
  } catch (err) {
    console.error(`\n  ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    if (command !== 'browser' && command !== 'signin') await browser.close();
  }
}

process.on('SIGINT', () => {
  process.exit(0);
});

main().catch((err) => {
  console.error('\n  unexpected failure:', err);
  process.exit(1);
});
