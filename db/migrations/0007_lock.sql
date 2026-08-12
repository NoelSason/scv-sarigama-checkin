-- ===========================================================================
-- Human decisions that the sheet must not overwrite.
--
-- The sheet is the source of truth for Zelle rows, and the sync rewrites each
-- household from its row every five minutes. That is correct nearly always, and
-- exactly wrong once an organizer has looked at a row and decided something the
-- sheet cannot express:
--
--   * "they overpaid because they added a donation — this is paid, not
--      needs_review"
--   * "the sheet says 10 seats but only 1 is paid for; the rest are on the day"
--
-- Without a lock those decisions survive about five minutes. With one, the sync
-- still matches the row (so it never creates a duplicate) but leaves the
-- numbers and the status alone.
-- ===========================================================================

alter table households
  add column if not exists locked_at     timestamptz,
  add column if not exists locked_reason text;

comment on column households.locked_at is
  'Set when a human fixed this household by hand. Sheet sync will not change its tickets or payment status while this is set.';

create index if not exists households_locked on households (locked_at)
  where locked_at is not null;
