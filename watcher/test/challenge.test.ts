/**
 * Challenge detection.
 *
 * Every "healthy page" case below is a regression test. The first version of
 * this detector matched the bare word "akamai" anywhere in raw HTML, which
 * flags every page served through Akamai's CDN — i.e. all of Walmart. It
 * reported a working retailer as blocked, and we nearly believed it.
 *
 * A detector that cries wolf on healthy pages is worse than no detector,
 * because it makes you abandon something that was fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectChallenge, isQueue, isQueueUrl, queueScope } from '../src/challenge.ts';

// -------------------------------------------------------------- healthy pages

test('a normal retail page mentioning its CDN is NOT a challenge', () => {
  const title = 'Pokémon Trading Cards - Walmart.com';
  const text = `
    Pokémon Trading Cards
    Mega Evolution Elite Trainer Box
    $49.99
    Add to cart
    Free shipping on orders over $35
  `;
  // The markup would be full of akamaihd.net script tags — but we read text.
  const { challenged, reason } = detectChallenge(title, text);
  assert.equal(challenged, false, `false positive: ${reason}`);
});

test('a product page that says "access denied" in unrelated copy is not a challenge', () => {
  const text = `
    Account access denied? Reset your password here.
    Mega Charizard Figure  $39.99  In stock
  `;
  assert.equal(detectChallenge('Pokémon Center', text).challenged, false);
});

test('a page about robots the toy is not a robot check', () => {
  const text = 'Transformers Robot Action Figure. Are you a fan of robots? In stock. $24.99';
  assert.equal(detectChallenge('Robots | Target', text).challenged, false);
});

test('a page mentioning a waiting list is not a waiting room', () => {
  const text = 'Join the waiting list to be notified. Add to cart. $59.99';
  assert.equal(detectChallenge('Product | Pokémon Center', text).challenged, false);
});

test('an empty page is not a challenge — it is just empty', () => {
  // With no markup handed over there is no evidence either way, and guessing
  // "blocked" from an absence would stand us down on every caller that reads
  // title and text alone. The blank-page wall below needs the markup.
  assert.equal(detectChallenge('', '').challenged, false);
});

// ------------------------------------------------------------- real challenges

test('Cloudflare interstitial is caught by its title', () => {
  const c = detectChallenge('Just a moment...', 'Checking your browser before accessing.');
  assert.equal(c.challenged, true);
  assert.match(c.reason, /Cloudflare/);
});

test('Cloudflare JS-required page is caught by its text', () => {
  const c = detectChallenge('www.pokemoncenter.com', 'Enable JavaScript and cookies to continue');
  assert.equal(c.challenged, true);
});

test('a genuine Akamai denial needs both halves and is caught', () => {
  const c = detectChallenge(
    'Access Denied',
    'Access Denied. You don\'t have permission to access this resource. Reference #18.abcd1234',
  );
  assert.equal(c.challenged, true);
  assert.match(c.reason, /Access denied/);
});

test('press-and-hold needs the human/robot context to count', () => {
  const real = detectChallenge('', 'Press & Hold to confirm you are a human');
  assert.equal(real.challenged, true);

  // A furniture assembly instruction should not trip it.
  const notReal = detectChallenge('', 'Press and hold the button for 3 seconds to reset');
  assert.equal(notReal.challenged, false);
});

test('a Queue-it waiting room is caught', () => {
  assert.equal(
    detectChallenge('Waiting Room', 'You are now in line. Your place in line is 4,182.').challenged,
    true,
  );
});

test('unusual-traffic blocks are caught', () => {
  assert.equal(
    detectChallenge('', 'We have detected unusual traffic from your network.').challenged,
    true,
  );
});

test('a CAPTCHA prompt is caught', () => {
  assert.equal(detectChallenge('', "Please confirm you're not a robot").challenged, true);
});

test('detection reads title and text, never raw markup', () => {
  // If this were matched against HTML, the script URL alone would trip it.
  const html = '<script src="https://ak.walmartimages.com/akamai/bundle.js"></script>';
  assert.equal(detectChallenge('Walmart.com', html).challenged, false);
});

test('a queue is told apart from a wall — they demand opposite reactions', () => {
  assert.equal(isQueue('Queue-it waiting room'), true);
  assert.equal(isQueue('Walmart waiting room'), true);
  assert.equal(isQueue('CAPTCHA'), false);
  assert.equal(isQueue('Cloudflare challenge'), false);
  assert.equal(isQueue('Access denied'), false);
  assert.equal(isQueue(''), false);
});

// ── Walmart's own waiting room ───────────────────────────────────────────────
//
// Walmart does not use Queue-it and says none of Queue-it's words. Every
// phrasing below was landing as "the page could not be read" — a failure row,
// at the exact minute of a drop, for the loudest signal a retailer gives.

test("WALMART'S WAITING ROOM IS A QUEUE, NOT AN UNREADABLE PAGE", () => {
  for (const text of [
    "You're in line. Estimated wait: 12 minutes.",
    'You are in line to shop this event.',
    'Hold my spot and keep shopping',
    'Your spot in line is being held.',
    'Estimated wait 20 minutes — you will be let in line shortly.',
  ]) {
    const { challenged, reason } = detectChallenge('Walmart.com', text);
    assert.equal(challenged, true, text);
    assert.equal(isQueue(reason), true, text);
  }
});

test('the curly apostrophe the page actually serves is matched', () => {
  // The page serves U+2019; every developer types U+0027. Matching only the
  // one you can type is how this fails silently on the night.
  const { reason } = detectChallenge('', 'You\u2019re in line');
  assert.equal(isQueue(reason), true);
});

test('A HEALTHY WALMART PRODUCT PAGE IS NOT A QUEUE', () => {
  // The akamai lesson, kept. A detector that cries wolf on a working page is
  // worse than none: it would skip every other Walmart check in the pass and
  // shout "a drop is live" at a shelf that has not moved.
  const pdp =
    'Pokemon Trading Card Game Scarlet and Violet Elite Trainer Box. ' +
    'Sold and shipped by Walmart.com. Arrives by Fri, Sep 11. ' +
    'Estimated delivery wait time 3 to 5 business days. Add to cart. ' +
    'Free 90-day returns. In stock at your store.';
  const { challenged } = detectChallenge('Pokemon TCG - Walmart.com', pdp);
  assert.equal(challenged, false);
});

test('a press-and-hold on the queue door is a wall, not a waiting room', () => {
  // Both markers on one page. The bot check is the half this code will not
  // touch, so it has to win: naming it a queue would tell the pacer to keep
  // knocking at a door a person has to open.
  const { challenged, reason } = detectChallenge(
    'Robot or human?',
    "You're in line. Press and hold to verify you are human.",
  );
  assert.equal(challenged, true);
  assert.equal(reason, 'Press-and-hold check');
  assert.equal(isQueue(reason), false);
});

// ── Walls that render nothing ────────────────────────────────────────────────

/** The real thing, trimmed: what Pokémon Center served at 16:50 on 1 Sep 2026. */
const IMPERVA_HTML =
  '<html style="height:100%"><head><meta name="ROBOTS" content="NOINDEX, NOFOLLOW">' +
  '<script src="/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C" async=""></script>' +
  "<script type=\"text/javascript\">if (sessionStorage) { sessionStorage.setItem('distil_referrer', document.referrer); }</script>" +
  '</head><body style="margin:0px;height:100%">' +
  '<iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31&amp;xinfo=28-51753973-0"></iframe></body></html>';

test('AN IMPERVA WALL IS A CHALLENGE, NOT A MISSING PRODUCT', () => {
  // For six hours this read as "no schema.org Product on the page" — true,
  // useless, and it kept the pacer knocking every 45 seconds at a door that
  // had just been shut. A wall has to be named as one so we stand down.
  const { challenged, reason } = detectChallenge('', '', IMPERVA_HTML);
  assert.equal(challenged, true);
  assert.equal(reason, 'Imperva bot wall');
});

test('a wall is a wall, not a queue — no shouting about a drop', () => {
  assert.equal(isQueue('Imperva bot wall'), false);
  assert.equal(isQueue('blank page — blocked or hung'), false);
});

test('A REAL PAGE MENTIONING THE VENDOR IS NOT A WALL', () => {
  // The akamai lesson, kept. A marker in the markup of a page that renders
  // proves nothing — vendors are on everything. The guard is that the page is
  // EMPTY, not that the string is present.
  const html = '<script src="/_Incapsula_Resource?x=1"></script><body>...</body>';
  const text = 'Pokémon TCG: Mega Evolution Elite Trainer Box\n$59.99\nOut of stock\n'.repeat(20);
  assert.equal(detectChallenge('Mega Evolution ETB | Pokémon Center', text, html).challenged, false);
});

test('a page that arrives with nothing on it says so, rather than guessing', () => {
  const { challenged, reason } = detectChallenge('', '', '<html><head></head><body></body></html>');
  assert.equal(challenged, true);
  assert.equal(reason, 'blank page — blocked or hung');
});

test('a slow but real page is not called blank', () => {
  // A product page that has a title has arrived, however little text it has
  // rendered so far. Calling that blocked would stand us down at exactly the
  // wrong moment.
  assert.equal(detectChallenge('Mega Evolution ETB | Pokémon Center', '', '<html>' + 'x'.repeat(400) + '</html>').challenged, false);
});

test('a big empty-looking page is not called blank either', () => {
  // 20k of markup with no text is a heavy app that has not painted yet, not a
  // wall. The wall we saw was a kilobyte.
  const html = '<html><body>' + '<div class="a"></div>'.repeat(2000) + '</body></html>';
  assert.equal(detectChallenge('', '', html).challenged, false);
});

// ── Walmart's bot check, captured live ───────────────────────────────────────

/** walmart.com/blocked, 8:04pm on 2 Sep 2026. Verbatim. */
const WALMART_BLOCKED =
  'Robot or human?\n\nActivate and hold the button to confirm that you’re human. Thank You!\n\n' +
  'Terms of Use Privacy Policy Do Not Sell My Personal Information Request My Personal Information\n\n' +
  '©2026 Walmart Stores, Inc.';

test("WALMART SAYS ACTIVATE AND HOLD, NOT PRESS AND HOLD", () => {
  // Missing this is worse than missing the queue. An unnamed wall does not
  // stand the pacer down, so we keep knocking at a door that just shut — which
  // is how a soft block becomes a hard one.
  const { challenged, reason } = detectChallenge('Robot or human?', WALMART_BLOCKED);
  assert.equal(challenged, true);
  assert.equal(reason, 'Press-and-hold check');
  assert.equal(isQueue(reason), false);
});

test('the title alone is enough, and only when it starts the title', () => {
  assert.equal(detectChallenge('Robot or human?', '').challenged, true);
  // Ordinary copy that happens to contain the phrase is not a wall.
  assert.equal(
    detectChallenge('Toy review: robot or human?', 'A fun build for kids.').challenged,
    false,
  );
});

// ── The queue we actually caught ─────────────────────────────────────────────
//
// 8:13pm, 2 Sep 2026. Opening a Walmart product page during the drop
// REDIRECTED to /qp with the queue state in the query string, while the
// document title stayed "Walmart | Save Money. Live better." the whole time.
// The address bar was the only place the page said what it was.

/** Verbatim, trimmed of the image URL. */
const REAL_QUEUE_URL =
  'https://www.walmart.com/qp?qpdata=%7B%22queued%22%3Atrue%2C%22queue%22%3A%22q011b513268044%22' +
  '%2C%22url%22%3A%22https%3A%2F%2Fq-api.www.walmart.com%2FissueTicket%3Fqueue%3Dq011b513268044%22' +
  '%2C%22customMetadata%22%3A%7B%22item%22%3A%7B%22itemID%22%3A%2220243261734%22%7D%7D%7D';

/** Verbatim body text of that page. */
const REAL_QUEUE_TEXT =
  'Skip to Main Content\nCancel\n$0.00\nSign in to join the line\n\n' +
  "Once you're in line, we'll hold your spot and let you know when it's your turn.\n\n" +
  'Sign in to join the line\nPokemon Trading Card Games Mega Evolution 5 Pitch Black Booster ' +
  "Bundle\n$31.97\n\nDon't have an account?\n\nCreate account";

test('THE REAL WALMART QUEUE IS CAUGHT BY ITS URL', () => {
  assert.equal(isQueueUrl(REAL_QUEUE_URL), true);
  const { challenged, reason } = detectChallenge(
    'Walmart | Save Money. Live better.',
    REAL_QUEUE_TEXT,
    '',
    REAL_QUEUE_URL,
  );
  assert.equal(challenged, true);
  assert.equal(reason, 'Walmart queue redirect');
  assert.equal(isQueue(reason), true);
});

test('and by its text alone, with no URL to help', () => {
  // Belt and braces. Copy gets rewritten; a state machine does not. But if the
  // URL ever stops carrying it, the words still have to work.
  const { challenged, reason } = detectChallenge('Walmart | Save Money. Live better.', REAL_QUEUE_TEXT);
  assert.equal(challenged, true);
  assert.equal(isQueue(reason), true);
});

test('THE TITLE IS USELESS HERE, WHICH IS THE WHOLE POINT', () => {
  // The queue page's title is Walmart's ordinary homepage title. Anything that
  // leaned on the title would have called this a normal page.
  assert.equal(
    detectChallenge('Walmart | Save Money. Live better.', 'Shop deals on toys today.').challenged,
    false,
  );
});

test('an ordinary Walmart URL is not a queue', () => {
  assert.equal(isQueueUrl('https://www.walmart.com/ip/20243261734'), false);
  assert.equal(isQueueUrl('https://www.walmart.com/qp'), false);
  // queued:false is a real state and means the opposite.
  assert.equal(isQueueUrl('https://www.walmart.com/qp?qpdata=%7B%22queued%22%3Afalse%7D'), false);
  assert.equal(isQueueUrl(''), false);
  // A product whose slug happens to contain "qp".
  assert.equal(isQueueUrl('https://www.walmart.com/ip/qp-brand-cards/12345'), false);
});

test('a mangled qpdata still calls the queue rather than missing it', () => {
  // Truncated by a redirect chain, or reshaped next season. Missing a drop
  // over a JSON parse is the worse failure.
  assert.equal(isQueueUrl('https://www.walmart.com/qp?qpdata=%7B%22queued%22%3Atrue%2C%22que'), true);
});

test('A WALMART QUEUE IS ONE ITEM; A QUEUE-IT ROOM IS THE WHOLE SHOP', () => {
  // Captured 2 Sep 2026: Walmart's redirect carries one itemID and the queue
  // id is tied to it. The pass used to skip every other Walmart check on a
  // queue sighting, on the premise that every page was behind the same door.
  // That premise is Queue-it's, not Walmart's.
  assert.equal(queueScope('Queue-it waiting room'), 'site');
  assert.equal(queueScope('Walmart waiting room'), 'item');
  assert.equal(queueScope('Walmart queue redirect'), 'item');
});
