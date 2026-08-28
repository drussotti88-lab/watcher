/**
 * Local configuration. A file, not environment variables — this is a desktop
 * app, and a file you can open and read is friendlier than a shell you have to
 * remember to set up.
 *
 * watcher.config.json is gitignored. It holds your Hub token; treat it the way
 * you'd treat a saved password.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  hub: {
    /** e.g. https://half-a-hub.you.workers.dev — blank runs standalone. */
    url: string;
    token: string;
  };
  browser: {
    /**
     * 'chrome' uses your installed Chrome — no download, and a real browser
     * rather than a bundled Chromium. Falls back to 'chromium' if you'd rather
     * Playwright manage it.
     */
    channel: 'chrome' | 'msedge' | 'chromium';
    /**
     * A dedicated profile directory. Deliberately NOT your everyday profile:
     * Chrome locks a profile to one process, and you don't want this fighting
     * your browser. Log in to the retailers once, here, and it persists.
     */
    profileDir: string;
    /** Watch it work. Strongly recommended until you trust it. */
    headed: boolean;
    /**
     * Only needed if Chrome is somewhere unusual and `channel` can't find it.
     * Blank means: let Playwright locate it.
     */
    executablePath: string;
    navigationTimeoutMs: number;
  };
  budget: {
    perRun: number;
    perDay: number;
  };
  /**
   * The master switch. False means every flow runs to completion and stops
   * immediately before submitting an order. Leave it false until you have
   * watched a dry run do the right thing.
   */
  live: boolean;
  /** Seconds between sweeps in `watch` mode. */
  intervalSec: number;
}

export const DEFAULTS: Config = {
  hub: { url: '', token: '' },
  browser: {
    channel: 'chrome',
    profileDir: './chrome-profile',
    headed: true,
    executablePath: '',
    navigationTimeoutMs: 45_000,
  },
  budget: { perRun: 150, perDay: 400 },
  live: false,
  intervalSec: 90,
};

export const CONFIG_PATH = resolve(process.cwd(), 'watcher.config.json');

function merge(base: Config, over: Partial<Config>): Config {
  return {
    hub: { ...base.hub, ...(over.hub ?? {}) },
    browser: { ...base.browser, ...(over.browser ?? {}) },
    budget: { ...base.budget, ...(over.budget ?? {}) },
    live: over.live ?? base.live,
    intervalSec: over.intervalSec ?? base.intervalSec,
  };
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No watcher.config.json found.\n` +
        `  Copy watcher.config.example.json to watcher.config.json and fill it in.`,
    );
  }
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  } catch (err) {
    throw new Error(`watcher.config.json is not valid JSON: ${(err as Error).message}`);
  }
  const config = merge(DEFAULTS, parsed);

  // Fail loudly on a nonsensical budget rather than discovering it at 3am.
  if (!(config.budget.perRun > 0) || !(config.budget.perDay > 0)) {
    throw new Error('budget.perRun and budget.perDay must both be positive numbers');
  }
  if (config.budget.perRun > config.budget.perDay) {
    throw new Error(
      `budget.perRun (${config.budget.perRun}) is larger than budget.perDay ` +
        `(${config.budget.perDay}) — the daily cap would never bind`,
    );
  }
  if (config.live && !config.hub.url) {
    throw new Error(
      'live is true but no hub.url is set. Spending requires the Hub to authorise it.',
    );
  }
  return config;
}
