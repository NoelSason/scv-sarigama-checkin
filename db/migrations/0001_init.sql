-- ===========================================================================
-- SCV Sarigama Onam 2026 — check-in schema
--
-- Design rules encoded here:
--   * tickets_remaining is DERIVED, never independently stored, so it cannot
--     drift from the ledger.
--   * CHECK constraints are the last line of defence behind redeem_tickets().
--     Even a buggy caller cannot push tickets_redeemed past tickets_purchased.
--   * Under-6 children are recorded but are NOT redeemable admissions.
--   * Idempotency for imports/webhooks lives in UNIQUE constraints, not in
--     application logic.
--
-- Security model: this database has no public data API. It is reachable only
-- by the Next.js server holding DATABASE_URL. There is no anon key and no
-- PostgREST, so there is no browser-reachable surface to write RLS against.
-- ===========================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------
do $$ begin
  create type payment_status as enum (
    'unpaid', 'pending', 'paid', 'refunded', 'partially_refunded',
    'comped', 'needs_review'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum (
    'square', 'zelle', 'cash', 'complimentary', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type staff_role as enum ('admin', 'registration', 'scanner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type review_status as enum ('open', 'resolved', 'dismissed');
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------------------------
-- Staff — local auth. No third-party identity provider: five volunteers with
-- passwords set by an admin beforehand is the whole requirement, and magic
-- links are a bad idea at a venue where volunteers may not have inbox access.
-- --------------------------------------------------------------------------
create table if not exists staff_users (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null unique,
  name          text        not null,
  role          staff_role  not null default 'scanner',
  password_hash text        not null,      -- scrypt: salt:derivedKey, both hex
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists staff_sessions (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text        not null unique, -- sha256 of the cookie value
  staff_id    uuid        not null references staff_users(id) on delete cascade,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index if not exists staff_sessions_staff on staff_sessions (staff_id);

-- --------------------------------------------------------------------------
-- Import batches — every write-import is tagged so it can be rolled back
-- --------------------------------------------------------------------------
create table if not exists import_batches (
  id          uuid primary key default gen_random_uuid(),
  kind        text        not null,        -- square | google_sheets | manual
  status      text        not null default 'running',
                                           -- running|committed|rolled_back|failed
  stats       jsonb       not null default '{}'::jsonb,
  note        text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- --------------------------------------------------------------------------
-- Households — one purchase / family / household = one digital pass
-- --------------------------------------------------------------------------
create table if not exists households (
  id                 uuid primary key default gen_random_uuid(),

  display_name       text not null,
  email              text,
  phone              text,
  normalized_email   text,
  normalized_phone   text,

  payment_status     payment_status not null default 'unpaid',
  payment_method     payment_method,
  amount_paid_cents  integer,

  tickets_purchased  integer not null default 0,
  tickets_redeemed   integer not null default 0,
  -- Derived. Cannot drift.
  tickets_remaining  integer generated always as (tickets_purchased - tickets_redeemed) stored,

  -- Recorded for the desk and for honest headcount reporting.
  -- NEVER redeemable: under-6 children walk in free with no ticket.
  children_under_6   integer not null default 0,

  pass_token         text not null unique,
  pass_enabled       boolean not null default true,

  source             text,   -- google_sheets | square | walk_in | seed
  source_record_id   text,
  square_payment_id  text,
  square_order_id    text,
  import_batch_id    uuid references import_batches(id) on delete set null,

  is_test            boolean not null default false,
  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint tickets_purchased_non_negative check (tickets_purchased >= 0),
  constraint tickets_redeemed_non_negative  check (tickets_redeemed  >= 0),
  constraint children_under_6_non_negative  check (children_under_6  >= 0),
  -- The invariant the whole event depends on.
  constraint no_over_redemption             check (tickets_redeemed <= tickets_purchased)
);

-- Import idempotency: re-running a sync updates rather than duplicates.
create unique index if not exists households_source_record_uniq
  on households (source, source_record_id)
  where source_record_id is not null;

-- Webhook idempotency: one household per Square order, always.
create unique index if not exists households_square_order_uniq
  on households (square_order_id)
  where square_order_id is not null;

create index if not exists households_name_trgm   on households using gin (display_name gin_trgm_ops);
create index if not exists households_norm_email  on households (normalized_email) where normalized_email is not null;
create index if not exists households_norm_phone  on households (normalized_phone) where normalized_phone is not null;
create index if not exists households_status      on households (payment_status);
create index if not exists households_remaining   on households (tickets_remaining);

-- --------------------------------------------------------------------------
-- Redemptions — append-only. Never deleted in ordinary operation.
-- --------------------------------------------------------------------------
create table if not exists redemptions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete restrict,
  quantity      integer not null,
  staff_user_id uuid references staff_users(id) on delete set null,
  device_name   text,
  reversed_at   timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  constraint redemption_quantity_positive check (quantity > 0)
);

create index if not exists redemptions_household on redemptions (household_id, created_at desc);
create index if not exists redemptions_recent    on redemptions (created_at desc);

-- --------------------------------------------------------------------------
-- Adjustments — reversals and manual corrections. Immutable audit trail.
-- --------------------------------------------------------------------------
create table if not exists redemption_adjustments (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references households(id) on delete restrict,
  quantity_delta        integer not null,     -- +1 restores one admission
  reason                text not null,
  staff_user_id         uuid references staff_users(id) on delete set null,
  related_redemption_id uuid references redemptions(id) on delete set null,
  created_at            timestamptz not null default now(),

  constraint adjustment_delta_nonzero check (quantity_delta <> 0)
);

create index if not exists adjustments_household on redemption_adjustments (household_id, created_at desc);

-- --------------------------------------------------------------------------
-- Payment events — the webhook idempotency table
-- --------------------------------------------------------------------------
create table if not exists payment_events (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid references households(id) on delete set null,
  provider            text not null,
  external_event_id   text not null,
  external_payment_id text,
  external_order_id   text,
  event_type          text,
  amount_cents        integer,
  raw_metadata        jsonb not null default '{}'::jsonb,
  processed_at        timestamptz,
  error               text,
  created_at          timestamptz not null default now(),

  constraint payment_events_external_uniq unique (provider, external_event_id)
);

create index if not exists payment_events_order on payment_events (external_order_id);

-- --------------------------------------------------------------------------
-- Audit log
-- --------------------------------------------------------------------------
create table if not exists audit_logs (
  id           uuid primary key default gen_random_uuid(),
  actor_type   text not null,     -- staff | system | import | webhook | guest
  actor_id     text,
  action       text not null,
  household_id uuid references households(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_logs_household on audit_logs (household_id, created_at desc);
create index if not exists audit_logs_recent    on audit_logs (created_at desc);
create index if not exists audit_logs_action    on audit_logs (action, created_at desc);

-- --------------------------------------------------------------------------
-- Email delivery tracking
-- --------------------------------------------------------------------------
create table if not exists email_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid references households(id) on delete cascade,
  to_email            text not null,
  subject             text,
  status              text not null default 'pending',   -- pending|sent|failed
  provider            text,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);

create index if not exists email_deliveries_household on email_deliveries (household_id, created_at desc);
create index if not exists email_deliveries_status    on email_deliveries (status);

-- --------------------------------------------------------------------------
-- Review queue — anything we refuse to guess about lands here
-- --------------------------------------------------------------------------
create table if not exists review_items (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null,
  -- possible_duplicate | sheet_row_changed | unmapped_square_item
  -- | amount_mismatch | refund_after_redemption | missing_data
  household_id     uuid references households(id) on delete cascade,
  source           text,
  source_record_id text,
  summary          text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           review_status not null default 'open',
  resolved_by      uuid references staff_users(id) on delete set null,
  resolution       jsonb,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists review_items_status on review_items (status, created_at desc);
create unique index if not exists review_items_open_uniq
  on review_items (kind, coalesce(source, ''), coalesce(source_record_id, ''))
  where status = 'open';

-- --------------------------------------------------------------------------
-- Sync runs — powers the admin "last sync" health panel
-- --------------------------------------------------------------------------
create table if not exists sync_runs (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,     -- google_sheets | square
  status      text not null,     -- running | ok | failed
  dry_run     boolean not null default false,
  stats       jsonb not null default '{}'::jsonb,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists sync_runs_recent on sync_runs (source, started_at desc);

-- --------------------------------------------------------------------------
-- Public pass lookup rate limiting
-- --------------------------------------------------------------------------
create table if not exists pass_lookups (
  id         bigserial primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);

create index if not exists pass_lookups_window on pass_lookups (ip_hash, created_at desc);

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists households_set_updated_at on households;
create trigger households_set_updated_at
  before update on households
  for each row execute function set_updated_at();
