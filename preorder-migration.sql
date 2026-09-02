-- Phantom · was the order a pre-order?   2 Sep 2026
--
-- Run this in the PHANTOM Supabase SQL Editor (the watcher-gold project),
-- not the vault one. Safe to run twice.
--
-- WHY IT IS ON THE RUN, not looked up later:
--   watch_state.is_preorder is the CURRENT truth about a listing, which is
--   exactly wrong for this question. A pre-order that has since released would
--   read as an ordinary order — and the money it still owes would vanish from
--   the books on the day it matters most.
--
-- The distinction is money, not bookkeeping. An order is paid. A pre-order is
-- COMMITTED: the retailer takes it at ship, sometimes months out. A budget
-- that counts the two the same is wrong twice — it says you have less to work
-- with than you do, and it forgets the bill that is coming.

ALTER TABLE mission_runs ADD COLUMN IF NOT EXISTS is_preorder BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mission_runs ADD COLUMN IF NOT EXISTS release_date DATE;

-- No backfill on purpose. Existing rows default to false, which for the one
-- confirmed order so far (the Test pens) is correct. Guessing at the rest from
-- today's watch_state would be inventing history.

SELECT count(*) FILTER (WHERE is_preorder) AS pre_orders,
       count(*) FILTER (WHERE NOT is_preorder) AS orders
  FROM mission_runs WHERE outcome = 'bought';
