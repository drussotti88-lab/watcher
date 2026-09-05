/**
 * Surviving a browser that goes away.
 *
 * Written after Phantom spent five hours reporting "1 checked" every
 * ninety seconds while every single check failed with
 *
 *   browserContext.newPage: Target page, context or browser has been closed
 *
 * Chrome had closed — the machine slept, or a window got shut — and the cached
 * context stayed cached forever. Each failure was reported honestly, which is
 * the only reason it was noticeable at all; the loop itself never recovered.
 *
 * These drive the real class with a stand-in Playwright, because the bug was
 * in the caching, not in Playwright.
 */
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.ts';
import { DEFAULTS } from '../src/config.ts';

/** A context that can be closed, and tells its listeners when it is. */
function fakeContext() {
  const listeners: Array<() => void> = [];
  let closed = false;
  const pages: unknown[] = [];
  return {
    closed: () => closed,
    on(event: string, fn: () => void) {
      if (event === 'close') listeners.push(fn);
    },
    setDefaultNavigationTimeout() {},
    // The real context takes routes; Browser.open now installs one for
    // neverTouch and for the heavy resource types. A stand-in that does not
    // model it fails with "this.context.route is not a function", which is
    // the stand-in being wrong rather than the code.
    routes: [] as unknown[],
    async route(pattern: unknown, handler: unknown) {
      this.routes.push({ pattern, handler });
    },
    pages: () => (closed ? [] : pages),
    async newPage() {
      if (closed) throw new Error('browserContext.newPage: Target page, context or browser has been closed');
      const page = { id: pages.length };
      pages.push(page);
      return page;
    },
    async close() {
      closed = true;
      for (const fn of listeners) fn();
    },
    /** Chrome dying without the context being closed politely. */
    die() {
      closed = true;
    },
  };
}

/** A Browser whose launch is ours, so no Chrome is ever started. */
function browserWith(contexts: ReturnType<typeof fakeContext>[]): Browser {
  const b = new Browser({ ...DEFAULTS, browser: { ...DEFAULTS.browser, headed: false } }, 'watch');
  let i = 0;
  // The launch is the only part that touches Playwright; everything the tests
  // care about is the caching around it.
  (b as unknown as { launch: () => Promise<unknown> }).launch = async () => {
    const ctx = contexts[Math.min(i, contexts.length - 1)];
    i += 1;
    return ctx;
  };
  return b;
}

test('A CLOSED BROWSER IS REOPENED, NOT CACHED FOREVER', async () => {
  const first = fakeContext();
  const second = fakeContext();
  const b = browserWith([first, second]);

  await b.page();
  await first.close();

  // The whole bug: this used to throw for the rest of the process's life.
  const page = await b.page();
  assert.ok(page, 'a new page on a fresh context');
  assert.equal(second.pages().length, 1, 'and it came from the replacement');
});

test('a browser that dies without saying so is still recovered from', async () => {
  // The close event is the main defence; this is the race where Chrome is
  // gone but nobody told us before the next call.
  const first = fakeContext();
  const second = fakeContext();
  const b = browserWith([first, second]);

  await b.page();
  first.die();

  const page = await b.page();
  assert.ok(page);
  assert.equal(second.pages().length, 1);
});

test('a healthy browser is reused, not relaunched every check', async () => {
  // The other failure mode: a new Chrome per check is both slow and a good
  // way to look like a bot.
  const only = fakeContext();
  const b = browserWith([only]);

  await b.page();
  await b.page();
  await b.page();
  assert.equal(only.pages().length, 1, 'one page, reused');
});

test('an error that is not about a closed browser is not retried away', async () => {
  // Retrying a real fault would hide it behind a second identical failure.
  const ctx = fakeContext();
  const b = browserWith([ctx]);
  ctx.newPage = async () => {
    throw new Error('net::ERR_NAME_NOT_RESOLVED');
  };

  await assert.rejects(() => b.page(), /ERR_NAME_NOT_RESOLVED/);
});

// ── Launch flags ─────────────────────────────────────────────────────────────

test('THE RENDERER SANDBOX IS NOT TRADED AWAY', async () => {
  // Playwright disables it by default for a persistent context and Chrome says
  // so in a yellow bar. This browser visits real retailer pages on a real
  // desktop, and the sibling profile holds payment details.
  const src = await readFile(new URL('../src/browser.ts', import.meta.url), 'utf8');
  assert.match(src, /chromiumSandbox:\s*true/);
  // Quoted, so this matches the flag as an argument and not the sentence in
  // the comment above it explaining why we do not pass it.
  assert.ok(
    !/['"`]--no-sandbox['"`]/.test(src),
    'nothing here should be passing --no-sandbox as an argument',
  );
});

test('the crash-restore bubble is suppressed', async () => {
  // It does not block automation, but it sits over the page and it is a
  // standing signal that something exited badly.
  const src = await readFile(new URL('../src/browser.ts', import.meta.url), 'utf8');
  assert.match(src, /--hide-crash-restore-bubble/);
});
