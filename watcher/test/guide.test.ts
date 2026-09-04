/**
 * The instructions, in a format the reader can open.
 *
 * SETUP.md is the source of truth for a tester's first hour. On Windows,
 * double-clicking a .md file offers a "How do you want to open this?" dialog
 * — so the words were there and the reader could not read them. This renders
 * the same file to HTML, which double-clicks everywhere.
 *
 * The point of the tests below is not that a markdown renderer works. It is
 * that THIS document renders: every construct SETUP.md actually uses is
 * covered, and the last test reads the real file so that a future edit
 * introducing something new fails here rather than in front of a tester.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderBody, renderGuide, inline, escapeHtml } from '../src/guide.ts';

const SETUP = resolve(import.meta.dirname, '..', 'SETUP.md');

test('headings, paragraphs and the emphasis this document uses', () => {
  const html = renderBody(
    '# Setting up Phantom\n\nA line **in bold** and one with `a code span`.\n' +
      'A second line of the same paragraph.\n\n## What this is\n',
  );
  assert.match(html, /<h1>Setting up Phantom<\/h1>/);
  assert.match(html, /<h2>What this is<\/h2>/);
  assert.match(html, /<strong>in bold<\/strong>/);
  assert.match(html, /<code>a code span<\/code>/);
  // Wrapped prose is one paragraph, not two. SETUP.md is hard-wrapped at 79
  // columns throughout, so getting this wrong would break every paragraph.
  assert.match(html, /<p>A line <strong>in bold<\/strong>[^<]*<code>a code span<\/code>\. A second line/);
});

test('numbered steps stay numbered, and bullets stay bullets', () => {
  const html = renderBody(
    '1. First thing.\n2. Second thing.\n\n- A point\n- Another point\n',
  );
  assert.match(html, /<ol>\s*<li>First thing\.<\/li>\s*<li>Second thing\.<\/li>\s*<\/ol>/);
  assert.match(html, /<ul>\s*<li>A point<\/li>\s*<li>Another point<\/li>\s*<\/ul>/);
  assert.equal(/<ol>[\s\S]*<ol>/.test(html), false, 'one list, not one per item');
});

test('an indented continuation belongs to the step above it', () => {
  // SETUP.md wraps its numbered steps. A continuation line that started its
  // own paragraph would put half a sentence outside the list.
  const html = renderBody(
    '1. **9 — Sign in to Target.** A Chrome window opens on target.com. Sign in to\n' +
      '   your own Target account there.\n2. Set a cap.\n',
  );
  assert.match(html, /<li><strong>9 — Sign in to Target\.<\/strong>[^<]*your own Target account there\.<\/li>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test('the troubleshooting table becomes a table that can scroll', () => {
  const html = renderBody(
    '| What you see | What it means |\n|---|---|\n' +
      '| `npm is not recognised` | Node isn\'t installed. |\n' +
      '| A gap in the log | It batches what it sends. |\n',
  );
  assert.match(html, /<div class="scroll"><table>/);
  assert.match(html, /<th>What you see<\/th>/);
  assert.match(html, /<td><code>npm is not recognised<\/code><\/td>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, 'a header row and two body rows');
  assert.equal(/\|/.test(html.replace(/<[^>]+>/g, '')), false, 'no raw pipes left in the text');
});

test('links are rendered, and only to the web', () => {
  assert.match(
    inline('Get it from [nodejs.org](https://nodejs.org) today'),
    /<a href="https:\/\/nodejs\.org" target="_blank" rel="noopener">nodejs\.org<\/a>/,
  );
  // A javascript: or file: target is left as written rather than made
  // clickable. The document is trusted; the rule is cheap and permanent.
  const odd = inline('[click](javascript:alert(1))');
  assert.equal(/<a /.test(odd), false);
});

test('MARKUP IN THE DOCUMENT IS TEXT, NEVER MARKUP', () => {
  // The renderer escapes before it does anything else, so a document that
  // grows an angle bracket cannot silently become part of the page.
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  const html = renderBody('Set `"live": true` and mind the <b>tags</b>.\n');
  assert.match(html, /&lt;b&gt;tags&lt;\/b&gt;/);
  assert.equal(/<b>/.test(html), false);
  assert.match(html, /<code>&quot;live&quot;: true<\/code>/);
});

test('a code span holding asterisks is left alone', () => {
  const html = inline('run `*.bat` not **this**');
  assert.match(html, /<code>\*\.bat<\/code>/);
  assert.match(html, /<strong>this<\/strong>/);
});

test('the page is self-contained, themed, and titled', () => {
  const page = renderGuide('# Setting up Phantom\n', 'abc1234');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>Phantom — start here<\/title>/);
  assert.match(page, /<meta name="viewport"/, 'it gets read on a phone');
  assert.match(page, /version abc1234/, 'which build this zip came from');
  assert.match(page, /--bg:#09080e/, 'the Phantom palette, not a browser default');
  // Nothing to fetch but a font: a tester may open this before installing
  // anything, and an instruction page that needs the network to be legible
  // is one that fails exactly when setup is going wrong.
  const external = [...page.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]!);
  for (const url of external) {
    assert.match(url, /^https:\/\/fonts\.(googleapis|gstatic)\.com/, `unexpected fetch: ${url}`);
  }
  assert.equal(/<script/i.test(page), false, 'no scripts in a document that is read, not run');

  // A development checkout has no single version, so it claims none.
  assert.equal(/version/.test(renderGuide('# x\n', 'dev')), false);
  assert.equal(/version/.test(renderGuide('# x\n', '')), false);
});

test('THE REAL SETUP.MD RENDERS, WHOLE', () => {
  const md = readFileSync(SETUP, 'utf8');
  const page = renderGuide(md, 'abc1234');

  // The things a tester must be able to find.
  for (const phrase of [
    'Setting up Phantom',
    '1 — Set up',
    '2 — Start watching',
    '9 — Sign in to Target',
    '10 — Send a report',
    'What it will not do',
  ]) {
    assert.ok(page.includes(phrase), `the guide lost "${phrase}"`);
  }

  // Nothing left as raw markdown punctuation in the reader's face. This is
  // the check that catches SETUP.md growing a construct the renderer does
  // not know: a blockquote, a fenced block, an image.
  const text = page
    .slice(page.indexOf('<main>'))
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '');
  assert.equal(/\*\*/.test(text), false, 'unrendered bold left in the text');
  assert.equal(/^\s*[-*]\s/m.test(text), false, 'unrendered bullet left in the text');
  assert.equal(/^\s*#/m.test(text), false, 'unrendered heading left in the text');
  assert.equal(/^\s*\|/m.test(text), false, 'unrendered table row left in the text');
  assert.equal(/```/.test(text), false, 'a fenced code block — teach the renderer about it');
  assert.equal(/\]\(http/.test(text), false, 'unrendered link left in the text');
});
