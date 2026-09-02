-- Phantom · staged stock on a find   2 Sep 2026
--
-- Run this in the PHANTOM Supabase SQL Editor (the watcher-gold project),
-- not the vault one. Safe to run twice.
--
-- WHAT IT IS FOR:
--   Discovery already stores the per-order limit but not the count beside it,
--   so a find can say "limit 12 per order" and stay silent about the twelve
--   thousand units sitting behind it. Staged stock — counted in the warehouse
--   while the shop still refuses to sell — is the earliest warning this system
--   can get, and the finds list is exactly where it is most useful: an item
--   nobody is watching yet is the one you most need telling about.
--
-- The sweep has been reading this number all along and throwing it away at the
-- database boundary. One column is the whole fix.

ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS available_quantity INTEGER;

-- No backfill. The column means "what the last sweep saw", and the last sweep
-- did not record it. Inventing a number here would be worse than a blank, and
-- the next sweep fills it in honestly.

SELECT count(*) AS finds,
       count(available_quantity) AS with_a_count
  FROM discoveries;
