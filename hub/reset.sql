-- Drop everything this project owns, so `db:push` can rebuild it clean.
--
-- DESTRUCTIVE, and deliberately a separate file you have to ask for by name.
-- It exists because the schema changed shape early — watch_state and
-- observations moved from being keyed on (product, retailer) to being keyed on
-- a listing — and at that point the only data in here was seed data. Rebuilding
-- was honest; a migration pretending to preserve three rows of test fixtures
-- would not have been.
--
-- Once there is real history in these tables, stop using this and write
-- migrations instead.
--
--   npm run db:reset && npm run db:push && npm run db:seed

DROP TABLE IF EXISTS mission_runs CASCADE;
DROP TABLE IF EXISTS missions CASCADE;
DROP TABLE IF EXISTS observations CASCADE;
DROP TABLE IF EXISTS watch_state CASCADE;
DROP TABLE IF EXISTS listings CASCADE;
DROP TABLE IF EXISTS discoveries CASCADE;
DROP TABLE IF EXISTS aliases CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS sources CASCADE;
DROP TABLE IF EXISTS events CASCADE;
