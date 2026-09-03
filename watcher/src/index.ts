/**
 * Phantom CLI.
 *
 * `watch` is the real one. The others exist to answer questions that would
 * otherwise be guesses: can this machine see these sites at all, and what does
 * a given product page actually contain.
 */
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { loadConfig, CONFIG_PATH } from './config.ts';
import { Browser } from './browser.ts';
import { probeAll, renderProbe, PROBE_TARGETS } from './probe.ts';
import { inspectUrl, renderInspection } from './inspect.ts';
import { Hub } from './hub.ts';
import { Pacer } from './rate.ts';
import { isAwake, overrides } from './hours.ts';
import { dropWindow, burstMsFor, retailerOn, pausedList } from './drop.ts';
import { pass } from './watch.ts';
import {
  scanTargetSearch,
  renderScan,
  candidates,
  toDiscovered,
  renderDiscover,
  scanPokemonCenterCategory,
  pcCandidates,
  scanWalmartSearch,
  walmartCandidates,
} from './scan.ts';
import { searchUrl } from './readers/target-search.ts';
import { makeBuyer } from './buy.ts';
import { categoryUrl, pageCount } from './readers/pokemoncenter-search.ts';
import { searchUrl as walmartSearchUrl } from './readers/walmart-search.ts';
import { deepPages, interleave, todayLocal, type SweepStep } from './plan.ts';
import { isQueue } from './challenge.ts';
import { Activity } from './activity.ts';
import { runSetup } from './setup.ts';
import { takeLock, releaseLock, heldMessage, type LockDeps } from './lock.ts';
import { readVersion } from './version.ts';
import { planUpdate, unpackOver, UPDATE_EVERY_MS } from './update.ts';
import { buildReport, summarise } from './report.ts';
import { upcomingDrop, WARN_MINUTES } from './schedule.ts';

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
 * How to stop Phantom without killing it.
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

/** Who is running. See lock.ts for why one at a time is not negotiable. */
const LOCK_FILE = 'logs/.running';

/** The lock, wired to the real filesystem and the real process table. */
const lockDeps: LockDeps = {
  read: () => {
    try {
      return existsSync(LOCK_FILE) ? readFileSync(LOCK_FILE, 'utf8') : null;
    } catch {
      return null;
    }
  },
  write: (text) => {
    mkdirSync('logs', { recursive: true });
    writeFileSync(LOCK_FILE, text);
  },
  remove: () => {
    try {
      rmSync(LOCK_FILE);
    } catch {
      /* already gone is the outcome we wanted */
    }
  },
  // Signal 0 sends nothing. It is the standard "does this pid exist" probe,
  // and it throws ESRCH when it does not.
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  pid: process.pid,
};

/** How many pages deep to go per query. */
const MAX_PAGES = 3;

/** Results per page, as Target's own request declares it. */
const PAGE_SIZE = 24;

/**
 * Pokémon Center, and why it is a category rather than a list of queries.
 *
 * Target has no first-party sealed-TCG category worth the name, so it has to be
 * searched thirteen different ways. Pokémon Center has exactly the category we
 * want — /category/tcg-cards is 591 products and every one of them is sealed
 * cards — so the right way to read it is to walk it, not to guess at keywords.
 *
 * It is also the only source that carries the Pokémon Center exclusives. The
 * 30th Celebration Pokémon Center Elite Trainer Box, the Booster Bundle and the
 * Mini Tins ten-pack are not sold at Target or Walmart at any price, so no
 * amount of sweeping those two harder would ever have turned them up.
 */
const PC_RETAILER = 'Pokemon Center';
const PC_SOURCE = 'pc-new-releases';
const PC_CATEGORY = 'tcg-cards';

/**
 * How deep to walk Pokémon Center per sweep.
 *
 * 591 products is 19 pages. Reading all of them every sweep would spend the
 * retailer's patience re-reading a back catalogue that has not changed since
 * 2021 — so each sweep reads the front pages, where the catalogue puts what
 * is actually moving, plus a rotating handful of deep pages (see
 * `deepPages` in plan.ts) so the whole catalogue is still covered across
 * successive sweeps. Same six-page budget as before; full coverage roughly
 * every six days instead of never.
 */
const PC_FRESH_PAGES = 3;
const PC_DEEP_PER_SWEEP = 3;

/**
 * Walmart, by search rather than by category.
 *
 * The source was seeded with /browse/toys/trading-cards/4171_4187_1229163,
 * which now answers "This page couldn't be found." The category id had rotted,
 * and because nothing had ever swept Walmart the 404 went unnoticed for as
 * long as the source existed. Words survive a re-organised taxonomy; numeric
 * category ids do not.
 */
const WALMART_RETAILER = 'Walmart';
const WALMART_SOURCE = 'walmart-tcg';
const WALMART_MAX_PAGES = 2;

/**
 * The queries Walmart gets. A subset, and on purpose.
 *
 * Walmart's own sealed Pokémon catalogue is small — thirty results for elite
 * trainer box, all of them theirs, all of them out of stock. Running the full
 * thirteen would spend a third of the sweep's budget re-reading the same short
 * list under different words.
 */
const WALMART_QUERIES = [
  'pokemon elite trainer box',
  'pokemon booster box',
  'pokemon booster bundle',
  'pokemon ultra premium collection',
  'pokemon tin',
];

/**
 * Whose budget a sweep spends.
 *
 * Must be spelled exactly as missions spell it, or the sweep and the watching
 * would each think they had the retailer to themselves and between them poll
 * at twice the intended rate.
 */
const SWEEP_RETAILER = 'Target';


const COMMANDS = [
  'setup',
  'watch',
  'stop',
  'once',
  'scan',
  'discover',
  'probe',
  'browser',
  'signin',
  'inspect',
  'report',
  'update',
  'help',
] as const;
type Command = (typeof COMMANDS)[number];

function help(): void {
  console.log(`
  Phantom — watches retailers from your own machine, on your own connection.

  npm run setup      Start here on a new machine. Asks for the Hub address and
                     your token, proves they work, and writes the config file.

  npm run watch      The real thing. Pulls your missions from the Hub, checks
                     whatever is due, and reports what it saw. Ctrl+C to stop.

  npm run once       One pass, then exit. Use this first.

  npm run stop       Ask a running Phantom to stop cleanly, from anywhere.
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

  npm run report     Gathers what a person debugging this would look at - the
                     last of the log, your settings with the token blanked,
                     which Node and Chrome - and sends it to whoever runs the
                     app. Add a sentence: npm run report "chrome never opens".

  npm run update     Fetches the newest Phantom from the app and restarts into
                     it. Happens by itself every six hours; this is for when
                     you have been asked to do it now.

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

  Phantom gets its missions from the Hub and reports back to it; without
  one there is nothing to watch and nowhere to put what it sees.

  Set hub.url and hub.token in ${CONFIG_PATH}.
  The token is the INGEST_TOKEN from your Hub's environment.
`);
    process.exitCode = 1;
    return;
  }

  // Before anything opens a browser or talks to the Hub. A second instance
  // that got as far as launching Chrome has already done the damage.
  const lock = takeLock(lockDeps);
  if (!lock.ok) {
    console.error(heldMessage(lock.heldBy, LOCK_FILE));
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


  // The buy path. The buy profile opens per attempt and closes after — the
  // signed-in half must never sit in the polling loop. `live` comes from the
  // config and defaults to false, and false means every attempt stops on the
  // line before the button.
  const buyer = makeBuyer({
    hub,
    activity,
    live: config.live,
    openBuyBrowser: async () => {
      const buyBrowser = new Browser(config, 'buy');
      return {
        page: () => buyBrowser.page(),
        close: () => buyBrowser.close(),
      };
    },
    log: (line) => console.log(line),
  });

  browser.onEvent = (level, message) => {
    activity.record({ kind: 'browser', level, message });
    console.log(`  ${timestamp()}  ${message}`);
  };

  // Once per run: what this machine is, so a failure that turns out to be a
  // Chrome upgrade or a Node version is answerable without asking.
  activity.record({
    kind: 'startup',
    message: `Phantom ${readVersion()} started, checking every ${config.intervalSec}s`,
    detail:
      `node ${process.version} · ${process.platform}/${process.arch} · ` +
      `chrome channel ${config.browser.channel}${config.browser.headed ? ' (headed)' : ''} · ` +
      `hub ${hub.configured ? 'configured' : 'missing'}`,
  });

  console.log(`\n  Watching via ${config.hub.url}`);
  console.log(`  Browser profile: ${browser.profileDir} (signed out, deliberately)`);
  if (!once) console.log(`  Ctrl+C to stop.\n`);

  /**
   * Pages still to fetch in the current sweep. Empty means none in progress.
   *
   * Two shapes, because the two retailers are read completely differently:
   * Target by keyword search, Pokémon Center by walking a category. They share
   * one plan so that a Target cooldown does not stop Pokémon Center being read
   * — pacing is per-retailer, and before this the sweep only ever looked at the
   * head of the queue, so one slow retailer stalled the other.
   */
  let sweepPlan: SweepStep[] = [];
  /** Alternates while a sweep is planned, so watching and sweeping share the budget. */
  let sweepTurn = false;
  /** Last-said states, so these lines appear on change rather than every pass. */
  let dropSaid = '';
  let retailersOffSaid = '';

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
  /** One page of a Pokémon Center category. */
  /**
   * A sweep hit a challenge; queue or wall decides the reaction.
   *
   * A wall means "you have been noticed" and earns the long stand-down. A
   * waiting room means "everyone waits because something is DROPPING" — the
   * loudest early signal a retailer gives — so it earns a shout instead:
   * this sweep's steps for that retailer are dropped (they are all behind
   * the same queue), but the pacer is left alone, so watching looks again at
   * the ordinary pace and catches the moment the queue comes down. The
   * 'QUEUE:' message is what the Hub's alarm looks for.
   */
  const sweepChallenged = (retailer: string, label: string, reason: string): void => {
    sweepPlan = sweepPlan.filter((s) => s.retailer !== retailer);
    if (isQueue(reason)) {
      console.log(
        `  ${timestamp()}  QUEUE at ${retailer} — waiting room is up; a drop may be live`,
      );
      activity.record({
        kind: 'sweep',
        level: 'warn',
        retailer,
        message: `QUEUE: waiting room is up at ${retailer} — a drop may be live`,
      });
      return;
    }
    const until = pacer.challenged(retailer, Date.now());
    const mins = Math.round((until - Date.now()) / 60000);
    console.log(`  ${timestamp()}  sweep ${label} challenged — standing down ${mins}m`);
    activity.record({
      kind: 'sweep',
      level: 'warn',
      retailer,
      message: `challenged during sweep — standing down ${mins}m, ${retailer} steps dropped`,
    });
  };

  const sweepPokemonCenter = async (step: {
    category: string;
    page: number;
  }): Promise<void> => {
    const label = `pc/${step.category}${step.page > 1 ? ` p${step.page}` : ''}`;
    const scan = await scanPokemonCenterCategory(
      browser,
      categoryUrl(step.category, step.page),
      todayLocal(),
    );

    if (scan.challenged) {
      // Drops this retailer's remaining steps only. Target's are unaffected —
      // that is the point of the plan carrying a retailer per step.
      sweepChallenged(PC_RETAILER, label, scan.challengeReason);
      return;
    }

    if (scan.note) {
      console.log(`  ${timestamp()}  sweep ${label}: ${scan.note}`);
      activity.record({
        kind: 'sweep',
        level: 'error',
        retailer: PC_RETAILER,
        ms: scan.ms,
        message: `sweep ${label} failed: ${scan.note}`,
      });
      return;
    }

    const found = pcCandidates(scan.verdicts);
    let line = `sweep ${label}: ${scan.verdicts.length} products, ${found.length} worth a look`;

    // Do not walk past the end of a category that is shorter than planned.
    const pages = pageCount(scan.total);
    if (scan.total !== null) line += ` · ${scan.total} in category`;
    if (step.page >= pages) {
      sweepPlan = sweepPlan.filter(
        (s) => !(s.retailer === PC_RETAILER && s.kind === 'pc' && s.page > step.page),
      );
    }

    // The front page knows how long the catalogue really is, so today's deep
    // pages are planned here rather than guessed up front. Appended to the
    // tail of the plan: the pacer spaces them out either way, and the fresh
    // pages keep their place at the head.
    if (step.page === 1 && scan.total !== null) {
      const deep = deepPages(todayLocal(), pages, PC_FRESH_PAGES, PC_DEEP_PER_SWEEP).filter(
        (p) => !sweepPlan.some((s) => s.kind === 'pc' && s.page === p),
      );
      for (const p of deep) {
        sweepPlan.push({ retailer: PC_RETAILER, kind: 'pc', category: step.category, page: p });
      }
      if (deep.length) line += ` · deep pages today: ${deep.join(', ')}`;
    }

    if (found.length > 0) {
      const last = !sweepPlan.some((s) => s.retailer === PC_RETAILER);
      const result = await hub.ingest(PC_SOURCE, found.map(toDiscovered), last, sweepPlan.length);
      const fresh = result.names ?? [];
      if (result.seeded) line += ' (baseline)';
      else if (fresh.length) line += ` — NEW: ${fresh.join(', ')}`;
    }
    if (sweepPlan.length) line += ` · ${sweepPlan.length} pages left`;

    console.log(`  ${timestamp()}  ${line}`);
    activity.record({ kind: 'sweep', retailer: PC_RETAILER, ms: scan.ms, message: line });
  };

  /** One page of a Walmart search. */
  const sweepWalmart = async (step: { query: string; page: number }): Promise<void> => {
    const label = `wm "${step.query}"${step.page > 1 ? ` p${step.page}` : ''}`;
    const scan = await scanWalmartSearch(browser, walmartSearchUrl(step.query, step.page));

    if (scan.challenged) {
      sweepChallenged(WALMART_RETAILER, label, scan.challengeReason);
      return;
    }

    if (scan.note) {
      console.log(`  ${timestamp()}  sweep ${label}: ${scan.note}`);
      activity.record({
        kind: 'sweep',
        level: 'error',
        retailer: WALMART_RETAILER,
        ms: scan.ms,
        message: `sweep ${label} failed: ${scan.note}`,
      });
      return;
    }

    const found = walmartCandidates(scan.rows, step.query);
    let line = `sweep ${label}: ${scan.rows.length} results, ${found.length} kept`;

    // Follow the pages only while there is something on them, and only as far
    // as Walmart says the query goes.
    const pages = scan.maxPage ?? 1;
    if (step.page < Math.min(pages, WALMART_MAX_PAGES) && found.length > 0) {
      sweepPlan.unshift({
        retailer: WALMART_RETAILER,
        kind: 'walmart',
        query: step.query,
        page: step.page + 1,
      });
      line += ` · ${pages} pages, fetching p${step.page + 1}`;
    }

    if (found.length > 0) {
      const last = !sweepPlan.some((s) => s.retailer === WALMART_RETAILER);
      const result = await hub.ingest(
        WALMART_SOURCE,
        found.map(toDiscovered),
        last,
        sweepPlan.length,
      );
      const fresh = result.names ?? [];
      if (result.seeded) line += ' (baseline)';
      else if (fresh.length) line += ` — NEW: ${fresh.join(', ')}`;
    }
    if (sweepPlan.length) line += ` · ${sweepPlan.length} pages left`;

    console.log(`  ${timestamp()}  ${line}`);
    activity.record({ kind: 'sweep', retailer: WALMART_RETAILER, ms: scan.ms, message: line });
  };

  /**
   * How many sweep steps one turn may take.
   *
   * One per retailer, and that is not a coincidence — it is the number the
   * pacer allows. Each step records against its own retailer, so the second
   * step for a shop always finds that shop cooling down and the loop stops on
   * its own; the cap is a belt on top of that.
   *
   * It exists because the loop's cadence is set by the *pass*, which waits on
   * Target. With one step per turn, a Pokémon Center page could only be read as
   * often as Target would allow a Target request — three shops read at the
   * speed of the slowest, which is exactly what carrying a retailer per step
   * was supposed to fix.
   */
  const SWEEP_STEPS_PER_TURN = 3;

  const sweepOnce = async (): Promise<void> => {
    for (let taken = 0; taken < SWEEP_STEPS_PER_TURN; taken += 1) {
      if (!(await sweepStep())) return;
    }
  };

  /** Take one step if any retailer will have us. Returns whether it did. */
  const sweepStep = async (): Promise<boolean> => {
    if (sweepPlan.length === 0) return false;

    // The first step whose retailer will have us, not simply the first step.
    // Looking only at the head meant a Target cooldown stalled the whole plan,
    // including the Pokémon Center pages that Target has no say over.
    const ready = sweepPlan.findIndex((s) => pacer.waitMs(s.retailer, Date.now()) <= 0);
    if (ready === -1) return false;
    const step = sweepPlan.splice(ready, 1)[0]!;
    pacer.record(step.retailer, Date.now());

    if (step.kind === 'pc') {
      await sweepPokemonCenter(step);
      return true;
    }

    if (step.kind === 'walmart') {
      await sweepWalmart(step);
      return true;
    }

    {
      const { query, offset } = step;
      const page = Math.floor(offset / PAGE_SIZE) + 1;
      const label = page === 1 ? `"${query}"` : `"${query}" p${page}`;
      const scan = await scanTargetSearch(browser, searchUrl(query, offset));

      if (scan.challenged) {
        // The reaction is about the retailer, not about this query — the rest
        // of *Target's* plan goes rather than walking into the same wall
        // thirteen times, and only Target's. Queue vs wall is decided in
        // sweepChallenged, same as the other two shops.
        sweepChallenged(SWEEP_RETAILER, label, scan.challengeReason);
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
          sweepPlan.unshift({ retailer: SWEEP_RETAILER, kind: 'target', query, offset: offset + PAGE_SIZE });
          line += ` · ${scan.total} total, fetching p${page + 1}`;
        } else if (scan.total !== null) {
          line += ` · ${scan.total} total`;
          if (more && found.length === 0) line += ', nothing on this page — next query';
          else if (more) line += `, stopping at p${MAX_PAGES}`;
        }
        if (found.length > 0) {
          // The step has already been removed, so "no Target steps left" means
          // this was the last Target page. Only that one finishes Target's
          // sweep; the others must not, or a restart part-way through loses the
          // rest and nothing is due again until tomorrow.
          //
          // Per retailer, not per plan. The plan now holds both shops, and
          // Target finishing while Pokémon Center still has pages to read must
          // still mark Target done — `last_swept_at` is a column on a source.
          const lastForTarget = !sweepPlan.some((s) => s.retailer === SWEEP_RETAILER);
          const result = await hub.ingest(
            'target-tcg',
            found.map(toDiscovered),
            lastForTarget,
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
    return true;
  };

  /*
   * The self-watchdog.
   *
   * The supervisor in the launcher restarts anything that EXITS. It cannot see
   * a hang, and on 1 Sep 2026 that was the whole problem: the process sat
   * alive and wedged for an hour with a drop running, looking from the outside
   * exactly like a busy one.
   *
   * So the process watches itself. Every cycle stamps a heartbeat; if one goes
   * unstamped for long enough this exits — loudly, with a code — and the
   * supervisor does what it is for. Turning a hang into a crash is the whole
   * trick, because a crash is a thing that gets fixed automatically.
   *
   * Ten minutes. A pass is bounded at 90% of the interval plus one 45-second
   * check ceiling, and a sweep is longer but still minutes; past ten it is not
   * slow, it is stuck.
   */
  /*
   * The fast lane for "Check now".
   *
   * ── Why a poll, and why it is not a compromise ────────────────────────────
   *
   * The Hub cannot ring this machine. It is a web app on somebody else's
   * servers and Phantom is behind a home router, so the traffic goes one way
   * and the button can only ever be as fast as the next time we ask. That poll
   * used to be the whole watchlist, once a cycle — which is how a button
   * labelled CHECK NOW came to mean "in the next minute and a half", and a
   * pill that said "check queued" and then sat there.
   *
   * So this asks a much smaller question, much more often: one indexed column
   * and a few integers, every three seconds. Cheap enough that the honest
   * answer to "when does it check?" becomes "about three seconds", which is
   * the difference between a button and a suggestion box.
   *
   * REPLACED wholesale each poll, never accumulated: the Hub clears the flag
   * when the reading lands, so a set that only ever grew would re-check a
   * listing forever on the strength of one press.
   */
  let urgent: ReadonlySet<number> = new Set();
  const urgentPoll = setInterval(() => {
    void hub
      .urgentListings()
      .then((ids) => {
        urgent = new Set(ids);
      })
      .catch(() => {
        /* a missed poll costs one round of latency, and nothing else */
      });
  }, 3_000);

  // First check happens one interval in, not at second zero: a Phantom that
  // has just been started is often being started BECAUSE something is wrong,
  // and replacing its code before it has completed one pass would make that
  // impossible to reason about.
  let lastUpdateCheck = Date.now();

  let heartbeat = Date.now();
  const STALL_MS = 10 * 60_000;
  const watchdog = setInterval(() => {
    const quiet = Date.now() - heartbeat;
    if (quiet < STALL_MS) return;
    console.error(
      `\n  STUCK: no pass has completed for ${Math.round(quiet / 60000)} minutes. ` +
        `Exiting so the launcher restarts a working one.\n`,
    );
    process.exit(3);
  }, 30_000);

  try {
    do {
      // When this cycle began. The sleep at the bottom is measured from HERE,
      // not from when the work finished — see the note there.
      const cycleStart = Date.now();
      heartbeat = cycleStart;

      // Fail open on watching. A Hub that is briefly cold must not stop us
      // looking at pages — we keep watching the last list it gave us, and the
      // readings buffer until it comes back.
      // Asked to stop? Do it here rather than mid-check, so the browser closes
      // properly and the log queue is flushed.
      try {
        if (existsSync(STOP_FILE)) {
          rmSync(STOP_FILE);
          stopped = true;
          // The supervisor in the launcher restarts anything that exits without
          // being asked to. This is the marker that says it WAS asked — written
          // by the process that is stopping, not by the button, so a stop file
          // that never got read cannot be mistaken for a clean exit.
          try {
            writeFileSync('logs/.stopped', new Date().toISOString());
          } catch {
            /* the supervisor restarting once too often is the safe failure */
          }
          console.log(`  ${timestamp()}  stop file seen — shutting down cleanly`);
          activity.record({ kind: 'startup', message: 'asked to stop, shutting down cleanly' });
          break;
        }
      } catch {
        /* an unreadable stop file is not a reason to stop */
      }

      const { missions: allMissions, stale, reason } = await hub.missionsOrCached();
      if (stale) {
        const said = reason || 'the Hub did not answer';
        console.log(`  ${timestamp()}  ${said}`);
        activity.record({ kind: 'hub', level: 'warn', message: said });
      }

      // ── Which shops are switched on ───────────────────────────────────
      //
      // A shop at a time, above the mission's own enabled flag and below the
      // master switch. Off means off for both halves — checks here, sweeps
      // below — because a toggle that stopped one and not the other would be
      // a toggle that lies about what it is doing.
      const missions = allMissions.filter((m) => retailerOn(hub.settings, m.retailer));
      const offNow = pausedList(hub.settings);
      if (offNow !== retailersOffSaid) {
        retailersOffSaid = offNow;
        const said = offNow ? `shops switched off: ${offNow}` : 'every shop is switched on';
        console.log(`  ${timestamp()}  ${said}`);
        activity.record({ kind: 'pass', message: said });
      }

      // ── How hard to look ──────────────────────────────────────────────
      //
      // The burst is an exception with an end: a manual window with an expiry,
      // or the day something on the watchlist is released. Outside one, the
      // ordinary 20s floor is restored — including the moment a window closes,
      // which is why this is recomputed every pass rather than latched.
      const window = dropWindow(hub.settings, allMissions, Date.now());
      pacer.setBurstSpacing(burstMsFor(hub.settings, allMissions, Date.now()));
      if (window.reason !== dropSaid) {
        dropSaid = window.reason;
        if (window.open) {
          const secs = Math.round(pacer.spacingMs / 1000);
          const said = `DROP WINDOW open — checking every ${secs}s (${window.reason})`;
          console.log(`  ${timestamp()}  ${said}`);
          activity.record({ kind: 'pass', level: 'warn', message: said });
        } else {
          const said = 'drop window closed — back to the ordinary pace';
          console.log(`  ${timestamp()}  ${said}`);
          activity.record({ kind: 'pass', message: said });
        }
      }

      // ── Should we be looking at all? ──────────────────────────────────
      //
      // The Hub call above is cheap and stays: it is how a settings change or a
      // "check now" reaches a sleeping Phantom. What quiet hours switch off is
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
        // Both retailers, interleaved rather than one after the other. The
        // pacer holds each retailer separately, so alternating means a Pokémon
        // Center page can be read during Target's cooldown and vice versa —
        // the sweep gets through roughly twice as much wall-clock work, and
        // neither shop is asked for anything faster than it was before.
        const targetSteps: SweepStep[] = DEFAULT_QUERIES.map((query) => ({
          retailer: SWEEP_RETAILER,
          kind: 'target' as const,
          query,
          offset: 0,
        }));
        // Only the fresh pages are planned here; page one reports how long
        // the catalogue actually is, and today's rotating deep pages are
        // appended then, sized to the real count instead of a stale guess.
        const pcSteps: SweepStep[] = Array.from({ length: PC_FRESH_PAGES }, (_, i) => ({
          retailer: PC_RETAILER,
          kind: 'pc' as const,
          category: PC_CATEGORY,
          page: i + 1,
        }));
        const walmartSteps: SweepStep[] = WALMART_QUERIES.map((query) => ({
          retailer: WALMART_RETAILER,
          kind: 'walmart' as const,
          query,
          page: 1,
        }));
        // A switched-off shop is not swept either. Same rule as the checks
        // above, applied where the plan is built so a paused shop never even
        // takes a turn in the rotation.
        sweepPlan = interleave(targetSteps, pcSteps, walmartSteps).filter((step) =>
          retailerOn(hub.settings, step.retailer),
        );
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
          buyer,
          log: (line) => console.log(line),
          // Work the whole interval instead of taking one turn and sleeping
          // through the rest of it. 90% of it, so the pass still returns in
          // time to pick up fresh missions and settings on schedule rather
          // than drifting a little later every cycle.
          windowMs: Math.round(config.intervalSec * 1000 * 0.9),
          urgent: () => urgent,
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

      // ── Staying current ──────────────────────────────────────────────────
      //
      // Every six hours, ask the Hub what it is handing out. If it differs
      // from this copy, unpack it over this folder and exit WITHOUT writing
      // the stopped marker — the launcher reads that as a crash and starts a
      // fresh one, which is now the new code. See update.ts for every reason
      // this declines.
      if (Date.now() - lastUpdateCheck > UPDATE_EVERY_MS) {
        lastUpdateCheck = Date.now();
        const soon = upcomingDrop(new Date(), WARN_MINUTES);
        const decision = planUpdate({
          own: readVersion(),
          hub: (await hub.phantomVersion())?.version ?? null,
          enabled: config.autoUpdate,
          once,
          minutesToDrop: soon ? soon.minutesUntil : null,
        });
        if (decision.update) {
          try {
            console.log(`  ${timestamp()}  updating: ${decision.why}`);
            const written = unpackOver(await hub.phantomZip(), process.cwd());
            activity.record({
              kind: 'startup',
              message: `updating Phantom — ${decision.why}`,
              detail: `${written.length} files replaced; restarting`,
            });
            await activity.flush(true);
            await browser.close();
            releaseLock(lockDeps);
            console.log(`
  Phantom has updated itself (${written.length} files) and is restarting.
  If this window does not come back on its own, close it and double-click
  "2 - Start watching".
`);
            // Deliberately NOT logs/.stopped: the supervisor must restart us.
            process.exit(0);
          } catch (err) {
            // An update that fails is a log line, never an outage. The old
            // copy is still here and still working.
            const why = (err as Error).message;
            console.log(`  ${timestamp()}  update failed, carrying on: ${why}`);
            activity.record({ kind: 'startup', level: 'warn', message: `update failed: ${why}` });
          }
        }
      }

      // ── The interval is a CADENCE, not a gap ────────────────────────────
      //
      // This used to sleep the full interval after the pass returned. Once a
      // pass started draining its list that turned into: work for seventy-five
      // seconds, then sleep another ninety on top — a cycle nearly twice as
      // long as the interval anyone configured, and the drop window got half
      // the checks it was asked for.
      //
      // Measured from the START of the cycle, "every 90 seconds" means every
      // 90 seconds. A pass that overran its window sleeps not at all and the
      // next one begins immediately, which is the correct behaviour when there
      // is more to look at than time to look.
      const spent = Date.now() - cycleStart;
      const rest = config.intervalSec * 1000 - spent;
      // Interruptible. Sleeping through a press is the same failure as
      // queueing behind fourteen other listings, arriving by a different
      // route — so the rest between cycles is spent in short naps with one
      // eye open.
      for (let slept = 0; slept < rest; slept += 500) {
        if (urgent.size > 0 || stopped) break;
        await sleep(Math.min(500, rest - slept));
      }
    } while (!stopped);
  } finally {
    clearInterval(watchdog);
    clearInterval(urgentPoll);
    await activity.flush(true);
    await browser.close();
    // Only if it is still ours: an instance that lost the race must not
    // delete the winner's lock on its way out.
    releaseLock(lockDeps);
  }
}




const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'help') as Command;

  if (command === 'help' || !COMMANDS.includes(command)) {
    help();
    return;
  }

  // Before loadConfig, deliberately: this is the command you run when there is
  // no config to load.
  if (command === 'setup') {
    await runSetup();
    return;
  }

  if (command === 'stop') {
    try {
      mkdirSync('logs', { recursive: true });
      writeFileSync(STOP_FILE, new Date().toISOString());
      console.log(`
  Asked Phantom to stop. It finishes the pass it is on, closes Chrome and
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

    /*
     * ── Sending a report ─────────────────────────────────────────────────
     *
     * Runs without a browser and without the lock, so it works while Phantom
     * is running, and works when Phantom is too broken to start — which is
     * when it is wanted. If the Hub cannot be reached, the report is written
     * next to the program so it can be attached to a message by hand: a
     * diagnostic that needs the thing being diagnosed is no diagnostic.
     */
    if (command === 'report') {
      const note = process.argv.slice(3).join(' ');
      const report = buildReport({ dir: process.cwd(), version: readVersion(), note });
      console.log(`\n  ${summarise(report)}\n`);

      let config: ReturnType<typeof loadConfig> | null = null;
      try {
        config = loadConfig();
      } catch {
        /* no config is itself the report; fall through to the file */
      }
      if (config?.hub.url && config.hub.token) {
        try {
          const hub = new Hub({ url: config.hub.url, token: config.hub.token });
          const id = await hub.sendReport(report);
          console.log(`  Sent. It is report #${id} in the app.\n`);
          console.log('  Nothing here included your token, your card, or any page');
          console.log('  Phantom captured — only the log, your settings with the token');
          console.log('  blanked, and which Node and Chrome you have.\n');
          return;
        } catch (err) {
          console.log(`  Could not send it: ${(err as Error).message}`);
        }
      }
      const file = `phantom-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`\n  Written to ${file}. Send that file instead.\n`);
      return;
    }

    /** Update on demand. The same path the loop takes every six hours. */
    if (command === 'update') {
      const config = loadConfig();
      const hub = new Hub({ url: config.hub.url, token: config.hub.token });
      const own = readVersion();
      const theirs = await hub.phantomVersion();
      const decision = planUpdate({
        own,
        hub: theirs?.version ?? null,
        // Asked for by hand: the config switch and the drop window are about
        // Phantom deciding on its own, and a person at the keyboard outranks
        // both. The development-checkout rule is not negotiable and stays.
        enabled: true,
        once: false,
        minutesToDrop: null,
      });
      if (!decision.update) {
        console.log(`\n  Nothing to do — ${decision.why}.\n`);
        return;
      }
      console.log(`\n  Updating: ${decision.why}`);
      const written = unpackOver(await hub.phantomZip(theirs?.url), process.cwd());
      console.log(`  ${written.length} files replaced.`);
      console.log('\n  Now run "1 - Set up" once (it installs anything new), then');
      console.log('  "2 - Start watching". If Phantom is running, stop it first.\n');
      return;
    }

    if (command === 'browser' || command === 'signin') {
      await browser.open();
      const page = await browser.page();
      // The buy profile opens on Target and nowhere else: it is the one shop
      // with a checkout flow, and the whole point of this profile is to touch
      // nothing it does not need. Landing on Pokémon Center here was extra
      // signed-profile traffic for zero benefit — Roberto's call, 31 Aug.
      await page
        .goto(persona === 'buy' ? 'https://www.target.com' : PROBE_TARGETS[0]!.url)
        .catch(() => {});
      console.log(`
  The ${persona === 'buy' ? 'BUY' : 'WATCH'} profile is open (${browser.profileDir}).
${
  persona === 'buy'
    ? `
  Sign in to Target here, in this window. Only Target: it is the one shop
  with a checkout flow. Do not sign in to Walmart here — its human check
  fails in any browser this program opens, so a Walmart drop is done from
  your everyday Chrome (see "8 - Hold my place").

  This is the profile that places orders. Watching uses a separate,
  signed-out profile, so all the polling traffic is anonymous and cannot
  put this account at risk.`
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

/*
 * Say something on the way out.
 *
 * Phantom died twice on 1 Sep 2026 — once at 19:14 and again at 20:08 — and
 * both times the log simply stopped mid-pass. No stack, no exit line, nothing
 * to tell a crash from a kill from a closed window, which is the difference
 * between a bug to fix and a machine to plug in.
 *
 * These print and FLUSH synchronously, because an async handler on the way to
 * process death does not finish.
 */
process.on('uncaughtException', (err) => {
  console.error(`\n  CRASHED: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason as Error;
  console.error(`\n  CRASHED on an unhandled promise: ${err?.stack ?? String(reason)}\n`);
  process.exit(1);
});
process.on('exit', (code) => {
  // The one line that tells a clean stop from a disappearance. A process that
  // was killed from outside never reaches here at all, and that absence is
  // itself the answer.
  console.log(`\n  Phantom exited with code ${code} at ${new Date().toISOString()}\n`);
});

main().catch((err) => {
  console.error('\n  unexpected failure:', err);
  process.exit(1);
});
