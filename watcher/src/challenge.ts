/**
 * Is this page a challenge, or the page we asked for?
 *
 * Pure string work on purpose: no browser, no network, so every false positive
 * we have ever hit can be pinned down by a test. The one that mattered matched
 * the bare word "akamai" in raw HTML — Walmart serves everything through
 * Akamai, so every healthy page looked blocked and we nearly abandoned a
 * retailer that was working fine.
 */
/**
 * Challenge detection.
 *
 * Read against the page TITLE and its VISIBLE TEXT — never raw HTML. The first
 * version of this matched the bare word "akamai" anywhere in the markup, which
 * flags every page served through Akamai's CDN, i.e. all of Walmart. A detector
 * that cries wolf on healthy pages is worse than none, because it makes you
 * abandon a retailer that was working fine.
 */
const CHALLENGE_PATTERNS: { name: string; test: (title: string, text: string) => boolean }[] = [
  {
    name: 'Cloudflare challenge',
    test: (t, x) =>
      /^just a moment/i.test(t.trim()) ||
      /checking your browser before accessing/i.test(x) ||
      /enable javascript and cookies to continue/i.test(x),
  },
  {
    name: 'Access denied',
    // Both halves required. "Access denied" alone shows up in unrelated copy.
    test: (t, x) =>
      /access denied/i.test(`${t} ${x}`) && /reference\s*#|error\s*reference/i.test(x),
  },
  {
    name: 'Press-and-hold check',
    test: (_t, x) => /press\s*(?:&|and)\s*hold/i.test(x) && /human|robot|verify/i.test(x),
  },
  {
    name: 'Queue-it waiting room',
    test: (t, x) =>
      /you are now in line|your place in line|waiting room/i.test(x) || /^waiting room/i.test(t),
  },
  {
    name: 'Robot check',
    test: (_t, x) =>
      /(verify (?:you are|you're) (?:a )?human|are you a robot|unusual traffic from your)/i.test(x),
  },
  {
    name: 'CAPTCHA',
    test: (_t, x) =>
      /(complete the (?:security )?check|solve the puzzle)/i.test(x) ||
      // Both phrasings. Guarded by the pronoun so "are you a fan of robots?"
      // on a toy listing doesn't trip it.
      /\b(?:i'?m|you'?re|you are)\s+not\s+a\s+robot\b/i.test(x),
  },
];

export interface Challenge {
  challenged: boolean;
  reason: string;
}

/** Is this a challenge page rather than a real one? Title + visible text only. */
export function detectChallenge(title: string, visibleText: string): Challenge {
  const text = visibleText.slice(0, 8000);
  for (const { name, test } of CHALLENGE_PATTERNS) {
    if (test(title, text)) return { challenged: true, reason: name };
  }
  return { challenged: false, reason: '' };
}
