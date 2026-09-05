/**
 * The browser. One place, so nothing else in Phantom knows about Playwright.
 *
 * The point of this whole component is that it is a *real* browser on a *real*
 * residential connection. It isn't imitating a legitimate visitor — it is one.
 * So there is deliberately nothing here that patches fingerprints, spoofs
 * signals, or hides automation. If a retailer decides not to serve us, the
 * answer is to back off, not to argue.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { hostsFrom, isBlocked } from './nevertouch.ts';
import { BLOCKED_TYPES, shouldBlock } from './lighten.ts';
import { resolve } from 'node:path';
import type { Config } from './config.ts';

export { detectChallenge, isQueue, type Challenge } from './challenge.ts';
export {
  readWhenReady,
  settleRead,
  type PageRead,
  type SettleOpts,
  type TextSource,
} from './settle.ts';

/**
 * Which browser this is.
 *
 * 'watch' is signed out and does all the polling. 'buy' is signed in and opens
 * rarely. Keeping them apart is what stops the high-volume half putting the
 * account that holds your payment details at risk.
 */
export type Persona = 'watch' | 'buy';

export class Browser {
  private context: BrowserContext | null = null;
  private readonly config: Config;
  private readonly persona: Persona;

  /**
   * Somewhere to say that Chrome went away and came back.
   *
   * This used to be invisible, and invisible is how it cost five hours: the
   * context died, every check failed identically, and the loop went on
   * reporting "1 checked" all evening. The recovery below is the fix; this
   * hook is what makes the recovery *legible* afterwards, which is a different
   * requirement and the one a log exists to serve.
   */
  onEvent: (level: 'info' | 'warn', message: string) => void = () => {};

  constructor(config: Config, persona: Persona = 'watch') {
    this.config = config;
    this.persona = persona;
  }

  get profileDir(): string {
    return this.persona === 'buy'
      ? this.config.browser.buyProfileDir
      : this.config.browser.watchProfileDir;
  }

  /**
   * Start Chrome. The only part that touches Playwright, and therefore the
   * only part the recovery tests have to stand in for.
   */
  protected async launch(dir: string): Promise<BrowserContext> {
    return chromium.launchPersistentContext(dir, {
      channel:
        this.config.browser.channel === 'chromium' ? undefined : this.config.browser.channel,
      ...(this.config.browser.executablePath
        ? { executablePath: this.config.browser.executablePath }
        : {}),
      headless: !this.config.browser.headed,
      viewport: { width: 1366, height: 900 },
      /*
       * ── Extensions: on for the buy profile, off for the watch profile ────
       *
       * Playwright passes --disable-extensions by default. The watch profile
       * keeps that: signed out, three retailers all day, fewer moving parts.
       * The buy profile drops it, because it is the one a person signs into
       * and finishes a checkout in, and a password manager there is the
       * reason card details never pass through this code. Whatever is
       * installed there during `npm run signin` runs, and nothing here
       * inspects or lists it — owner's call, 3 Sep 2026. Extensions only run
       * headed; the buy profile already is.
       */
      ...(this.persona === 'buy' ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      // ── The sandbox stays on ──────────────────────────────────────────────
      //
      // Playwright turns it off by default for a persistent context, and
      // Chrome says so in a yellow bar: "you are using an unsupported
      // command-line flag: --no-sandbox. Stability and security will suffer."
      //
      // This browser visits real retailer pages on a real desktop, and the
      // sibling profile holds payment details. Trading the renderer sandbox
      // for a slightly easier launch is the wrong way round.
      chromiumSandbox: true,
      args: [
        // ── What is NOT in this list ────────────────────────────────────────
        //
        // `--disable-blink-features=AutomationControlled` was here until
        // 1 Sep 2026. Its only function is to stop Chrome setting
        // navigator.webdriver, which is to say its only function is to make
        // this browser harder to recognise as automated.
        //
        // That is the one thing this project said it would not do, and it was
        // sitting in the launch args the whole time. Removed on sight.
        //
        // It was not even working. Target served a press-and-hold check on the
        // buy profile that evening regardless — and Chrome announces the flag
        // in a yellow bar across the top of every page, so a setting meant to
        // hide something was the most visible thing on the screen.
        //
        // Expect more challenges without it, not fewer. That is the honest
        // state of things: this system watches politely, waits when it is told
        // to wait, and asks a person when a shop asks for one. Nothing here
        // pretends to be something it is not.
        //
        // "Restore pages? Chrome didn't shut down correctly."
        //
        // It appears because the profile was not closed cleanly, which for a
        // long time meant *I* had killed the process rather than asking it to
        // stop. The bubble is browser UI rather than page content, so it does
        // not block automation — input goes to the renderer — but it sits over
        // the page, it is in the way when you drive the browser by hand, and
        // it is a standing signal that something exited badly. Suppressed
        // here; the cause is fixed by the stop file in index.ts.
        '--hide-crash-restore-bubble',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  }

  async open(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const dir = resolve(process.cwd(), this.profileDir);
    mkdirSync(dir, { recursive: true });

    try {
      this.context = (await this.launch(dir)) as BrowserContext;
    } catch (err) {
      const msg = (err as Error).message;
      const channel = this.config.browser.channel;

      // Two different failures wear the same error text, and telling someone to
      // "switch to chromium" when they already are is worse than no advice.
      if (/executable doesn't exist|channel/i.test(msg)) {
        if (channel === 'chromium') {
          throw new Error(
            `Playwright's bundled Chromium isn't installed.\n` +
              `  Run:  npx playwright install chromium\n` +
              `  Or set browser.channel to "chrome" in watcher.config.json to use\n` +
              `  the Chrome you already have — no download, and a real browser.`,
          );
        }
        throw new Error(
          `Could not launch ${channel} — it doesn't look installed.\n` +
            `  Install it, or set browser.channel to "chromium" in\n` +
            `  watcher.config.json and run:  npx playwright install chromium`,
        );
      }

      if (/profile.*in use|cannot create.*singleton|failed to create/i.test(msg)) {
        throw new Error(
          `That Chrome profile is already open in another process.\n` +
            `  Phantom keeps its own profile at ${dir} — if you have a window\n` +
            `  open from "npm run browser", close it and try again.`,
        );
      }
      throw err;
    }

    this.context.setDefaultNavigationTimeout(this.config.browser.navigationTimeoutMs);

    // A closed browser must not be a permanent one.
    //
    // Chrome goes away for reasons that have nothing to do with us: the
    // machine sleeps, someone closes the window, the profile gets cleaned up.
    // Without this the cached context stays cached, every later check dies on
    // "Target page, context or browser has been closed", and Phantom goes
    // on reporting "1 checked" every ninety seconds for hours — busy, honest
    // about each failure, and producing nothing. Observed doing exactly that.
    this.context.on('close', () => {
      this.context = null;
      this.onEvent('warn', 'Chrome closed — the next check will start a fresh one');
    });

    // ── What this browser will and will not ask for ────────────────────
    //
    // Enforced HERE rather than in the watch loop, because here is the one
    // place every request in this program goes through: missions, sweeps,
    // probes, one-off diagnostic scripts and `npm run browser` alike. A rule
    // that has to be remembered by each caller is a rule with a hole in it.
    //
    // ONE handler for both rules, deliberately. Playwright matches routes in
    // reverse registration order and a handler that calls continue() ends the
    // chain — so two separate '**/*' routes would mean the second silently
    // disabling the first. Two rules, one gate.
    const refuse = hostsFrom(this.config.neverTouch);
    const lighten = this.config.lightenReads !== false;

    if (refuse.length > 0 || lighten) {
      await this.context.route('**/*', (route) => {
        const request = route.request();

        // 1. Sites we have been told not to contact at all. Nothing about
        //    this is evasion — it is asking for nothing.
        if (refuse.length > 0 && isBlocked(request.url(), refuse)) {
          route.abort('blockedbyclient').catch(() => {});
          return;
        }

        // 2. The heavy resource types no reader has ever consulted. By TYPE
        //    and never by vendor — see lighten.ts for why that line matters.
        if (lighten && shouldBlock(request.resourceType())) {
          route.abort().catch(() => {});
          return;
        }

        route.continue().catch(() => {});
      });
    }

    if (refuse.length > 0) {
      console.log(`  not contacting: ${refuse.join(', ')}  (neverTouch in watcher.config.json)`);
    }
    if (lighten) console.log(`  not downloading: ${BLOCKED_TYPES.join(', ')}`);

    return this.context;
  }

  async page(): Promise<Page> {
    try {
      return await this.newPage();
    } catch (err) {
      // The close event is the main defence; this catches the race where the
      // browser dies between opening it and using it. One retry, on a
      // genuinely fresh context — if that fails too, the error is real.
      if (!/closed|disconnected|crashed/i.test((err as Error).message)) throw err;
      this.onEvent('warn', `Chrome had gone (${(err as Error).message}) — starting a fresh one`);
      this.context = null;
      return this.newPage();
    }
  }

  private async newPage(): Promise<Page> {
    const ctx = await this.open();
    const existing = ctx.pages();
    return existing.length > 0 ? existing[0]! : ctx.newPage();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
  }
}
