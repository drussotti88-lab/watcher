-- Phantom · repeating the load-in alert   2 Sep 2026
--
-- Run this in the PHANTOM Supabase SQL Editor (the watcher-gold project),
-- not the vault one. Safe to run twice.
--
-- WHAT IT IS FOR:
--   The staged-stock alarm is edge-triggered: it fires once, when a listing
--   goes from nothing counted to a warehouse behind it. That is right for a
--   machine and wrong for a person — the whole point of the alarm is that it
--   lands at eleven at night for a three in the morning drop, and the one
--   message that matters most is the one you were asleep for.
--
-- This column is when we last said it, per listing, so a repeat interval has
-- something to measure against. NULL means nothing has been said, which is why
-- a first sighting always announces. It is cleared the moment a listing stops
-- being staged, so the next load-in is judged fresh rather than against a
-- timestamp from the last one.
--
-- Nothing changes until you set "Repeat the load-in alert" in Settings. Zero,
-- the default, is the behaviour you have now: once, on the edge.

ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS staged_notified_at TIMESTAMPTZ;

SELECT count(*) AS listings,
       count(staged_notified_at) AS with_a_staged_alert_on_record
  FROM watch_state;
