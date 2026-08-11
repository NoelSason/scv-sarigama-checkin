-- ===========================================================================
-- Atomic ticket operations.
--
-- The whole event rests on redeem_tickets(). The guard lives in the WHERE
-- clause of a single UPDATE, so Postgres row-level locking serializes
-- concurrent scans for us. Two devices redeeming 3 against a household with 3
-- remaining: exactly one UPDATE matches, the other finds no row.
--
-- What this deliberately does NOT do: read the balance, decide in application
-- code, then write. That is the race condition this file exists to prevent.
--
-- Each function is a single statement from the client's point of view, so it
-- is atomic without the caller needing to open a transaction.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- redeem_tickets — consume N admissions
-- --------------------------------------------------------------------------
create or replace function redeem_tickets(
  p_household uuid,
  p_quantity  integer,
  p_staff     uuid  default null,
  p_device    text  default null,
  p_metadata  jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_row        households%rowtype;
  v_redemption uuid;
begin
  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY');
  end if;

  -- The single authoritative statement. Every precondition is in the WHERE.
  update households
     set tickets_redeemed = tickets_redeemed + p_quantity,
         updated_at       = now()
   where id = p_household
     and pass_enabled = true
     and payment_status in ('paid', 'comped')
     and tickets_redeemed + p_quantity <= tickets_purchased
  returning * into v_row;

  if not found then
    -- Nothing was mutated. Re-read only to explain why, never to retry.
    select * into v_row from households where id = p_household;

    if not found then
      return jsonb_build_object('success', false, 'error', 'PASS_NOT_FOUND');
    elsif not v_row.pass_enabled then
      return jsonb_build_object('success', false, 'error', 'PASS_DISABLED',
                                'display_name', v_row.display_name);
    elsif v_row.payment_status not in ('paid', 'comped') then
      return jsonb_build_object('success', false, 'error', 'NOT_PAID',
                                'display_name',   v_row.display_name,
                                'payment_status', v_row.payment_status);
    else
      return jsonb_build_object('success', false, 'error', 'INSUFFICIENT_TICKETS',
                                'display_name',      v_row.display_name,
                                'requested',         p_quantity,
                                'tickets_purchased', v_row.tickets_purchased,
                                'tickets_redeemed',  v_row.tickets_redeemed,
                                'tickets_remaining', v_row.tickets_remaining);
    end if;
  end if;

  insert into redemptions (household_id, quantity, staff_user_id, device_name, metadata)
       values (p_household, p_quantity, p_staff, p_device, coalesce(p_metadata, '{}'::jsonb))
    returning id into v_redemption;

  insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
       values ('staff', p_staff::text, 'redemption', p_household,
               jsonb_build_object('quantity', p_quantity,
                                  'redemption_id', v_redemption,
                                  'device', p_device,
                                  'tickets_remaining_after', v_row.tickets_remaining));

  return jsonb_build_object(
    'success',           true,
    'redemption_id',     v_redemption,
    'display_name',      v_row.display_name,
    'redeemed_now',      p_quantity,
    'tickets_purchased', v_row.tickets_purchased,
    'tickets_redeemed',  v_row.tickets_redeemed,
    'tickets_remaining', v_row.tickets_remaining
  );
end $$;

-- --------------------------------------------------------------------------
-- reverse_redemption — undo a mistaken scan
--
-- Never deletes the original redemption row. Writes a compensating adjustment
-- so the history shows both what happened and what corrected it.
-- --------------------------------------------------------------------------
create or replace function reverse_redemption(
  p_redemption uuid,
  p_quantity   integer,
  p_reason     text,
  p_staff      uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_redemption redemptions%rowtype;
  v_row        households%rowtype;
  v_already    integer;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  end if;

  select * into v_redemption from redemptions where id = p_redemption for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'REDEMPTION_NOT_FOUND');
  end if;

  if p_quantity is null or p_quantity <= 0 or p_quantity > v_redemption.quantity then
    return jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY',
                              'max_reversible', v_redemption.quantity);
  end if;

  -- Cannot reverse more than is still outstanding on this redemption.
  select coalesce(sum(quantity_delta), 0) into v_already
    from redemption_adjustments
   where related_redemption_id = p_redemption;

  if v_already + p_quantity > v_redemption.quantity then
    return jsonb_build_object('success', false, 'error', 'ALREADY_REVERSED',
                              'already_reversed', v_already,
                              'max_reversible', v_redemption.quantity - v_already);
  end if;

  update households
     set tickets_redeemed = tickets_redeemed - p_quantity,
         updated_at       = now()
   where id = v_redemption.household_id
     and tickets_redeemed - p_quantity >= 0
  returning * into v_row;

  if not found then
    return jsonb_build_object('success', false, 'error', 'WOULD_GO_NEGATIVE');
  end if;

  insert into redemption_adjustments
      (household_id, quantity_delta, reason, staff_user_id, related_redemption_id)
    values (v_redemption.household_id, p_quantity, p_reason, p_staff, p_redemption);

  if v_already + p_quantity = v_redemption.quantity then
    update redemptions set reversed_at = now() where id = p_redemption;
  end if;

  insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
       values ('staff', p_staff::text, 'redemption_reversal', v_redemption.household_id,
               jsonb_build_object('redemption_id', p_redemption,
                                  'restored', p_quantity,
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

-- --------------------------------------------------------------------------
-- adjust_ticket_count — admin correction of what a household bought
--
-- Refuses to drop tickets_purchased below what has already been eaten.
-- --------------------------------------------------------------------------
create or replace function adjust_ticket_count(
  p_household uuid,
  p_new_total integer,
  p_reason    text,
  p_staff     uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_row households%rowtype;
  v_old integer;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  end if;
  if p_new_total is null or p_new_total < 0 then
    return jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY');
  end if;

  select tickets_purchased into v_old from households where id = p_household;
  if not found then
    return jsonb_build_object('success', false, 'error', 'PASS_NOT_FOUND');
  end if;

  update households
     set tickets_purchased = p_new_total,
         updated_at        = now()
   where id = p_household
     and p_new_total >= tickets_redeemed
  returning * into v_row;

  if not found then
    select * into v_row from households where id = p_household;
    return jsonb_build_object('success', false, 'error', 'BELOW_REDEEMED',
                              'tickets_redeemed', v_row.tickets_redeemed);
  end if;

  insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
       values ('staff', p_staff::text, 'ticket_count_adjusted', p_household,
               jsonb_build_object('from', v_old, 'to', p_new_total, 'reason', p_reason));

  return jsonb_build_object(
    'success',           true,
    'tickets_purchased', v_row.tickets_purchased,
    'tickets_redeemed',  v_row.tickets_redeemed,
    'tickets_remaining', v_row.tickets_remaining
  );
end $$;
