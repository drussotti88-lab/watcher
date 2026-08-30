/**
 * Getting a second person running.
 *
 * The interactive half is three lines and untestable; everything worth being
 * sure about — what a pasted address becomes, what the config ends up saying,
 * and what each kind of failure is called — is pure and lives here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanUrl, cleanToken, configFrom, checkHub } from '../src/setup.ts';

const EXAMPLE = JSON.stringify({
  hub: { url: '', token: '' },
  browser: { channel: 'chrome', headed: true, watchProfileDir: './chrome-profile-watch' },
  budget: { perRun: 150, perDay: 400 },
  live: false,
  intervalSec: 90,
});

test('a pasted address is tidied rather than rejected', () => {
  assert.equal(cleanUrl('  https://hub.example.app/  '), 'https://hub.example.app');
  assert.equal(cleanUrl('"https://hub.example.app"'), 'https://hub.example.app');
  assert.equal(cleanUrl('https://hub.example.app///'), 'https://hub.example.app');
});

test('an address with no scheme becomes https, never http', () => {
  // The token travels in a header on this request. Defaulting to http would
  // send it in clear text to whatever is listening.
  assert.equal(cleanUrl('hub.example.app'), 'https://hub.example.app');
  assert.equal(cleanUrl('http://hub.example.app'), 'http://hub.example.app');
});

test('an empty address stays empty rather than becoming https://', () => {
  assert.equal(cleanUrl(''), '');
  assert.equal(cleanUrl('   '), '');
});

test('a token pasted with quotes still works', () => {
  assert.equal(cleanToken(' "abc123" '), 'abc123');
  assert.equal(cleanToken('abc123\n'), 'abc123');
});

test('the config keeps every other setting from the example', () => {
  const written = JSON.parse(
    configFrom(EXAMPLE, { url: 'https://hub.example.app', token: 'the-token' }),
  );
  assert.deepEqual(written.hub, { url: 'https://hub.example.app', token: 'the-token' });
  // The point: setup writes the two answers and touches nothing else. A setup
  // step that quietly resets the budget or turns `live` on would be a menace.
  assert.equal(written.live, false);
  assert.equal(written.budget.perRun, 150);
  assert.equal(written.browser.channel, 'chrome');
});

const answers = { url: 'https://hub.example.app', token: 'the-token' };

test('a working token is reported as connected, and says how many missions', async () => {
  const fake = async () =>
    new Response(JSON.stringify({ missions: [{ id: 1 }, { id: 2 }] }), {
      headers: { 'content-type': 'application/json' },
    });
  const res = await checkHub(answers, fake as unknown as typeof fetch);
  assert.equal(res.ok, true);
  assert.match(res.message, /2 missions/);
});

test('an empty watchlist is a success, not a failure', async () => {
  // A new account has no missions. Telling somebody their setup failed because
  // they have not added a product yet is how you get a support conversation.
  const fake = async () =>
    new Response(JSON.stringify({ missions: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  const res = await checkHub(answers, fake as unknown as typeof fetch);
  assert.equal(res.ok, true);
  assert.match(res.message, /no missions yet/);
});

test('a rejected token is named as a token problem', async () => {
  const fake = async () => new Response('no', { status: 401 });
  const res = await checkHub(answers, fake as unknown as typeof fetch);
  assert.equal(res.ok, false);
  assert.match(res.message, /did not recognise the token/);
});

test('a wrong address is named as an address problem', async () => {
  // 404 means something answered but it was not a Hub. Saying "bad token"
  // here would send them looking in exactly the wrong place.
  const fake = async () => new Response('not found', { status: 404 });
  const res = await checkHub(answers, fake as unknown as typeof fetch);
  assert.equal(res.ok, false);
  assert.match(res.message, /wrong address/);
});

test('an unreachable Hub is distinguished from a rejecting one', async () => {
  const fake = async () => {
    throw new Error('getaddrinfo ENOTFOUND hub.example.app');
  };
  const res = await checkHub(answers, fake as unknown as typeof fetch);
  assert.equal(res.ok, false);
  assert.match(res.message, /Could not reach/);
});
