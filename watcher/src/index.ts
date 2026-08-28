/**
 * Watcher CLI.
 *
 * Two commands for now, deliberately. Until we know what these three sites
 * actually serve a real browser from your address, everything downstream is
 * guesswork — so the first release does exactly the two things that answer
 * that, and nothing else.
 */
import { loadConfig, CONFIG_PATH } from './config.ts';
import { Browser } from './browser.ts';
import { probeAll, renderProbe, PROBE_TARGETS } from './probe.ts';
import { inspectUrl, renderInspection } from './inspect.ts';

const COMMANDS = ['probe', 'browser', 'inspect', 'help'] as const;
type Command = (typeof COMMANDS)[number];

function help(): void {
  console.log(`
  Watcher — watches retailers from your own machine, on your own connection.

  npm run probe      Can this machine actually see the three retailers?
                     Opens each in a real Chrome and reports what came back.

  npm run browser    Opens the Watcher's own Chrome profile and waits.
                     Use this to sign in to Target / Walmart / Pokémon Center
                     once. The session persists, and a signed-in browser is
                     treated very differently from a cold one.

  npm run inspect <product-url>
                     Opens one product page and reports everything readable on
                     it — structured data, price, stock, buy buttons — and saves
                     the page, text and a screenshot to probe-artifacts/.
                     This is how the per-retailer readers get written from what
                     the page really contains rather than from guesswork.

  Config: ${CONFIG_PATH}
`);
}

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'help') as Command;

  if (command === 'help' || !COMMANDS.includes(command)) {
    help();
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n  ${(err as Error).message}\n`);
    process.exit(1);
  }

  const browser = new Browser(config);

  try {
    if (command === 'probe') {
      console.log('\n  Opening a real Chrome and visiting each retailer…');
      console.log('  (a window will appear — that is the point; let it work)\n');
      const results = await probeAll(browser);
      console.log(renderProbe(results));
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

    if (command === 'browser') {
      await browser.open();
      const page = await browser.page();
      await page.goto(PROBE_TARGETS[0]!.url).catch(() => {});
      console.log(`
  The Watcher's Chrome profile is open.

  Sign in to the retailers you want watched:
    · https://www.pokemoncenter.com
    · https://www.target.com
    · https://www.walmart.com

  This profile is separate from your everyday Chrome, so it won't fight it and
  won't touch your normal session. Whatever you log into here persists.

  Press Ctrl+C in this terminal when you're done.
`);
      await new Promise(() => {}); // hold the browser open until Ctrl+C
    }
  } catch (err) {
    console.error(`\n  ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    if (command !== 'browser') await browser.close();
  }
}

process.on('SIGINT', () => {
  console.log('\n  stopped.\n');
  process.exit(0);
});

main().catch((err) => {
  console.error('\n  unexpected failure:', err);
  process.exit(1);
});
