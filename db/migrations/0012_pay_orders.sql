-- ===========================================================================
-- The storefront's order ledger.
--
-- households answers "who gets admitted"; it deliberately has no row for a
-- donation-only or sponsorship-only payment, and no column for what else a
-- ticket order carried. pay_orders answers "what was bought": one row per
-- Stripe Checkout order from pay.scvsarigama.com, carrying the payment
-- breakdown AND the Onam Program Registration answers collected at checkout
-- (the Google Form this replaces was closed).
--
-- Rows are inserted 'pending' when checkout begins and flipped to 'paid' by
-- the payment webhook — so an abandoned checkout leaves a pending row that
-- simply never exports. The Apps Script pulls paid rows into the
-- "Stripe Orders" tab of the payments sheet through the same
-- fetch-then-confirm loop the walk-ins use (exported_to_sheet_at).
-- ===========================================================================

create table if not exists pay_orders (
  id                  uuid primary key default gen_random_uuid(),
  stripe_session_id   text not null,
  order_number        text not null,
  household_id        uuid references households(id) on delete set null,

  customer_name       text not null,
  email               text,
  phone               text,

  amount_total_cents  integer not null default 0,
  adults              integer not null default 0,
  kids                integer not null default 0,
  sponsor_gold        integer not null default 0,
  sponsor_silver      integer not null default 0,
  donation_cents      integer not null default 0,

  -- 2026 SaRiGaMa Onam Program Registration ------------------------------
  perform_interested  boolean,
  perform_name        text,
  perform_kind        text check (perform_kind in ('individual', 'group')),
  perform_members     text,
  perform_type        text check (perform_type in ('song', 'dance', 'skit', 'instruments', 'other')),
  perform_type_other  text,
  perform_media       boolean,
  perform_stage       boolean,
  perform_notes       text,

  status              text not null default 'pending' check (status in ('pending', 'paid', 'refunded')),
  is_test             boolean not null default false,
  exported_to_sheet_at timestamptz,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);

-- Webhook idempotency: one order per Checkout Session, always.
create unique index if not exists pay_orders_session_uniq
  on pay_orders (stripe_session_id);

create index if not exists pay_orders_export
  on pay_orders (status, exported_to_sheet_at, created_at);

comment on table pay_orders is
  'One row per Stripe Checkout order from pay.scvsarigama.com: payment breakdown + Onam program registration. pending until the webhook confirms payment.';
