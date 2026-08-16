-- ===========================================================================
-- Run-sheet timing.
--
-- The Ponnonam run sheet is a fixed list written before the day; what the
-- analytics page needs is the other half of the comparison — when each item
-- ACTUALLY started. That is a fact only somebody standing at the stage knows,
-- and it has to be shared: three organizers on three phones must see the same
-- answer to "how far behind are we".
--
-- So the marks live here rather than in a browser. One row per run-sheet item,
-- keyed by the item's stable string id from src/lib/analytics/program.ts. The
-- run sheet itself is NOT in the database — it is content, it changed four
-- times in the week before the event, and a code deploy is a better review
-- process for it than an UPDATE statement.
--
-- Two items never need a mark: "Sadya begins" and "Sadya ends" are read
-- straight off the first and last check-in scan, which is a better record than
-- anyone's memory.
-- ===========================================================================

create table if not exists program_marks (
  item_key   text primary key,
  started_at timestamptz not null,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists program_marks_set_updated_at on program_marks;
create trigger program_marks_set_updated_at
  before update on program_marks
  for each row execute function set_updated_at();

comment on table program_marks is
  'When each run-sheet item actually started. Compared against the planned time in src/lib/analytics/program.ts to show how far behind the show is running.';
