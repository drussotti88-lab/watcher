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

import { detectChallenge } from '../src/challenge.ts';

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
