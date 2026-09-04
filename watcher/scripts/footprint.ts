/**
 * What does one reading actually COST the retailer — and us?
 *
 * ── The question ────────────────────────────────────────────────────────────
 *
 * On 3 Sep 2026 this system made 3,194 readings in a day from one house, and
 * both Walmart and Target began putting a press-and-hold in front of the
 * household's ordinary browsing. We slowed the readings down. But a "reading"
 * is a full page load in real Chrome — the HTML, every script, every image,
 * every analytics beacon — so the number the retailer's edge counted was never
 * 3,194. It was 3,194 times whatever THIS prints.
 *
 * Nothing in browser.ts or read.ts intercepts a single request today. That is
 * the thing worth measuring before changing, because "block the images" is
 * either a rounding error or the whole ballgame, and guessing which is how you
 * end up with a clever change that bought nothing.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Reads one product page twice — once exactly as Phantom does, once with the
 * heavy resource types refused — and prints requests, bytes and time for each,
 * side by side, with the READING ITSELF from both runs so you can see whether
 * refusing them costs any accuracy. It should not: the readers take their
 * answer from JSON captured off the wire, never from a rendered pixel.
 *
 * ── The line this draws, deliberately ───────────────────────────────────────
 *
 * Blocking is by RESOURCE TYPE — image, font, media, stylesheet — and never by
 * who is being asked. That distinction is the whole ethics of it. Refusing to
 * download pictures is what every ad-blocker on earth does and it asks LESS of
 * the retailer, not more. Refusing to run a specific vendor's bot-detection
 * script would be defeating a security control, which is a different act
 * wearing similar clothes, and this program does not do it.
 *
 *   npm run footprint [url]
 *
 * Two page loads. Run it on a cold address without worrying.
 */
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { readListing } from '../src/read.ts';
import { BLOCKED_TYPES, blockHeavyResources } from '../src/lighten.ts';

/** The Chaos Rising ETB — in stock at Target as of 3 Sep, so a real reading. */
const DEFAULT_URL =
  'https://www.target.com/p/-/A-95267143';

const url = process.argv[2] ?? DEFAULT_URL;
const tcin = /\/A-(\w+)/i.exec(url)?.[1] ?? '';
const retailer = url.includes('walmart.com')
  ? 'Walmart'
  : url.includes('pokemoncenter.com')
    ? 'Pokemon Center'
    : 'Target';

interface Tally {
  requests: number;
  bytes: number;
  byType: Map<string, { n: number; bytes: number }>;
}

function tally(): Tally {
  return { requests: 0, bytes: 0, byType: new Map() };
}

function note(t: Tally, type: string, bytes: number): void {
  t.requests += 1;
  t.bytes += bytes;
  const row = t.byType.get(type) ?? { n: 0, bytes: 0 };
  row.n += 1;
  row.bytes += bytes;
  t.byType.set(type, row);
}

function kb(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'mb' : Math.round(n / 1000) + 'kb';
}

/**
 * One reading, counted.
 *
 * The counting is attached to the CONTEXT rather than the page, because a
 * page's own listeners miss requests made by frames it opens — and a retail
 * PDP is full of them.
 */
async function measure(lighten: boolean): Promise<{ t: Tally; ms: number; reading: unknown }> {
  const config = loadConfig();
  // A throwaway profile per run, so a warm cache cannot flatter the second
  // run and make blocking look better than it is.
  config.browser.watchProfileDir = `./chrome-profile-fp-${lighten ? 'light' : 'full'}`;
  const browser = new Browser(config, 'watch');
  const t = tally();

  try {
    const context = await browser.open();
    if (lighten) await blockHeavyResources(context);

    context.on('response', (res) => {
      const type = res.request().resourceType();
      // The header, not the body: reading every body to weigh it would change
      // what we are measuring. Absent on a chunked response, hence the || 0 —
      // so bytes is a floor, and the real figure is worse.
      const len = Number(res.headers()['content-length'] ?? 0);
      note(t, type, Number.isFinite(len) ? len : 0);
    });

    const started = Date.now();
    const reading = await readListing(browser, retailer, tcin, url);
    return { t, ms: Date.now() - started, reading };
  } finally {
    await browser.close();
  }
}

function report(label: string, t: Tally, ms: number): void {
  console.log(`\n  ${label}`);
  console.log(`    ${t.requests} requests · ${kb(t.bytes)} · ${ms}ms`);
  const rows = [...t.byType.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [type, row] of rows) {
    console.log(`      ${type.padEnd(12)} ${String(row.n).padStart(4)}  ${kb(row.bytes)}`);
  }
}

function summarise(reading: any): string {
  return [
    reading.state,
    reading.price === null || reading.price === undefined ? 'no price' : '$' + reading.price,
    reading.confidence,
    reading.sellerKind ?? '',
    reading.challenged ? 'CHALLENGED: ' + reading.challengeReason : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

console.log(`\n  Reading ${retailer} ${tcin} twice — once as Phantom does, once lightened.`);
console.log(`  Blocking, when on: ${BLOCKED_TYPES.join(', ')} — by TYPE, never by vendor.\n`);

const full = await measure(false);
report('AS IT IS TODAY', full.t, full.ms);
console.log(`    reading: ${summarise(full.reading)}`);

const light = await measure(true);
report('WITH HEAVY TYPES REFUSED', light.t, light.ms);
console.log(`    reading: ${summarise(light.reading)}`);

const dropped = full.t.requests - light.t.requests;
const saved = full.t.bytes - light.t.bytes;
console.log(`
  ── The difference ──────────────────────────────────────────────────────

    requests   ${full.t.requests} → ${light.t.requests}   (${dropped} fewer, ${
      full.t.requests ? Math.round((dropped / full.t.requests) * 100) : 0
    }%)
    bytes      ${kb(full.t.bytes)} → ${kb(light.t.bytes)}
    time       ${full.ms}ms → ${light.ms}ms

    Same answer? ${summarise(full.reading) === summarise(light.reading) ? 'YES' : 'NO — do not ship this'}

    At 3,194 readings a day, today's page costs about ${(
      (full.t.requests * 3194) /
      1000
    ).toFixed(0)}k requests.
    Lightened, about ${((light.t.requests * 3194) / 1000).toFixed(0)}k.
`);
