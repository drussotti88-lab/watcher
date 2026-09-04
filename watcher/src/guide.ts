/**
 * SETUP.md, rendered as a page a person can actually open.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * The zip's instructions were SETUP.md and README.md. On Windows — which is
 * what a tester has — double-clicking a .md file opens the "How do you want to
 * open this file?" dialog, or Notepad with the asterisks and pipe characters
 * still in it. So the written half of the guidance was, in practice, locked in
 * a format the reader could not open, and the only thing actually guiding them
 * was that the launchers are numbered.
 *
 * HTML opens on a double-click on every machine there is. So the same words
 * ship twice: SETUP.md for anyone reading the repository, and START HERE.html
 * for the person who just unzipped it.
 *
 * ONE SOURCE. This renders the markdown rather than restating it, because two
 * hand-written copies of the same instructions drift, and the copy that drifts
 * is always the one the newcomer is reading.
 *
 * ── The subset ──────────────────────────────────────────────────────────────
 *
 * Not a markdown implementation — the markdown in SETUP.md, which is headings,
 * paragraphs, bold, code spans, links, bullet and numbered lists, and one
 * table. Anything outside that is passed through as text rather than guessed
 * at, and the test pins the subset so a future SETUP.md that grows a new
 * construct fails loudly instead of rendering it as literal punctuation.
 */

/** HTML-escape. Runs FIRST, so no markdown output can inject markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Where a code span is parked while the rest of a line is transformed. */
const SLOT = '\u0000';

/**
 * The inline bits, in one pass over already-escaped text.
 *
 * Code spans are taken out first and put back last: a `code span` may hold
 * asterisks and underscores that are not emphasis, and a link whose label is
 * code is common enough in these instructions to matter. The parking slot is
 * a NUL, which cannot survive escapeHtml from real input and so cannot be
 * forged by the document being rendered.
 */
export function inline(text: string): string {
  const code: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, c: string) => {
    code.push('<code>' + c + '</code>');
    return SLOT + (code.length - 1) + SLOT;
  });

  // [label](href) — http(s) only. Anything else is left as written rather
  // than turned into a link to who knows where.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, href: string) =>
      '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>',
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  return out.replace(
    new RegExp(SLOT + '(\\d+)' + SLOT, 'g'),
    (_m, i: string) => code[Number(i)]!,
  );
}

/** One table row's cells, without the leading and trailing pipes. */
function cells(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

const isDivider = (line: string): boolean =>
  /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

/** Markdown to the body of the page. */
export function renderBody(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;

  const closeParagraph = (): void => {
    if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
    para = [];
  };
  const closeList = (): void => {
    if (list) out.push('</' + list + '>');
    list = null;
  };
  const close = (): void => {
    closeParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') {
      close();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      close();
      const level = heading[1]!.length;
      out.push('<h' + level + '>' + inline(heading[2]!) + '</h' + level + '>');
      continue;
    }

    // A table: a header row, a divider, then rows until the block ends.
    if (trimmed.startsWith('|') && isDivider(lines[i + 1]?.trim() ?? '')) {
      close();
      out.push('<div class="scroll"><table><thead><tr>');
      for (const c of cells(trimmed)) out.push('<th>' + inline(c) + '</th>');
      out.push('</tr></thead><tbody>');
      i += 1;
      while ((lines[i + 1]?.trim() ?? '').startsWith('|')) {
        i += 1;
        out.push('<tr>');
        for (const c of cells(lines[i]!.trim())) out.push('<td>' + inline(c) + '</td>');
        out.push('</tr>');
      }
      out.push('</tbody></table></div>');
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      closeParagraph();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out.push('<' + want + '>');
        list = want;
      }
      out.push('<li>' + inline((bullet ?? numbered)![1]!) + '</li>');
      continue;
    }

    // An indented continuation of the list item above it.
    if (list && /^\s+\S/.test(line) && out.length) {
      const last = out.length - 1;
      out[last] = out[last]!.replace(/<\/li>$/, ' ' + inline(trimmed) + '</li>');
      continue;
    }

    closeList();
    para.push(trimmed);
  }

  close();
  return out.join('\n');
}

const STYLE = [
  ":root { color-scheme: dark; --bg:#09080e; --panel:#17161f; --ink:#edebf5;",
  "        --muted:#9b97b0; --accent:#7f77dd; --line:#2a2836; }",
  "* { box-sizing: border-box; }",
  "body { margin:0; background:var(--bg); color:var(--ink); line-height:1.65;",
  "       font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }",
  "main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }",
  "h1,h2,h3,h4 { line-height:1.25; font-weight:600; letter-spacing:-.01em; }",
  "h1 { font-size:2rem; margin:0 0 .5rem; }",
  "h2 { font-size:1.3rem; margin:2.5rem 0 .75rem; padding-top:1.25rem;",
  "     border-top:1px solid var(--line); }",
  "h3 { font-size:1.05rem; margin:1.75rem 0 .5rem; color:var(--accent); }",
  "p, li { color:#d6d3e4; }",
  "a { color:var(--accent); }",
  "strong { color:var(--ink); }",
  "code { font-family:'DM Mono',ui-monospace,'Cascadia Mono',Consolas,monospace;",
  "       font-size:.9em; background:var(--panel); border:1px solid var(--line);",
  "       border-radius:4px; padding:.1em .35em; color:#cfc9f2; }",
  "ul, ol { padding-left:1.35rem; }",
  "li { margin:.3rem 0; }",
  ".scroll { overflow-x:auto; margin:1rem 0; }",
  "table { border-collapse:collapse; width:100%; font-size:.94rem; }",
  "th, td { text-align:left; padding:.6rem .7rem; border-bottom:1px solid var(--line);",
  "         vertical-align:top; }",
  "th { color:var(--muted); font-weight:600; font-size:.82rem; text-transform:uppercase;",
  "     letter-spacing:.06em; }",
  ".tag { display:inline-block; margin-bottom:2rem; padding:.3rem .6rem; font-size:.78rem;",
  "       color:var(--muted); background:var(--panel); border:1px solid var(--line);",
  "       border-radius:999px; font-family:'DM Mono',ui-monospace,monospace; }",
  "@media (max-width:600px) { main { padding:2rem 1rem 4rem; } h1 { font-size:1.6rem; } }",
].join('\n');

/** The whole page. `version` is the build this zip came from, or ''. */
export function renderGuide(markdown: string, version = ''): string {
  const tag =
    version && version !== 'dev'
      ? '<div class="tag">version ' + escapeHtml(version) + '</div>'
      : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Phantom — start here</title>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600&family=DM+Mono&display=swap" rel="stylesheet">',
    '<style>',
    STYLE,
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    tag,
    renderBody(markdown),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
