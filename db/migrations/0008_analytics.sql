-- ===========================================================================
-- Security audit trail.
--
-- audit_logs already recorded WHAT happened. For a high-profile event the
-- questions asked afterwards are WHO, FROM WHERE, and ON WHAT — so every entry
-- now also carries the caller's address, approximate location, device, and the
-- route that produced it.
--
-- Location comes from Vercel's edge headers, which are attached to the request
-- before it reaches us. No third-party geo-IP call, no extra latency, and no
-- guest or volunteer data leaving the request path to be looked up elsewhere.
--
-- `seq` exists because uuids do not sort. The export needs a cursor that can say
-- "everything after row N" without re-reading the whole table every few minutes.
-- ===========================================================================

alter table audit_logs
  add column if not exists ip           text,
  add column if not exists user_agent   text,
  add column if not exists geo_city     text,
  add column if not exists geo_region   text,
  add column if not exists geo_country  text,
  add column if not exists request_path text;

-- bigserial backfills existing rows in insertion order, which is what we want.
alter table audit_logs add column if not exists seq bigserial;

create index if not exists audit_logs_seq on audit_logs (seq);

-- Sessions gain the same context, so a login can be tied to a place, not just a
-- browser string.
alter table staff_sessions
  add column if not exists ip          text,
  add column if not exists geo_city    text,
  add column if not exists geo_region  text,
  add column if not exists geo_country text;

-- Redemptions are the highest-value security record here: they are the moment a
-- meal is released. Record where the scan came from, not only which device
-- typed a name into the box.
alter table redemptions
  add column if not exists ip          text,
  add column if not exists geo_city    text,
  add column if not exists geo_region  text,
  add column if not exists geo_country text,
  add column if not exists user_agent  text;

-- ---------------------------------------------------------------------------
-- One stream over every table that records something happening.
--
-- A view rather than a table: it cannot drift from its sources, it needs no
-- backfill, and nothing has to remember to write to two places. `event_id` is
-- stable and unique so the sheet can append without ever duplicating a row.
-- ---------------------------------------------------------------------------
create or replace view event_stream as

  select
    'audit:' || a.id                     as event_id,
    a.created_at                         as occurred_at,
    'action'                             as category,
    a.action                             as action,
    coalesce(s.name, a.actor_type)       as actor,
    a.actor_type                         as actor_type,
    s.role::text                         as actor_role,
    s.email                              as actor_email,
    a.ip                                 as ip,
    nullif(concat_ws(', ', a.geo_city, a.geo_region, a.geo_country), '') as location,
    a.user_agent                         as user_agent,
    a.request_path                       as request_path,
    h.display_name                       as household,
    a.household_id                       as household_id,
    a.metadata::text                     as detail
  from audit_logs a
  left join staff_users s on s.id::text = a.actor_id
  left join households  h on h.id = a.household_id

  union all

  select
    'redeem:' || r.id,
    r.created_at,
    'redemption',
    case when r.reversed_at is null then 'admissions_redeemed' else 'admissions_redeemed_then_reversed' end,
    coalesce(s.name, r.device_name, 'unknown'),
    'staff',
    s.role::text,
    s.email,
    r.ip,
    nullif(concat_ws(', ', r.geo_city, r.geo_region, r.geo_country), ''),
    r.user_agent,
    '/api/staff/redeem',
    h.display_name,
    r.household_id,
    json_build_object('quantity', r.quantity, 'device', r.device_name,
                      'reversed_at', r.reversed_at)::text
  from redemptions r
  left join staff_users s on s.id = r.staff_user_id
  left join households  h on h.id = r.household_id

  union all

  select
    'adjust:' || adj.id,
    adj.created_at,
    'adjustment',
    'admissions_adjusted',
    coalesce(s.name, 'system'),
    'staff',
    s.role::text,
    s.email,
    null, null, null,
    '/api/staff/admin/reversal',
    h.display_name,
    adj.household_id,
    json_build_object('delta', adj.quantity_delta, 'reason', adj.reason)::text
  from redemption_adjustments adj
  left join staff_users s on s.id = adj.staff_user_id
  left join households  h on h.id = adj.household_id

  union all

  select
    'payment:' || p.id,
    p.created_at,
    'payment',
    coalesce(p.event_type, p.provider || '_payment'),
    p.provider,
    'webhook',
    null, null, null, null, null,
    '/api/webhooks/square',
    h.display_name,
    p.household_id,
    json_build_object('amount_cents', p.amount_cents, 'order_id', p.external_order_id,
                      'payment_id', p.external_payment_id, 'error', p.error)::text
  from payment_events p
  left join households h on h.id = p.household_id

  union all

  select
    'email:' || e.id,
    coalesce(e.sent_at, e.created_at),
    'email',
    'pass_email_' || e.status,
    coalesce(e.provider, 'email'),
    'system',
    null, null, null, null, null,
    '/api/staff/email',
    h.display_name,
    e.household_id,
    json_build_object('to', e.to_email, 'subject', e.subject,
                      'message_id', e.provider_message_id, 'error', e.error)::text
  from email_deliveries e
  left join households h on h.id = e.household_id

  union all

  select
    'session:' || ss.id,
    ss.created_at,
    'login',
    case when ss.revoked_at is null then 'session_started' else 'session_revoked' end,
    coalesce(s.name, 'unknown'),
    'staff',
    s.role::text,
    s.email,
    ss.ip,
    nullif(concat_ws(', ', ss.geo_city, ss.geo_region, ss.geo_country), ''),
    ss.user_agent,
    '/staff/login',
    null, null,
    json_build_object('expires_at', ss.expires_at, 'revoked_at', ss.revoked_at)::text
  from staff_sessions ss
  left join staff_users s on s.id = ss.staff_id

  union all

  select
    'sync:' || sr.id,
    sr.started_at,
    'sync',
    'sync_' || sr.source || '_' || sr.status,
    sr.source,
    'system',
    null, null, null, null, null,
    '/api/sync/sheet-push',
    null, null,
    json_build_object('dry_run', sr.dry_run, 'stats', sr.stats, 'error', sr.error)::text
  from sync_runs sr

  union all

  select
    'review:' || ri.id,
    ri.created_at,
    'review',
    'review_' || ri.kind || '_' || ri.status::text,
    coalesce(s.name, 'system'),
    'system',
    s.role::text,
    s.email,
    null, null, null,
    '/staff/admin/review',
    h.display_name,
    ri.household_id,
    json_build_object('summary', ri.summary, 'resolved_at', ri.resolved_at)::text
  from review_items ri
  left join staff_users s on s.id = ri.resolved_by
  left join households  h on h.id = ri.household_id;

comment on view event_stream is
  'Every recorded event across the app, one row each, for the Event Analytics tab.';
