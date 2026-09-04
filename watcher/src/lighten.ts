/**
 * Asking the retailer for less of what we never look at.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * A reading is a full page load, and until now that meant every image, font,
 * stylesheet and video on a retail product page — none of which any reader has
 * ever consulted. The readers take their answer from JSON captured off the
 * wire; the pixels were downloaded, decoded, and thrown away.
 *
 * That was tolerable at a few reads an hour. At 3,194 readings a day from one
 * house it was not: on 3 Sep 2026 both Walmart and Target began challenging
 * the household's ORDINARY browsing, and the count the retailer's edge saw was
 * never 3,194 — it was 3,194 times the number of requests in a page.
 *
 * ── The line, which matters more than the saving ────────────────────────────
 *
 * Blocking is by RESOURCE TYPE, and never by who is being asked.
 *
 * Refusing to download pictures and fonts is what every ad-blocker does. It
 * asks LESS of the retailer than we asked yesterday, costs them less to serve,
 * and changes nothing about how we identify ourselves.
 *
 * Refusing to run a named vendor's script — a bot check, a fingerprinter —
 * would be defeating a security control. It is a different act that happens to
 * be implemented with the same function call, and this program does not do it.
 * `scrub.test.ts` pins the same principle for the browser flags; the test
 * beside this pins it here: the list may only ever contain resource TYPES.
 *
 * Scripts and XHR are never blocked, which is not only principle — it is
 * necessary. Target's price is not in the HTML (their own flag says
 * `isProductDetailServerSideRenderPriceEnabled: false`); it arrives over the
 * wire from their API, fetched by their own JavaScript. Block the scripts and
 * there is no reading at all.
 */
import type { BrowserContext } from 'playwright';

/**
 * The resource types a reader has never once consulted.
 *
 * `stylesheet` is here because nothing measures layout — no reader asks
 * whether an element is visible, only what the JSON said. If that ever
 * changes, this is the line to revisit first.
 */
export const BLOCKED_TYPES = ['image', 'media', 'font', 'stylesheet'] as const;

export type BlockedType = (typeof BLOCKED_TYPES)[number];

/** Should this request be refused? Takes the type alone, deliberately. */
export function shouldBlock(resourceType: string): boolean {
  return (BLOCKED_TYPES as readonly string[]).includes(resourceType);
}

/**
 * Refuse the heavy types for every page in this context.
 *
 * Aborted, not fulfilled with an empty body: an abort is the cheapest possible
 * answer and it is honest about what happened. A page that genuinely needs an
 * image to function does not exist in this catalogue — the readers proved it
 * by never looking at one.
 */
export async function blockHeavyResources(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    if (shouldBlock(route.request().resourceType())) {
      route.abort().catch(() => {
        /* a route that closed under us is not an error worth raising */
      });
      return;
    }
    route.continue().catch(() => {});
  });
}
