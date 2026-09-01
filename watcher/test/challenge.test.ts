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

import { detectChallenge, isQueue } from '../src/challenge.ts';

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
  assert.equal(isQueue('CAPTCHA'), false);
  assert.equal(isQueue('Cloudflare challenge'), false);
  assert.equal(isQueue('Access denied'), false);
  assert.equal(isQueue(''), false);
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
