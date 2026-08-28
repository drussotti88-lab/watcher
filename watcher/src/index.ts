/**
 * Watcher CLI.
 *
 * `watch` is the real one. The others exist to answer questions that would
 * otherwise be guesses: can this machine see these sites at all, and what does
 * a given product page actually contain.
 */
import { loadConfig, CONFIG_PATH } from './config.ts';
import { Browser } from './browser.ts';
import { probeAll, renderProbe, PROBE_TARGETS } from './probe.ts';
import { inspectUrl, renderInspection } from './inspect.ts';
import { Hub } from './hub.ts';
import { Pacer } from './rate.ts';
import { pass } from './watch.ts';

const COMMANDS = ['watch', 'once', 'probe', 'browser', 'signin', 'inspect', 'help'] as const;
type Command = (typeof COMMANDS)[number];

function help(): void {
  console.log(`
  Watcher — watches retailers from your own machine, on your own connection.

  npm run watch      The real thing. Pulls your missions from the Hub, checks
                     whatever is due, and reports what it saw. Ctrl+C to stop.

  npm run once       One pass, then exit. Use this first.

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

  console.log(`\n  Watching via ${config.hub.url}`);
  console.log(`  Browser profile: ${browser.profileDir} (signed out, deliberately)`);
  if (!once) console.log(`  Ctrl+C to stop.\n`);

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    console.log('\n  stopping…\n');
  });

  try {
    do {
      // Fail open on watching. A Hub that is briefly cold must not stop us
      // looking at pages — we keep watching the last list it gave us, and the
      // readings buffer until it comes back.
      const { missions, stale, reason } = await hub.missionsOrCached();
      if (stale) console.log(`  ${timestamp()}  ${reason || 'the Hub did not answer'}`);

      if (missions.length === 0) {
        console.log(
          `  ${timestamp()}  ${stale ? 'nothing to fall back on — skipping this pass' : 'no active missions — add one in the app'}`,
        );
      } else {
        const result = await pass(missions, pacer, {
          browser,
          hub,
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
        console.log(`  ${timestamp()}  ${parts.join(' · ')}`);
      }

      if (once) break;
      await sleep(config.intervalSec * 1000);
    } while (!stopped);
  } finally {
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
