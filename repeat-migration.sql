-- Phantom · repeating the alerts   2 Sep 2026
--
-- Run this in the PHANTOM Supabase SQL Editor (the watcher-gold project),
-- not the vault one. Safe to run twice. Includes the staged column, so this
-- one file covers both if you have not run staged-notify-migration.sql yet.
--
-- WHAT THEY ARE FOR:
--   Both alerts are edge-triggered — they fire once, when something changes.
--   Right for a machine, wrong for a room full of people who were not looking
--   at their phone in that minute.
--
--   These two columns are when we last said each thing, per listing, so a
--   repeat interval has something to measure against. NULL means nothing has
--   been said, which is why a first sighting always announces. Each is cleared
--   the moment its condition ends, so the next time is judged fresh.
--
-- Nothing changes until you set the repeat intervals in Settings. Zero, the
-- default for both, is exactly the behaviour you have now.

ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS staged_notified_at TIMESTAMPTZ;
ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS stock_notified_at  TIMESTAMPTZ;

SELECT count(*) AS listings,
       count(*) FILTER (WHERE state = 'in') AS in_stock_now
  FROM watch_state;
