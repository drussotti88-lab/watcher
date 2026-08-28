/**
 * Watching the page's own network calls.
 *
 * Target's product page carries no JSON-LD and no price in its HTML. The only
 * price-shaped thing in its 131KB of embedded state is the flag
 * `isProductDetailServerSideRenderPriceEnabled: false`. The price arrives from
 * Target's own API after hydration, so the reader has to be written against the
 * call, and this is what finds the call.
 *
 * The tests below marked "the carousel bug" are regressions for a real miss:
 * the first ranked output was three screens of *other people's* prices —
 * recommended products and Affirm instalment plans — with the price of the item
 * we actually asked about nowhere in sight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isInterestingApi,
  fieldPaths,
  scoreCall,
  callSlug,
  extractProductKey,
} from '../src/apisniff.ts';

const JSON_CT = 'application/json; charset=utf-8';

test('the calls that matter are kept', () => {
  const keep = [
    'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=abc&tcin=1012644666',
    'https://www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules?tcin=1',
    'https://sapphire-api.target.com/sapphire/runtime/api/v1/raw/www.target.com/p/-/A-1012644666',
    'https://www.walmart.com/orchestra/home/graphql/ItemById',
    'https://www.pokemoncenter.com/tpci-ecommweb-api/product/status/qgqvbkjrgayc2mjqgmzdm=',
  ];
  for (const u of keep) assert.equal(isInterestingApi(u, JSON_CT), true, u);
});

test('telemetry is dropped, however JSON it is', () => {
  const drop = [
    'https://api.target.com/consumers/v1/ingest/web/product_impression',
    'https://api.target.com/firefly_events/v1/events',
    'https://www.google-analytics.com/collect?v=2',
    'https://browser-intake.datadoghq.com/api/v2/rum?ddsource=browser',
    'https://cdn.tealiumiq.com/api/utag.js',
  ];
  for (const u of drop) assert.equal(isInterestingApi(u, JSON_CT), false, u);
});

test('a beacon that happens to sit under /api/ is still a beacon', () => {
  // NOISE is checked before SIGNAL on purpose — the ingest path below matches
  // /api/ too, and if SIGNAL won we would drown in impression events.
  assert.equal(
    isInterestingApi('https://api.target.com/consumers/v1/ingest/web/eventstream', JSON_CT),
    false,
  );
});

test('non-JSON is never interesting, whatever the path says', () => {
  assert.equal(isInterestingApi('https://redsky.target.com/pdp_client_v1', 'text/html'), false);
  assert.equal(isInterestingApi('https://x/api/product.png', 'image/png'), false);
});

test('the product id is read from every retailer URL we watch', () => {
  const cases: [string, string][] = [
    ['https://www.target.com/p/-/A-1012644666', '1012644666'],
    ['https://www.target.com/p/pokemon-tin/-/A-1012644666?preselect=1', '1012644666'],
    ['https://www.walmart.com/ip/Pokemon-TCG-Chaos-Rising-ETB/19988614228', '19988614228'],
    [
      'https://www.pokemoncenter.com/product/100-10326/pokemon-tcg-journey-together',
      '100-10326',
    ],
  ];
  for (const [url, want] of cases) assert.equal(extractProductKey(url), want, url);
  assert.equal(extractProductKey('https://www.target.com/'), null, 'a homepage has no product');
});

test('field paths point at the price, wherever it is buried', () => {
  const body = {
    data: {
      product: {
        tcin: '1012644666',
        price: { current_retail: 24.99, formatted_current_price: '$24.99' },
      },
    },
  };
  const paths = fieldPaths(body, { productKey: '1012644666' });
  const found = paths.map((p) => p.path);
  assert.ok(found.includes('data.product.price.current_retail'), found.join(', '));
  assert.ok(
    paths.every((p) => p.onTarget),
    'everything under an object carrying our tcin is on target — including nested price objects',
  );
});

test('stock fields are found even when they are not called "stock"', () => {
  const body = {
    data: {
      product: {
        tcin: '1012644666',
        fulfillment: {
          shipping_options: { availability_status: 'OUT_OF_STOCK' },
          sold_out: true,
        },
      },
    },
  };
  const found = fieldPaths(body, { productKey: '1012644666' }).map((p) => p.path);
  assert.ok(found.some((p) => p.endsWith('availability_status')), found.join(', '));
  assert.ok(found.some((p) => p.endsWith('sold_out')), found.join(', '));
});

test('the carousel bug: our product is separated from the thirty others', () => {
  // The exact shape that misled the first run.
  const body = {
    modules: [
      {
        module_data: {
          recommended_products: [
            { tcin: '1008749492', redsky_product: { price: { current_retail: 69.99 } } },
            { tcin: '1009999999', redsky_product: { price: { current_retail: 479.99 } } },
          ],
        },
      },
      {
        module_data: {
          data: { product: { tcin: '1012644666', price: { current_retail: 24.99 } } },
        },
      },
    ],
  };
  const paths = fieldPaths(body, { productKey: '1012644666' });
  const onTarget = paths.filter((p) => p.onTarget);

  assert.equal(onTarget.length, 1, 'exactly one price belongs to the item we asked about');
  assert.equal(onTarget[0]!.value, '24.99');
  assert.equal(paths[0]!.onTarget, true, 'and it sorts to the top, ahead of the carousel');
});

test('the carousel bug: volume never outranks relevance', () => {
  const carousel = {
    recommended_products: Array.from({ length: 30 }, (_, i) => ({
      tcin: `900000${i}`,
      price: { current_retail: 10 + i },
    })),
  };
  const ours = { product: { tcin: '1012644666', price: { current_retail: 24.99 } } };

  const key = '1012644666';
  const carouselScore = scoreCall({
    paths: fieldPaths(carousel, { productKey: key }),
    bodyText: JSON.stringify(carousel),
    productKey: key,
  });
  const ourScore = scoreCall({
    paths: fieldPaths(ours, { productKey: key }),
    bodyText: JSON.stringify(ours),
    productKey: key,
  });

  assert.ok(
    ourScore > carouselScore,
    `one price for our item (${ourScore}) must beat thirty for other items (${carouselScore})`,
  );
});

test('Affirm instalments and review scores are not prices', () => {
  // Every one of these was presented as a price in the first ranked output.
  const body = {
    product: {
      tcin: '1012644666',
      financing_options: {
        providers: [
          {
            finance_minimum_loan_amount: 50,
            finance_terms: [{ amount: 103.35, installment_amount: 34.45, interest_amount: 3.35 }],
          },
        ],
      },
      ratings_and_reviews: {
        statistics: { rating: { secondary_averages: [{ value: 1 }, { value: 1 }] } },
      },
      price: { current_retail: 24.99 },
    },
  };
  const found = fieldPaths(body, { productKey: '1012644666' });
  assert.deepEqual(
    found.map((p) => p.path),
    ['product.price.current_retail'],
    'only the actual price survives',
  );
});

test('a price of zero is not a price', () => {
  // Same discipline as the JSON-LD reader: zero looks buyable, and a reader
  // that believes a zero will happily arm a purchase against nothing.
  assert.deepEqual(fieldPaths({ price: { current_retail: 0 } }), []);
});

test('an id that happens to be called "value" is not mistaken for money', () => {
  assert.deepEqual(fieldPaths({ tracking: { value: 987654321098 } }), []);
});

test('walking is bounded, so a huge graph cannot hang the inspection', () => {
  let deep: Record<string, unknown> = { price: 9.99 };
  for (let i = 0; i < 40; i += 1) deep = { nest: deep };
  assert.deepEqual(fieldPaths(deep), [], 'past the depth limit we stop rather than crawl forever');

  const wide = { items: Array.from({ length: 5000 }, (_, i) => ({ price: i + 1 })) };
  const paths = fieldPaths(wide);
  assert.ok(paths.length <= 60, `capped, got ${paths.length}`);
  assert.ok(paths.length > 0, 'but the first entries are still sampled');
});

test('junk in, empty list out — never a throw', () => {
  for (const junk of [null, undefined, 42, 'text', [], {}]) {
    assert.deepEqual(fieldPaths(junk), []);
  }
});

test('a body that merely mentions our id scores below one that prices it', () => {
  const key = '1012644666';
  const mentions = { requested_tcin: key, results: [] };
  const prices = { product: { tcin: key, price: { current_retail: 24.99 } } };
  assert.ok(
    scoreCall({ paths: fieldPaths(prices, { productKey: key }), bodyText: JSON.stringify(prices), productKey: key }) >
      scoreCall({ paths: fieldPaths(mentions, { productKey: key }), bodyText: JSON.stringify(mentions), productKey: key }),
  );
});

test('slugs number every capture, because four POSTs can share one URL', () => {
  // Target fired four POSTs to the identical URL, differing only in payload.
  // Slugging by URL alone made them overwrite each other on disk and kept one.
  const url = 'https://www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules?tcin=1';
  assert.notEqual(callSlug(url, 0), callSlug(url, 1));
  assert.match(callSlug(url, 0), /^00_/);
  assert.match(callSlug(url, 12), /^12_/);
});

test('slugs still drop the query string, so a rotating key spawns no new files', () => {
  const a = callSlug('https://redsky.target.com/v1/web/pdp_client_v1?key=aaa&tcin=1', 3);
  const b = callSlug('https://redsky.target.com/v1/web/pdp_client_v1?key=bbb&tcin=2', 3);
  assert.equal(a, b);
  assert.ok(!a.includes('aaa'), a);
});

test('recorded requests do not carry the operator around with them', async () => {
  // Target's calls embed a visitor id, a postcode and a lat/long to three
  // decimals. Artifacts get pasted into chat and committed; that should not.
  const { redact } = await import('../src/inspect.ts');
  const url =
    'https://www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules' +
    '?latitude=35.670&longitude=-87.700&zip=37033&tcin=1012644666' +
    '&visitor_id=01A0481855460200AB493711EF45E48E&key=9f36aeaf';
  const clean = redact(url);

  for (const secret of ['35.670', '-87.700', '37033', '01A0481855460200AB493711EF45E48E']) {
    assert.ok(!clean.includes(secret), `${secret} survived redaction: ${clean}`);
  }
  assert.ok(clean.includes('tcin=1012644666'), 'the product id is not a secret and must stay');
  assert.ok(clean.includes('deferred_enrichment/modules'), 'the endpoint must stay readable');

  const payload = `{"page_context":"${'e30='.repeat(30)}","modules":["price"]}`;
  assert.ok(redact(payload).includes('<redacted>'));
  assert.ok(redact(payload).includes('"modules":["price"]'), 'the useful half survives');
});
