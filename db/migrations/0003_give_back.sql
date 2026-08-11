-- ===========================================================================
-- give_back_tickets — restore N admissions to a household, without the caller
-- needing to know which redemption they came from.
--
-- reverse_redemption() needs a specific redemption id, which is fine for
-- undoing the scan you just made. But at the Sadhya line the common case is
-- "this family was over-counted earlier today" — the volunteer knows the
-- family and the number, not which scan was wrong.
--
-- So this walks the household's redemptions newest-first and unwinds them
-- until N admissions are back, writing one compensating adjustment per
-- redemption touched. Nothing is deleted; the history keeps both the original
-- scans and the corrections.
-- ===========================================================================

create or replace function give_back_tickets(
  p_household uuid,
  p_quantity  integer,
  p_reason    text,
  p_staff     uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_row       households%rowtype;
  v_needed    integer;
  v_take      integer;
  v_rec       record;
begin
  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY');
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  end if;

  -- Lock the household for the duration so two volunteers can't both give back
  -- the same admissions.
  select * into v_row from households where id = p_household for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'PASS_NOT_FOUND');
  end if;

  if p_quantity > v_row.tickets_redeemed then
    return jsonb_build_object(
      'success', false, 'error', 'INSUFFICIENT_REDEEMED',
      'display_name',     v_row.display_name,
      'tickets_redeemed', v_row.tickets_redeemed
    );
  end if;

  v_needed := p_quantity;

  -- Newest first: the most recent scan is overwhelmingly the one that was
  -- wrong, and unwinding it keeps the history easiest to read afterwards.
  for v_rec in
    select r.id,
           r.quantity - coalesce(
             (select sum(a.quantity_delta)
                from redemption_adjustments a
               where a.related_redemption_id = r.id), 0) as outstanding
      from redemptions r
     where r.household_id = p_household
     order by r.created_at desc
  loop
    exit when v_needed <= 0;
    continue when v_rec.outstanding <= 0;

    v_take := least(v_needed, v_rec.outstanding);

    insert into redemption_adjustments
        (household_id, quantity_delta, reason, staff_user_id, related_redemption_id)
      values (p_household, v_take, p_reason, p_staff, v_rec.id);

    if v_take = v_rec.outstanding then
      update redemptions set reversed_at = now() where id = v_rec.id;
    end if;

    v_needed := v_needed - v_take;
  end loop;

  -- Defensive: adjustments must account for the whole amount. If the ledger
  -- and the redemption rows ever disagreed, we would rather fail loudly than
  -- hand out admissions nobody can explain.
  if v_needed > 0 then
    raise exception 'give_back_tickets: only % of % could be attributed',
      p_quantity - v_needed, p_quantity;
  end if;

  update households
     set tickets_redeemed = tickets_redeemed - p_quantity,
         updated_at       = now()
   where id = p_household
     and tickets_redeemed - p_quantity >= 0
  returning * into v_row;

  if not found then
    raise exception 'give_back_tickets: would drive tickets_redeemed negative';
  end if;

  insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
       values ('staff', p_staff::text, 'tickets_given_back', p_household,
               jsonb_build_object('restored', p_quantity,
                                  'reason', p_reason,
                                  'tickets_remaining_after', v_row.tickets_remaining));

  return jsonb_build_object(
    'success',           true,
    'restored',          p_quantity,
    'display_name',      v_row.display_name,
    'tickets_purchased', v_row.tickets_purchased,
    'tickets_redeemed',  v_row.tickets_redeemed,
    'tickets_remaining', v_row.tickets_remaining
  );
end $$;
