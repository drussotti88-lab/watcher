/**
 * Reading a whole category in one request.
 *
 * Written against a real captured search response, six SKUs of it, because the
 * whole value of this reader is that it sorts a live catalogue into "worth
 * aiming at" and "noise" — and you cannot tell whether it does that from a
 * fixture you invented to make it pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  readTargetSearch,
  searchProducts,
  classify,
  rankScan,
  searchMeta,
  thumbnail,
  searchUrl,
  type ScanRow,
} from '../src/readers/target-search.ts';
import {
  renderScan,
  candidates,
  toDiscovered,
  renderDiscover,
  type ScanResult,
} from '../src/scan.ts';

const body = JSON.parse(
  readFileSync(new URL('./fixtures/target-search.json', import.meta.url), 'utf8'),
);

/** The day the capture was taken. The street dates are 18 days out. */
const CAPTURE_DAY = Date.parse('2026-08-29T12:00:00Z');

const rows = readTargetSearch([body]);
const byTcin = (t: string): ScanRow => rows.find((r) => r.tcin === t)!;

// ── Reading ──────────────────────────────────────────────────────────────────

test('every search result is read, not just the first page of one module', () => {
  assert.equal(rows.length, 6);
});

test('a result carries everything a decision needs, from one request', () => {
  // The point of the whole file: this is what twenty-eight product-page visits
  // would have cost, and it came back in one.
  const box = byTcin('1010892076');
  assert.equal(box.name, 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box');
  assert.equal(box.price, 69.99);
  assert.equal(box.state, 'out');
  assert.equal(box.availableQuantity, 0);
  assert.equal(box.releaseDate, '2026-09-16');
  assert.equal(box.seller.kind, 'retailer');
  assert.equal(box.outOfStockInAllStores, true);
  assert.match(box.url, /A-1010892076$/);
});

test('THE RECOMMENDATION CAROUSEL IS NOT A SEARCH RESULT', () => {
  // A Target search page carries carousels of thirty other products, each with
  // a price and a fulfilment block. A walk that looks for "things shaped like a
  // product" swallows them, and the scan then recommends aiming at whatever
  // Target felt like advertising. This mistake has already been made once, in
  // apisniff.ts, which is why the anchor is search_response.products.
  const polluted = {
    data_source_modules: body.data_source_modules,
    recommendations: {
      products: [
        { tcin: '99999999', item: { product_description: { title: 'Not a result' } } },
      ],
    },
  };
  const read = readTargetSearch([polluted]);
  assert.equal(read.length, 6);
  assert.ok(!read.some((r) => r.tcin === '99999999'), 'a carousel item got in');
});

test('the same product in two modules is read once', () => {
  const twice = readTargetSearch([body, body]);
  assert.equal(twice.length, 6);
});

test('searchProducts returns nothing rather than throwing on a shapeless body', () => {
  assert.deepEqual(searchProducts(null), []);
  assert.deepEqual(searchProducts({ nothing: 'here' }), []);
  assert.deepEqual(searchProducts('a string'), []);
});

// ── Sorting the catalogue ────────────────────────────────────────────────────

test('AN UNRELEASED TARGET BOX OUTRANKS A RESELLER WITH STOCK', () => {
  // The judgement the whole scan exists to make. Three of these results are in
  // stock right now and every one of them is a reseller at three to five times
  // MSRP; the two that matter cannot be bought at any price yet.
  const ranked = rankScan(rows, CAPTURE_DAY);
  const signals = ranked.map((v) => v.signal);

  assert.equal(signals[0], 'buyable', "Target's own in-stock item comes first");
  assert.deepEqual(signals.slice(1, 3), ['scheduled', 'scheduled']);
  assert.deepEqual(signals.slice(3), ['resale', 'resale', 'resale']);
});

test('a reseller is called a reseller even though it is the only thing in stock', () => {
  const v = classify(byTcin('1011202516'), CAPTURE_DAY);
  assert.equal(v.signal, 'resale');
  assert.match(v.why, /BlueProton/);
  assert.equal(v.row.state, 'in', 'and it genuinely is in stock — that is the trap');
});

test('STOCK IN A STORE WHILE THE SITE SAYS NO IS THE SIGNAL WE ARE HUNTING', () => {
  // If a drop is ever visible before it opens, this is the shape it takes:
  // Target counting units at a nearby store while refusing to sell online.
  // Every capture so far says true, which is exactly why this is measured on
  // every scan rather than argued about.
  const landed: ScanRow = { ...byTcin('1010892076'), outOfStockInAllStores: false, storeQuantity: 12 };
  const v = classify(landed, CAPTURE_DAY);

  assert.equal(v.signal, 'in-stores');
  assert.match(v.why, /a store has it \(12 at the nearest\)/);
});

test('a pre-release allocation held at a store counts the same way', () => {
  const held: ScanRow = { ...byTcin('1010892076'), preOrderStoreQuantity: 36 };
  const v = classify(held, CAPTURE_DAY);
  assert.equal(v.signal, 'in-stores');
  assert.match(v.why, /36 held as pre-release allocation/);
});

test('store stock ranks above a date, because it is happening now', () => {
  const landed: ScanRow = { ...byTcin('1010892076'), outOfStockInAllStores: false };
  const ranked = rankScan([...rows, landed].filter((r, i, a) => a.indexOf(r) === i), CAPTURE_DAY);
  const first = ranked.find((v) => v.signal === 'in-stores');
  const scheduled = ranked.findIndex((v) => v.signal === 'scheduled');
  assert.ok(first, 'the landed row should be classified in-stores');
  assert.ok(ranked.indexOf(first!) < scheduled, 'and sort above a mere date');
});

test('a street date that has come and gone is flagged, not forgotten', () => {
  // The state that means "the drop happened and we missed it, or it slipped".
  // Either way it is worth a different word from "scheduled".
  const v = classify(byTcin('1010892076'), Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(v.signal, 'overdue');
  assert.match(v.why, /has passed and it is still not in stock/);
});

test('the day itself gets its own word', () => {
  const v = classify(byTcin('1010892076'), Date.parse('2026-09-16T09:00:00Z'));
  assert.equal(v.signal, 'due-today');
});

test('an out-of-stock item with no date announced is quiet, not urgent', () => {
  const v = classify({ ...byTcin('1010892076'), releaseDate: null }, CAPTURE_DAY);
  assert.equal(v.signal, 'quiet');
  assert.match(v.why, /no date announced/);
});

test('a quantity at the order limit is reported as a floor, not a count', () => {
  // atp is min(stock, purchase_limit), so "20" against a limit of 20 means at
  // least twenty. Reporting it as twenty would understate a pallet.
  const capped: ScanRow = { ...byTcin('94725169'), availableQuantity: 20, orderLimit: 20 };
  assert.match(classify(capped, CAPTURE_DAY).why, /at least 20 \(the order limit\)/);

  const real: ScanRow = { ...byTcin('94725169'), availableQuantity: 9, orderLimit: 20 };
  assert.match(classify(real, CAPTURE_DAY).why, /9 left/);
});

test('THE SAME DATA RANKS THE SAME WAY TWICE', () => {
  // A scan you cannot diff against yesterday's is half a tool, and an unstable
  // sort makes every run look like something changed.
  const a = rankScan(rows, CAPTURE_DAY).map((v) => v.row.tcin);
  const b = rankScan([...rows].reverse(), CAPTURE_DAY).map((v) => v.row.tcin);
  assert.deepEqual(a, b);
});

test('a missing price is null rather than zero', () => {
  const free = classify({ ...byTcin('1010892076'), price: null }, CAPTURE_DAY);
  assert.equal(free.row.price, null);
});

// ── The output ───────────────────────────────────────────────────────────────
//
// A scan whose result you have to read all twenty-eight lines of has not done
// its job. These are about what a person sees.


const asResult = (over: Partial<ScanResult> = {}): ScanResult => ({
  url: 'https://www.target.com/s?searchTerm=pokemon',
  verdicts: rankScan(rows, CAPTURE_DAY),
  challenged: false,
  challengeReason: '',
  bodies: 9,
  ms: 4200,
  note: '',
  total: null,
  offset: null,
  ...over,
});

test('the report groups by what to do, not by rank', () => {
  const out = renderScan(asResult());
  assert.match(out, /Scheduled — Target has published a date {2}\(2\)/);
  assert.match(out, /Marketplace resellers — not Target stock {2}\(3\)/);
  assert.match(out, /Buyable from Target right now {2}\(1\)/);
});

test('it ends by saying how many are worth acting on', () => {
  assert.match(renderScan(asResult()), /2 worth pointing a mission at/);
});

test('a catalogue with nothing brewing says so plainly', () => {
  // The common case, and the one where a wall of reseller rows would read as
  // if something were happening.
  const resaleOnly = rows.filter((r) => r.seller.kind === 'marketplace');
  const out = renderScan(asResult({ verdicts: rankScan(resaleOnly, CAPTURE_DAY) }));
  assert.match(out, /Nothing here is close to stocking/);
});

test('THE LANDED-STOCK GROUP LEADS THE REPORT', () => {
  // If this ever fires it is the most important thing on the page, and it must
  // not appear underneath a list of things you can already buy.
  const landed = { ...rows.find((r) => r.tcin === '1010892076')!, outOfStockInAllStores: false };
  const out = renderScan(asResult({ verdicts: rankScan([...rows.slice(1), landed], CAPTURE_DAY) }));

  const landedAt = out.indexOf('STOCK HAS LANDED');
  const resaleAt = out.indexOf('Marketplace resellers');
  assert.ok(landedAt > -1, 'the group is missing');
  assert.ok(landedAt < resaleAt, 'and it must come first');
});

test('a challenge is reported as a challenge, not as an empty catalogue', () => {
  // Zero results because Target refused to serve us looks identical to zero
  // results because nothing is coming, and they call for opposite responses.
  const out = renderScan(
    asResult({ verdicts: [], challenged: true, challengeReason: 'press and hold', note: 'challenged: press and hold' }),
  );
  assert.match(out, /challenged: press and hold/);
  assert.ok(!out.includes('Nothing here is close to stocking'));
});

test('a read that captured nothing says which half failed', () => {
  const out = renderScan(
    asResult({ verdicts: [], bodies: 0, note: 'no search results in 0 captured responses — the page may have rendered without the fulfilment call, or the response shape has moved' }),
  );
  assert.match(out, /0 captured responses/);
});

// ── Discovery ────────────────────────────────────────────────────────────────

test('DISCOVERY KEEPS SEALED TARGET STOCK AND DROPS THE REST', () => {
  // Of the six real results: two unreleased Target boxes, three resellers, and
  // one Target action figure. Exactly two should be remembered.
  const found = candidates(rankScan(rows, CAPTURE_DAY));
  assert.deepEqual(
    found.map((c) => c.row.tcin).sort(),
    ['1010892068', '1010892076'],
  );
});

test('a reseller listing is never news, however new it is', () => {
  // Marketplace listings appear and vanish daily as resellers list and delist.
  // Letting them into the feed buries a genuine new SKU under a stream of the
  // same boxes at four times MSRP.
  const found = candidates(rankScan(rows, CAPTURE_DAY));
  assert.ok(!found.some((c) => c.row.seller.kind === 'marketplace'));
});

test("Target's own non-card products are dropped too", () => {
  // The action figure is sold by Target and is not a discovery.
  const found = candidates(rankScan(rows, CAPTURE_DAY));
  assert.ok(!found.some((c) => c.row.tcin === '94725169'));
});

test('an ambiguous product is kept, because dropping a real drop is the costly error', () => {
  const poster: ScanRow = {
    ...byTcin('1010892076'),
    tcin: '55555555',
    name: 'Pokémon Trading Card Game: 30th Celebration Poster Collection',
  };
  const found = candidates(rankScan([poster], CAPTURE_DAY));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.tcg.verdict, 'unsure');
});

test('what goes to the Hub is what the Hub asked for', () => {
  const found = candidates(rankScan(rows, CAPTURE_DAY));
  const item = toDiscovered(found[0]!);
  assert.equal(item.externalId, found[0]!.row.tcin, 'the tcin is the external id');
  assert.ok(item.name.length > 0);
  assert.match(item.url, /^https:\/\/www\.target\.com\//);
  assert.equal(typeof item.price, 'number');
});

test('THE FIRST RUN SAYS IT IS A BASELINE, NOT THAT NOTHING IS HAPPENING', () => {
  // Seeding silently is right — announcing an entire catalogue on day one is
  // noise — but a report that just said "nothing new" would read as a failure.
  const out = renderDiscover({
    scan: { url: 'u', verdicts: rankScan(rows, CAPTURE_DAY), challenged: false, challengeReason: '', bodies: 9, ms: 100, note: '', total: null, offset: null },
    candidates: candidates(rankScan(rows, CAPTURE_DAY)),
    fresh: [],
    received: 2,
    seeded: true,
    error: '',
  });
  assert.match(out, /baseline/);
  assert.ok(!out.includes('Nothing new since'));
});

test('a later run names what appeared', () => {
  const out = renderDiscover({
    scan: { url: 'u', verdicts: rankScan(rows, CAPTURE_DAY), challenged: false, challengeReason: '', bodies: 9, ms: 100, note: '', total: null, offset: null },
    candidates: candidates(rankScan(rows, CAPTURE_DAY)),
    fresh: ['Pokémon TCG: Something That Was Not Here Yesterday'],
    received: 3,
    seeded: false,
    error: '',
  });
  assert.match(out, /NEW SINCE LAST RUN {2}\(1\)/);
  assert.match(out, /Not Here Yesterday/);
});

test('a quiet run says so plainly', () => {
  const out = renderDiscover({
    scan: { url: 'u', verdicts: rankScan(rows, CAPTURE_DAY), challenged: false, challengeReason: '', bodies: 9, ms: 100, note: '', total: null, offset: null },
    candidates: candidates(rankScan(rows, CAPTURE_DAY)),
    fresh: [],
    received: 2,
    seeded: false,
    error: '',
  });
  assert.match(out, /Nothing new since the last run/);
});

test('A HUB THAT WILL NOT ANSWER IS NOT REPORTED AS AN EMPTY CATALOGUE', () => {
  // The two look identical in a summary line and mean opposite things.
  const out = renderDiscover({
    scan: { url: 'u', verdicts: rankScan(rows, CAPTURE_DAY), challenged: false, challengeReason: '', bodies: 9, ms: 100, note: '', total: null, offset: null },
    candidates: candidates(rankScan(rows, CAPTURE_DAY)),
    fresh: [],
    received: 0,
    seeded: false,
    error: 'POST /ingest → 503',
  });
  assert.match(out, /the Hub could not be told: POST \/ingest → 503/);
  assert.ok(!out.includes('Nothing new since'));
});

test('things that are sealed but not a US drop are called out separately', () => {
  const jp: ScanRow = {
    ...byTcin('1010892076'),
    tcin: '77777777',
    name: 'Pokemon SV4A Shiny Treasures ex Box (Japanese Version)',
  };
  const found = candidates(rankScan([jp], CAPTURE_DAY));
  const out = renderDiscover({
    scan: { url: 'u', verdicts: [], challenged: false, challengeReason: '', bodies: 1, ms: 10, note: '', total: null, offset: null },
    candidates: found,
    fresh: [],
    received: 1,
    seeded: false,
    error: '',
  });
  assert.match(out, /Sealed, but not a US retail drop/);
  assert.match(out, /japanese/);
});


// ── Knowing there is more ────────────────────────────────────────────────────
//
// The number that reframed the whole feature: a query for "pokemon booster
// box" reports 314 results and hands back 24. Reading one page was seeing
// seven per cent of the catalogue and calling it a sweep.

test('THE SEARCH SAYS HOW MANY RESULTS THERE REALLY ARE', () => {
  const withMeta = {
    data_source_modules: [
      {
        module_data: {
          search_response: {
            search_response: {
              metadata: { count: 24, offset: 0, total_results: 314, total_pages: 14 },
            },
            products: [],
          },
        },
      },
    ],
  };
  const meta = searchMeta([withMeta]);
  assert.equal(meta.total, 314);
  assert.equal(meta.offset, 0);
  assert.equal(meta.count, 24);
});

test('a later page reports where it sits', () => {
  const page2 = {
    search_response: { metadata: { count: 24, offset: 24, total_results: 314 } },
  };
  assert.equal(searchMeta([page2]).offset, 24);
});

test('A RESPONSE THAT SAYS NOTHING IS NULL, NOT ZERO', () => {
  // Zero would read as "no results and no more pages", which is the same shape
  // as a successful empty search — and would silently stop the sweep paging.
  assert.deepEqual(searchMeta([{ nothing: true }]), { total: null, offset: null, count: null });
  assert.deepEqual(searchMeta([]), { total: null, offset: null, count: null });
  assert.deepEqual(searchMeta([null]), { total: null, offset: null, count: null });
});

test('the real fixture has no metadata, and that is handled', () => {
  // It was captured before any of this existed. Absent must mean "one page",
  // not a crash.
  assert.equal(searchMeta([body]).total, null);
});

// ── The picture ──────────────────────────────────────────────────────────────
//
// Target's search response names the product photo, so a find can arrive with
// a picture rather than a line of text. Nothing is downloaded and nothing is
// hosted: it is the retailer's own CDN URL, asked for at thumbnail size.

test('A FIND ARRIVES WITH ITS PICTURE', () => {
  const box = byTcin('1010892076');
  assert.match(box.imageUrl, /^https:\/\/target\.scene7\.com\/is\/image\/Target\/GUEST_10bd6460/);
});

test('the image is asked for at thumbnail size, not full resolution', () => {
  // A sixty-pixel square in a list of twenty has no business fetching a
  // print-resolution photo.
  assert.match(byTcin('1010892076').imageUrl, /wid=300&hei=300/);
});

test('A URL THAT ALREADY HAS PARAMETERS IS LEFT ALONE', () => {
  // Guessing at how to merge query strings on somebody else's CDN is how a
  // working image becomes a broken one.
  assert.equal(
    byTcin('1010892068').imageUrl,
    'https://target.scene7.com/is/image/Target/GUEST_already?wid=88',
  );
});

test('a product with no image is blank, not a broken URL', () => {
  assert.equal(byTcin('94725169').imageUrl, '');
  assert.equal(thumbnail(''), '');
  assert.equal(thumbnail('not-a-url'), '');
  assert.equal(thumbnail(undefined as unknown as string), '');
});

test('the picture travels to the Hub with the rest of the find', () => {
  const [first] = candidates(rankScan(rows, CAPTURE_DAY));
  const item = toDiscovered(first!);
  assert.match(item.imageUrl, /scene7\.com/);
});

test('the sweep URL asks for Target stock, trading cards, and out-of-stock items', () => {
  const url = new URL(searchUrl('pokemon booster box'));
  assert.equal(url.origin + url.pathname, 'https://www.target.com/s');
  assert.equal(url.searchParams.get('searchTerm'), 'pokemon booster box');

  // Order matters to nobody, presence matters to everybody. Asserted one facet
  // at a time so a broken one names itself, rather than failing as a single
  // unreadable string comparison.
  const facets = (url.searchParams.get('facetedValue') ?? '').split('Z');
  assert.ok(facets.includes('dq4mn'), 'sold by Target');
  assert.ok(facets.includes('tkle6'), 'collectible trading cards');
  assert.ok(facets.includes('569t0'), 'include out of stock');
});

test('the sweep URL leaves the offset off the first page and names it on the rest', () => {
  assert.equal(new URL(searchUrl('pokemon tin')).searchParams.get('Nao'), null);
  assert.equal(new URL(searchUrl('pokemon tin', 0)).searchParams.get('Nao'), null);
  assert.equal(new URL(searchUrl('pokemon tin', 24)).searchParams.get('Nao'), '24');
});

test('the sweep URL encodes a query rather than pasting it in', () => {
  // The accent and the spaces both have to survive the trip.
  const url = new URL(searchUrl('pokémon elite trainer box'));
  assert.equal(url.searchParams.get('searchTerm'), 'pokémon elite trainer box');
  assert.ok(!url.search.includes(' '), 'no raw spaces in the query string');
});
