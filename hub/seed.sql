-- Three retailers, and what we now know rather than what we guessed.
--
-- The first version of this file hedged: Pokémon Center was marked blocked,
-- Target and Walmart were left on `hub` and enabled, with a note saying a
-- deployed Worker might get through where local testing did not.
--
-- It did not. The deployed Hub got 403 from all three. Meanwhile a real Chrome
-- on Roberto's own connection reached all three, read their product pages, and
-- gave us price and stock for every one of them.
--
-- So the hedge is gone. **Every source here is `via = 'watcher'`.** A Hub in a
-- datacentre — Cloudflare's or Vercel's, it makes no difference — is not the
-- data path and never was. It is the memory, the watchlist and the alerting.
-- The machine on the desk does the looking.
--
-- Safe to run twice: every statement is ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- Where to hunt for products we don't know about yet
-- ---------------------------------------------------------------------------
INSERT INTO sources (id, label, retailer, kind, url, via, config, enabled)
VALUES
  (
    'pc-new-releases',
    'Pokémon Center — new releases',
    'Pokemon Center',
    'watcher',
    'https://www.pokemoncenter.com/category/new-releases',
    'watcher',
    '{"filters":[]}'::jsonb,
    true
  ),
  (
    'target-tcg',
    'Target — trading cards',
    'Target',
    'watcher',
    'https://www.target.com/c/trading-cards-toys/-/N-5tdv0',
    'watcher',
    '{"filters":["pokemon","pokémon"]}'::jsonb,
    true
  ),
  (
    'walmart-tcg',
    'Walmart — trading cards',
    'Walmart',
    'watcher',
    'https://www.walmart.com/browse/toys/trading-cards/4171_4187_1229163',
    'watcher',
    '{"filters":["pokemon","pokémon"]}'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Three products we have actually read, so the watchlist is not empty on day
-- one and the first end-to-end run has something real to check.
--
-- These are the exact pages the readers were written from. If a reader ever
-- breaks, these are the known-good cases to run first.
-- ---------------------------------------------------------------------------
INSERT INTO products (key, name) VALUES
  ('prd_mega_evolution_ascended_heroes_tin',
   'Pokémon TCG: Mega Evolution — Ascended Heroes Tin (Mega Feraligatr ex)'),
  ('prd_journey_together_sleeved_booster',
   'Pokémon TCG: Scarlet & Violet — Journey Together Sleeved Booster Pack'),
  ('prd_mega_evolution_chaos_rising_etb',
   'Pokémon TCG: Mega Evolution — Chaos Rising Elite Trainer Box')
ON CONFLICT (key) DO NOTHING;

INSERT INTO aliases (product_key, kind, retailer, value) VALUES
  ('prd_mega_evolution_ascended_heroes_tin', 'retailer_sku', 'Target', '1012644666'),
  ('prd_journey_together_sleeved_booster', 'retailer_sku', 'Pokemon Center', '100-10326'),
  ('prd_mega_evolution_chaos_rising_etb', 'retailer_sku', 'Walmart', '19988614228')
ON CONFLICT (kind, retailer, value) DO NOTHING;

-- The URLs live on discoveries, which is where the watchlist reads them from.
-- Marked announced so seeding these does not fire three alerts on first run.
INSERT INTO discoveries (source_id, external_id, url, name, product_key, announced) VALUES
  (
    'target-tcg', '1012644666',
    'https://www.target.com/p/-/A-1012644666',
    'Pokémon TCG: Mega Evolution — Ascended Heroes Tin (Mega Feraligatr ex)',
    'prd_mega_evolution_ascended_heroes_tin', true
  ),
  (
    'pc-new-releases', '100-10326',
    'https://www.pokemoncenter.com/product/100-10326/pokemon-tcg-scarlet-and-violet-journey-together-sleeved-booster-pack-10-cards',
    'Pokémon TCG: Scarlet & Violet — Journey Together Sleeved Booster Pack',
    'prd_journey_together_sleeved_booster', true
  ),
  (
    'walmart-tcg', '19988614228',
    'https://www.walmart.com/ip/Pokemon-TCG-Mega-Evolution-Chaos-Rising-Elite-Trainer-Box/19988614228',
    'Pokémon TCG: Mega Evolution — Chaos Rising Elite Trainer Box',
    'prd_mega_evolution_chaos_rising_etb', true
  )
ON CONFLICT (source_id, external_id) DO NOTHING;
