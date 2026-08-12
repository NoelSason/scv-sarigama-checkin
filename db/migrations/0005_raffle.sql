-- ===========================================================================
-- End-of-day raffle.
--
-- Every ticket sold is one entry, under the name that bought it. A household
-- with 10 tickets is ten times as likely to be drawn as a household with one.
-- Attendance is irrelevant: tickets_redeemed never enters the calculation.
--
-- Design rules encoded here:
--   * The winner is chosen by the DATABASE, not by the browser. The animation
--     on /raffle is theatre played out after the fact — if the laptop dies
--     mid-spin the draw is already recorded.
--   * A standing win removes you from the pool, enforced by a partial unique
--     index rather than by the caller remembering to filter.
--   * Nothing is ever deleted. "Undo" and "reset" set voided_at, so the record
--     of what was announced on stage survives either.
--
-- Eligibility is deliberately NARROWER than redemption: 'paid' only, not
-- 'comped'. Complimentary passes get into the Sadhya; they did not buy a
-- raffle entry.
-- ===========================================================================

create table if not exists raffle_draws (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete restrict,

  -- Snapshots, not joins. What was announced on stage must stay readable even
  -- if the household is renamed or its ticket count is corrected afterwards.
  display_name     text    not null,
  prize            text    not null,
  entries_at_draw  integer not null,
  pool_entries     integer not null,
  pool_households  integer not null,

  drawn_by         uuid references staff_users(id) on delete set null,
  voided_at        timestamptz,
  created_at       timestamptz not null default now(),

  constraint raffle_entries_positive check (entries_at_draw > 0)
);

-- The invariant the raffle depends on: nobody holds two standing wins.
-- Voided rows are excluded, so a reset genuinely puts everyone back.
create unique index if not exists raffle_draws_winner_uniq
  on raffle_draws (household_id) where voided_at is null;

create index if not exists raffle_draws_recent on raffle_draws (created_at desc);

-- --------------------------------------------------------------------------
-- draw_raffle_winner — pick one household, weighted by tickets, and record it
-- --------------------------------------------------------------------------
create or replace function draw_raffle_winner(
  p_prize text,
  p_staff uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_prize    text;
  v_winner   record;
  v_entries  integer;
  v_names    integer;
  v_draw     uuid;
begin
  v_prize := btrim(coalesce(p_prize, ''));
  if length(v_prize) = 0 then
    return jsonb_build_object('success', false, 'error', 'PRIZE_REQUIRED');
  end if;

  -- Serialize draws across devices. Two organizers pressing SPIN on two
  -- laptops in the same second must not both be handed the same name — and
  -- the unique index would reject the loser with an opaque error rather than
  -- a clean POOL_EMPTY.
  perform pg_advisory_xact_lock(hashtext('onam_raffle'));

  select count(*)::int, coalesce(sum(tickets_purchased), 0)::int
    into v_names, v_entries
    from households h
   where not h.is_test
     and h.payment_status = 'paid'
     and h.tickets_purchased > 0
     and not exists (select 1 from raffle_draws d
                      where d.household_id = h.id and d.voided_at is null);

  if v_names = 0 then
    return jsonb_build_object('success', false, 'error', 'POOL_EMPTY');
  end if;

  -- Weighted sampling in one pass. Giving each row the key
  -- random() ^ (1 / weight) and taking the largest picks row i with
  -- probability weight_i / sum(weight) — the standard weighted-reservoir key.
  -- Written this way rather than as -ln(random())/weight because random() can
  -- return exactly 0, and ln(0) raises.
  select h.id, h.display_name, h.tickets_purchased
    into v_winner
    from households h
   where not h.is_test
     and h.payment_status = 'paid'
     and h.tickets_purchased > 0
     and not exists (select 1 from raffle_draws d
                      where d.household_id = h.id and d.voided_at is null)
   order by random() ^ (1.0::float8 / h.tickets_purchased) desc
   limit 1;

  insert into raffle_draws
      (household_id, display_name, prize, entries_at_draw,
       pool_entries, pool_households, drawn_by)
    values (v_winner.id, v_winner.display_name, v_prize, v_winner.tickets_purchased,
            v_entries, v_names, p_staff)
  returning id into v_draw;

  insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
       values ('staff', p_staff::text, 'raffle_drawn', v_winner.id,
               jsonb_build_object('draw_id', v_draw,
                                  'prize', v_prize,
                                  'entries', v_winner.tickets_purchased,
                                  'pool_entries', v_entries,
                                  'pool_households', v_names));

  return jsonb_build_object(
    'success',          true,
    'draw_id',          v_draw,
    'household_id',     v_winner.id,
    'display_name',     v_winner.display_name,
    'prize',            v_prize,
    'entries_at_draw',  v_winner.tickets_purchased,
    'pool_entries',     v_entries,
    'pool_households',  v_names
  );
end $$;
