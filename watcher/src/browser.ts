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

export class Browser {
  private context: BrowserContext | null = null;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async open(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const dir = resolve(process.cwd(), this.config.browser.profileDir);
    mkdirSync(dir, { recursive: true });

    try {
      this.context = await chromium.launchPersistentContext(dir, {
        channel:
          this.config.browser.channel === 'chromium' ? undefined : this.config.browser.channel,
        ...(this.config.browser.executablePath
          ? { executablePath: this.config.browser.executablePath }
          : {}),
        headless: !this.config.browser.headed,
        viewport: { width: 1366, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
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
    return this.context;
  }

  async page(): Promise<Page> {
    const ctx = await this.open();
    const existing = ctx.pages();
    return existing.length > 0 ? existing[0]! : ctx.newPage();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
  }
}
