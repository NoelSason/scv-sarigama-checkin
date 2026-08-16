-- ===========================================================================
-- Raffle exclusion — take a household out of the draw without touching what
-- it paid for.
--
-- The five card-present sales rung up on the Square terminal carry no buyer
-- name: Square captures no cardholder name and no billing address for a
-- card-present tender, so the webhook could only fall back to `Square order
-- <id>`. Two of them, plus one online buyer, have nothing but an email. None
-- of the six is a name that can be announced from a stage, and an email
-- address read out to a full hall is worse than a missing entry.
--
-- Why a flag and not a delete, and not a ticket adjustment:
--
--   * tickets_purchased is what somebody paid for. It is the number the
--     Sadhya line, the refund path and every reconciliation report read. The
--     raffle is not entitled to rewrite it to solve a display problem.
--   * A delete would take the payment record with it.
--   * The flag is one boolean and reversible: clear it and the household is
--     back in the pool with its original weight, no recalculation involved.
--
-- Excluding is therefore a statement about the RAFFLE only. Admission,
-- refunds and headcount are untouched.
-- ===========================================================================

alter table households
  add column if not exists raffle_excluded boolean not null default false;

comment on column households.raffle_excluded is
  'Household is barred from the raffle pool (no announceable name, staff decision). Admission and payment are unaffected.';

-- Partial: the flag is set on a handful of rows out of hundreds, and every
-- read is "who is NOT excluded".
create index if not exists households_raffle_excluded
  on households (raffle_excluded) where raffle_excluded;

-- --------------------------------------------------------------------------
-- draw_raffle_winner — unchanged except for the exclusion predicate, which
-- has to appear in BOTH queries. The count decides whether the pool is empty
-- and is snapshotted onto the draw row; the select picks the winner. If only
-- one of them learned about exclusion, the stage counter and the name drawn
-- would disagree, and an excluded household could still be picked.
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
     and not h.raffle_excluded
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
     and not h.raffle_excluded
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
