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
const CHALLENGE_PATTERNS: {
  name: string;
  test: (title: string, text: string, html: string) => boolean;
}[] = [
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
    // ── Walmart says "activate", not "press" ────────────────────────────────
    //
    // Captured live at 8:04pm on 2 Sep 2026 from walmart.com/blocked, title
    // "Robot or human?", body "Activate and hold the button to confirm that
    // you're human." Matching only "press and hold" missed it, so every
    // Walmart bot check has been landing as an unreadable page — which means
    // the pacer never stood down and we kept knocking at a door that had just
    // been shut. The same failure as the waiting room, in the other direction:
    // there we shouted nothing, here we stood down for nothing.
    name: 'Press-and-hold check',
    test: (t, x) =>
      (/(?:press|activate|tap|click)\s*(?:&|and)\s*hold/i.test(x) &&
        /human|robot|verify/i.test(x)) ||
      // Walmart's own title for the page, on its own. Anchored, because "robot
      // or human" is a perfectly ordinary phrase in the middle of a sentence.
      /^robot or human/i.test(t.trim()),
  },
  // ── Waiting rooms ─────────────────────────────────────────────────────────
  //
  // Two vendors, two vocabularies, one meaning: everybody is being made to
  // wait because something is dropping.
  //
  // These sit BELOW the bot checks deliberately. A page carrying both a queue
  // and a press-and-hold is a queue whose door has a human check on it, and
  // the check is the part this code will not touch — so it must name itself
  // the wall and hand the page to a person, not report a waiting room the
  // machine believes it can sit in.
  {
    name: 'Queue-it waiting room',
    test: (t, x) =>
      /you are now in line|your place in line|waiting room/i.test(x) || /^waiting room/i.test(t),
  },
  {
    // Walmart runs its own waiting room rather than Queue-it, and says none of
    // the words above. On a Wednesday drop it reads "You're in line", offers
    // "Hold my spot and keep shopping", and gives an estimated wait — none of
    // which the Queue-it pattern matches, so the loudest signal Walmart ever
    // gives us was landing as an unreadable page.
    //
    // The apostrophe is a character class because the page serves a curly one
    // and every developer types a straight one.
    name: 'Walmart waiting room',
    test: (t, x) =>
      /(?:you\s*['\u2018\u2019]?\s*re|you are)\s+(?:now\s+)?in\s+line/i.test(x) ||
      /hold my spot/i.test(x) ||
      /your (?:place|spot) in line/i.test(x) ||
      // An estimated wait alone is a delivery date. Paired with a line, it is a
      // queue.
      (/estimated wait|wait time/i.test(x) && /\b(?:line|queue)\b/i.test(x)) ||
      /in line|waiting room/i.test(t),
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
  // ── Walls that render nothing at all ──────────────────────────────────────
  //
  // Everything above reads the page a person would see. These two exist for
  // the case where there IS no page: on 1 Sep 2026 Pokémon Center went behind
  // Imperva, and what came back was an empty body wrapping an interstitial
  // iframe. No title, no text, nothing to match — so a wall read as "no
  // schema.org Product on the page", which is true, useless, and made the
  // pacer keep knocking every forty-five seconds at a door that had just been
  // shut in our face.
  //
  // These are the only patterns allowed to look at raw HTML, and both are
  // guarded by the page being EMPTY. That guard is the akamai lesson kept:
  // a marker in the markup of a page that renders normally proves nothing,
  // because vendors are everywhere. A marker on a page with no content is the
  // page.
  {
    name: 'Imperva bot wall',
    test: (_t, x, h) =>
      x.trim().length < 200 && /_Incapsula_Resource|distil_referrer|Incapsula incident/i.test(h),
  },
  {
    name: 'blank page — blocked or hung',
    // Deliberately last. Anything above names the wall; this one only says
    // that nothing arrived, which is still far better than inventing a reading
    // from an empty document. Standing down is the right answer either way:
    // if we are blocked, knocking harder makes it worse, and if the site is
    // broken, there is nothing to read.
    //
    // `h.length > 0` is load-bearing: called with title and text alone — as
    // the older tests do, and as any caller that has not got the markup does —
    // an empty read means "nothing was passed", not "nothing arrived". Only
    // markup we were actually handed can be evidence of a blank page.
    test: (t, x, h) => t.trim() === '' && x.trim().length < 40 && h.length > 0 && h.length < 20_000,
  },
];

export interface Challenge {
  challenged: boolean;
  reason: string;
}

/**
 * Is this challenge a waiting room rather than a wall?
 *
 * The two demand opposite reactions. A block means "you have been noticed —
 * go away for a while", and standing down is the only polite answer. A queue
 * means "everyone is being made to wait because something is DROPPING", and
 * standing down for half an hour is walking out of the store at the exact
 * moment the doors opened. The queue is the loudest early signal a retailer
 * ever gives us; callers use this to shout instead of retreat.
 *
 * Joining a queue and waiting like anyone else is the front door, used as
 * designed. What the design still refuses is getting *past* one — bot checks
 * and CAPTCHAs at the queue's end are a person's job, never this code's.
 */
const QUEUE_REASONS = new Set([
  'Queue-it waiting room',
  'Walmart waiting room',
  'Walmart queue redirect',
]);

/**
 * Is this URL Walmart's waiting room?
 *
 * Captured live at 8:13pm on 2 Sep 2026. Walmart does not overlay a queue on
 * the product page; it REDIRECTS to
 *
 *     https://www.walmart.com/qp?qpdata={"queued":true,"queue":"q011b...", ...}
 *
 * and the document title stays "Walmart | Save Money. Live better." the whole
 * time. So the page carries its state in the address bar and nowhere a title
 * matcher can see it.
 *
 * That makes the URL the honest detector and the text a fallback. Text is
 * copy — it gets rewritten by a marketing team on a Tuesday. `queued:true` in
 * a query parameter is a state machine, and it is the same string whether the
 * page says "in line", "hold tight", or nothing at all.
 */
export function isQueueUrl(url: string): boolean {
  if (!/\/qp\b/.test(url)) return false;
  try {
    const raw = new URL(url).searchParams.get('qpdata');
    if (!raw) return false;
    return JSON.parse(raw)?.queued === true;
  } catch {
    // Malformed, truncated, or shaped differently than the night we captured
    // it. Falling back to the substring is right: we would rather call a queue
    // on a page that has `"queued":true` in its address than miss a drop over
    // a JSON parse.
    return /["']?queued["']?\s*[:=]\s*true/i.test(url) || /%22queued%22%3Atrue/i.test(url);
  }
}

export function isQueue(reason: string): boolean {
  return QUEUE_REASONS.has(reason);
}

/**
 * Does this queue stand in front of the whole shop, or one item?
 *
 * Queue-it's waiting room is a front door: every page on the site sits
 * behind it, so reading a second page proves nothing and the pass should
 * move on. Walmart's is not. Captured live on 2 Sep 2026: the redirect
 * carried one `itemID` in its `qpdata` and the queue id was tied to it. Other
 * Walmart listings load normally while one is queued — so skipping the rest
 * of the shop on a Walmart queue throws away readings that were there for
 * the taking, at the exact minute they matter.
 */
export function queueScope(reason: string): 'site' | 'item' {
  return reason === 'Queue-it waiting room' ? 'site' : 'item';
}

/**
 * Is this a challenge page rather than a real one?
 *
 * Title and visible text carry every pattern that describes something a person
 * could read. `html` is passed for the two at the bottom of the list, which
 * exist because a wall can arrive with nothing readable on it at all — and it
 * is only ever consulted when the visible page is empty.
 */
export function detectChallenge(
  title: string,
  visibleText: string,
  html = '',
  url = '',
): Challenge {
  // Before any pattern. The address bar is the only place Walmart's queue
  // announces itself reliably, and a queue named early is a queue that never
  // gets mistaken for the blank-page pattern at the bottom of the list.
  if (url && isQueueUrl(url)) return { challenged: true, reason: 'Walmart queue redirect' };
  const text = visibleText.slice(0, 8000);
  for (const { name, test } of CHALLENGE_PATTERNS) {
    if (test(title, text, html)) return { challenged: true, reason: name };
  }
  return { challenged: false, reason: '' };
}
