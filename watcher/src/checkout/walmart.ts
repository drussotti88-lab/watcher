/**
 * Walmart's queue, and the cart behind it.
 *
 * ── What is known, and what is not ──────────────────────────────────────────
 *
 * Known, because it was captured live at 8:13pm on 2 Sep 2026 during a drop:
 * opening a product page redirects to `/qp?qpdata={"queued":true,...}`, the
 * document title stays "Walmart | Save Money. Live better.", and the page's
 * only action — SIGNED OUT — is "Sign in to join the line", above the sentence
 * "Once you're in line, we'll hold your spot and let you know when it's your
 * turn."
 *
 * NOT known: what that page looks like signed IN. Nobody has seen it. The
 * button presumably becomes a join rather than a sign-in, and everything after
 * it — the wait, the "your turn" state, the checkout timer — is unobserved.
 *
 * So every selector below starts `verified: false`, and `find()` refuses to
 * click an unverified one. This is the same discipline `checkout/target.ts`
 * went through: its place-order button was located, boxed, photographed and
 * approved before anything clicked it, and it was right to insist. The one
 * place never to guess is the one where money moves.
 *
 * ── The line this file does not cross ───────────────────────────────────────
 *
 * Joining a queue and waiting in it is the front door, used as designed.
 * Getting PAST one is not: no ticket forged against q-api, no bot check
 * answered, no press-and-hold automated. When a challenge appears, this stops
 * and hands the machine back to a person. That is not a limitation to be
 * engineered around later — it is the shape of the thing.
 */
import type { Page } from 'playwright';

export interface SelectorSpec {
  candidates: readonly string[];
  /**
   * Has a person seen this match the real element on a real page?
   *
   * False means the code may LOOK for it and report what it found, and may
   * never click it. Promoted one at a time, from a capture, by hand.
   */
  verified: boolean;
}

export const WALMART_SELECTORS = {
  /**
   * The control that takes a place in line.
   *
   * Signed out the page renders "Sign in to join the line"; the signed-in
   * wording is unobserved, so every phrasing anyone has reported is a
   * candidate and none of them is trusted yet. `Hold my spot and keep
   * shopping` comes from a public post about the same queue.
   */
  joinLine: {
    candidates: [
      'button:has-text("Join the line")',
      'button:has-text("Hold my spot")',
      'button:has-text("Get in line")',
      'button:has-text("Continue")',
      '[data-testid="queue-join"]',
    ],
    verified: false,
  },
  /** Shown while holding a place. Read only — nothing clicks this. */
  queuePosition: {
    candidates: ['[data-testid="queue-position"]', 'text=/your (place|spot) in line/i'],
    verified: false,
  },
  addToCart: {
    candidates: [
      '[data-automation-id="atc"]',
      'button:has-text("Add to cart")',
      '[data-testid="add-to-cart-section"] button',
    ],
    verified: false,
  },
  checkoutButton: {
    candidates: ['[data-automation-id="checkout-btn"]', 'button:has-text("Continue to checkout")'],
    verified: false,
  },
  placeOrder: {
    candidates: ['[data-automation-id="place-order"]', 'button:has-text("Place order")'],
    verified: false,
  },
} as const;

export type WalmartStep = keyof typeof WALMART_SELECTORS;

/**
 * Where in the queue are we?
 *
 * Read from the URL first and the words second, for the reason the detector
 * learned tonight: the URL is a state machine and the copy is a marketing
 * decision.
 */
export type QueueState =
  /** Redirected to /qp with queued:true. A place has not been taken yet. */
  | 'queued'
  /** The page wants a sign-in before it will hold a place. */
  | 'needs-signin'
  /** A bot check. A person's job, always. */
  | 'challenged'
  /** An ordinary product page: either through the queue, or there never was one. */
  | 'product'
  /** Something we have never seen. Capture it and stop. */
  | 'unknown';

export function queueStateFrom(url: string, text: string, challenged: boolean): QueueState {
  if (challenged) return 'challenged';
  const queued = /\/qp\b/.test(url) && /%22queued%22%3Atrue|"queued"\s*:\s*true/i.test(url);
  if (queued) {
    // The distinction that decides whether this can proceed at all. Signed
    // out, the queue page offers a sign-in and nothing else — there is no
    // place to take.
    return /sign in to join|sign in to hold/i.test(text) ? 'needs-signin' : 'queued';
  }
  if (/add to cart|out of stock|sold out/i.test(text)) return 'product';
  return 'unknown';
}

/**
 * Is this browser actually signed in?
 *
 * Asked rather than assumed, because the whole flow depends on it and the
 * failure is silent: a signed-out profile reaches the queue page, finds a
 * sign-in button, and sits there politely until the drop is over.
 */
export async function looksSignedIn(page: Page): Promise<boolean> {
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    if (/sign in to join|create account/i.test(text)) return false;
    // Walmart's header greets an account by name and offers "Sign in" when it
    // has none. Both phrasings checked, neither trusted alone.
    return !/\bSign\s*in\b/i.test(text.slice(0, 1200));
  } catch {
    return false;
  }
}

export class WalmartStepError extends Error {
  readonly step: WalmartStep;
  constructor(step: WalmartStep, detail: string) {
    super(`walmart step "${step}": ${detail}`);
    this.name = 'WalmartStepError';
    this.step = step;
  }
}

/**
 * Find a control, and refuse to hand back an unverified one for clicking.
 *
 * `intent: 'read'` locates and reports. `intent: 'click'` throws unless a
 * person has promoted the selector. The two are separate arguments rather than
 * two functions so that every call site has to say, out loud, which it is
 * doing.
 */
export async function findControl(
  page: Page,
  step: WalmartStep,
  intent: 'read' | 'click',
): Promise<{ selector: string; found: boolean }> {
  const spec: SelectorSpec = WALMART_SELECTORS[step];
  if (intent === 'click' && !spec.verified) {
    throw new WalmartStepError(
      step,
      'selector is not verified yet — it has never been matched against a real page by a person, ' +
        'and this is not the place to find out',
    );
  }
  for (const selector of spec.candidates) {
    const n = await page.locator(selector).count().catch(() => 0);
    if (n > 0) return { selector, found: true };
  }
  return { selector: '', found: false };
}
