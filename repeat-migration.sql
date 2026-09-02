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

-- How many follow-ups have gone out since that first in-stock post. It doubles
-- as the index into the schedule, which is what keeps the decision to send one
-- comparison rather than a pile of timestamps.
ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS stock_alerts_sent INTEGER NOT NULL DEFAULT 0;

-- Per-mission mute. A muted mission is still checked, still bought if armed,
-- and still on the page - it simply stops posting to a room of people who did
-- not ask about that one. Defaults to true so nothing goes quiet on upgrade.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS alerts BOOLEAN NOT NULL DEFAULT true;

SELECT count(*) AS listings,
       count(*) FILTER (WHERE state = 'in') AS in_stock_now
  FROM watch_state;
