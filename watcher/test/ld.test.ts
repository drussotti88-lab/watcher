/**
 * JSON-LD extraction.
 *
 * This is the highest-value thing on a product page: retailers publish
 * schema.org markup for Google, it's structured, and it survives redesigns that
 * shatter CSS selectors. Every shape below is one that real retail sites use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { offersFromLd } from '../src/inspect.ts';

test('the plain shape: Product with a single offer object', () => {
  const [o] = offersFromLd([
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Pokémon TCG: Mega Evolution Elite Trainer Box',
      sku: '94312876',
      offers: {
        '@type': 'Offer',
        price: '49.99',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
      },
    },
  ]);
  assert.ok(o);
  assert.equal(o.price, 49.99, 'price arrives as a string and must be coerced');
  assert.equal(o.availability, 'InStock', 'the schema.org URL must be normalised');
  assert.equal(o.sku, '94312876');
  assert.match(o.name, /Mega Evolution/);
});

test('offers as an array yields one row each', () => {
  const out = offersFromLd([
    {
      '@type': 'Product',
      name: 'Booster Bundle',
      sku: 'X1',
      offers: [
        { '@type': 'Offer', price: 26.99, availability: 'InStock' },
        { '@type': 'Offer', price: 29.99, availability: 'OutOfStock' },
      ],
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.price, 26.99);
  assert.equal(out[1]!.availability, 'OutOfStock');
});

test('@graph wrappers are walked, not skipped', () => {
  const out = offersFromLd([
    {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList', itemListElement: [] },
        {
          '@type': 'Product',
          name: 'Mega Charizard Figure',
          sku: '100-12345',
          offers: { '@type': 'Offer', price: '39.99', availability: 'http://schema.org/OutOfStock' },
        },
      ],
    },
  ]);
  assert.equal(out.length, 1, 'the Product is one level down inside @graph');
  assert.equal(out[0]!.availability, 'OutOfStock');
});

test('every availability spelling in the wild normalises', () => {
  const cases: [string, string][] = [
    ['https://schema.org/InStock', 'InStock'],
    ['http://schema.org/InStock', 'InStock'],
    ['InStock', 'InStock'],
    ['IN_STOCK', 'InStock'],
    ['https://schema.org/OutOfStock', 'OutOfStock'],
    ['OUT_OF_STOCK', 'OutOfStock'],
    ['https://schema.org/PreOrder', 'PreOrder'],
    ['https://schema.org/LimitedAvailability', 'LimitedAvailability'],
    ['https://schema.org/BackOrder', 'BackOrder'],
  ];
  for (const [raw, want] of cases) {
    const [o] = offersFromLd([{ '@type': 'Product', offers: { availability: raw } }]);
    assert.equal(o!.availability, want, `${raw} should normalise to ${want}`);
  }
});

test('a Product with no offers still reports itself', () => {
  const [o] = offersFromLd([{ '@type': 'Product', name: 'Coming Soon Thing', sku: 'S1' }]);
  assert.ok(o);
  assert.equal(o.price, null, 'no price is null, never zero — zero would look buyable');
  assert.equal(o.name, 'Coming Soon Thing');
});

test('an array of blocks, as a page with several script tags gives', () => {
  const out = offersFromLd([
    { '@type': 'WebSite', name: 'Target' },
    { '@type': 'Product', name: 'A', offers: { price: 10, availability: 'InStock' } },
    [{ '@type': 'Product', name: 'B', offers: { price: 20, availability: 'InStock' } }],
  ]);
  assert.equal(out.length, 2, 'non-Product blocks ignored, nested arrays walked');
});

test('priceSpecification is read when price is absent', () => {
  const [o] = offersFromLd([
    {
      '@type': 'Product',
      name: 'Spec priced',
      offers: { '@type': 'Offer', priceSpecification: { price: '59.99' }, availability: 'InStock' },
    },
  ]);
  assert.equal(o!.price, 59.99);
});

test('junk never throws and never invents a price', () => {
  assert.deepEqual(offersFromLd([]), []);
  assert.deepEqual(offersFromLd([null, 'nonsense', 42]), []);
  const [o] = offersFromLd([{ '@type': 'Product', offers: { price: 'call for pricing' } }]);
  assert.equal(o!.price, null, 'unparseable price must be null, not 0');
});

test('a currency-prefixed price string still parses', () => {
  const [o] = offersFromLd([{ '@type': 'Product', offers: { price: '$1,299.00' } }]);
  assert.equal(o!.price, 1299);
});
