/**
 * The browser. One place, so nothing else in the Watcher knows about Playwright.
 *
 * The point of this whole component is that it is a *real* browser on a *real*
 * residential connection. It isn't imitating a legitimate visitor — it is one.
 * So there is deliberately nothing here that patches fingerprints, spoofs
 * signals, or hides automation. If a retailer decides not to serve us, the
 * answer is to back off, not to argue.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.ts';

export { detectChallenge, type Challenge } from './challenge.ts';
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
      args: ['--disable-blink-features=AutomationControlled'],
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
            `  The Watcher keeps its own profile at ${dir} — if you have a window\n` +
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
    // "Target page, context or browser has been closed", and the Watcher goes
    // on reporting "1 checked" every ninety seconds for hours — busy, honest
    // about each failure, and producing nothing. Observed doing exactly that.
    this.context.on('close', () => {
      this.context = null;
    });

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
