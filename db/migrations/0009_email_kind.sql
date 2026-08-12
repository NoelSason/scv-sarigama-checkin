-- ===========================================================================
-- Which mailing a delivery belongs to.
--
-- "Have they already been sent it?" is the question that makes the sender safe
-- to re-run, and until now it could only be asked about mail in general. That
-- is right for one mailing and wrong for two: a reminder the week of the event
-- would skip all 73 people who already hold a pass, which is precisely everyone
-- it needs to reach.
--
-- Tagging each delivery lets the question be asked per mailing instead — the
-- pass send still never repeats itself, and the reminder reaches everyone
-- exactly once, including people who bought after the first send.
-- ===========================================================================

alter table email_deliveries
  add column if not exists kind text not null default 'pass';

comment on column email_deliveries.kind is
  'Which mailing: pass (the original ticket) or reminder (final event details). The sender skips a household only within the same kind.';

create index if not exists email_deliveries_kind_household
  on email_deliveries (kind, household_id, status);
