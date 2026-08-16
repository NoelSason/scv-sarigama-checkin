-- ===========================================================================
-- Marked present — attendance recorded after the fact, without a scan.
--
-- At the end of the Sadhya the line was moving faster than the scanner, so a
-- number of families walked in without being checked in. They ate; the ledger
-- says they didn't. Some of the same list genuinely never showed.
--
-- This is deliberately NOT a redemption and NOT a change to tickets_redeemed:
--
--   * tickets_redeemed is the count of admissions released by a scan at the
--     door. Writing into it would destroy the one number that can still be
--     trusted about door throughput, and would put arrivals on the timeline at
--     a time nobody observed.
--   * The redemption ledger is append-only and reconstructible from scans.
--     An annotation made days later does not belong in it.
--
-- So: a separate, additive table. The analytics page adds these into headcount
-- ("who ate") and deliberately leaves them out of every clock-based figure —
-- per-hour arrivals, peak throughput, seating fill — because there is no
-- observed arrival time to place them at.
--
-- quantity is stored rather than assumed to be "all of them", because the
-- honest answer per family is often "3 of the 4 came".
-- ===========================================================================

create table if not exists attendance_marks (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  quantity     integer not null,
  note         text,
  marked_by    text,                        -- free text; this page has no login
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint attendance_mark_quantity_positive check (quantity > 0)
);

-- One row per household: marking is a statement about the family, not an event
-- log. Re-marking updates the number instead of stacking a second claim.
create unique index if not exists attendance_marks_household_uniq
  on attendance_marks (household_id);

drop trigger if exists attendance_marks_set_updated_at on attendance_marks;
create trigger attendance_marks_set_updated_at
  before update on attendance_marks
  for each row execute function set_updated_at();

comment on table attendance_marks is
  'Guests recorded as having eaten without being scanned in. Counted in headcount; never counted in any time-based figure, because no arrival time was observed.';
