-- 0013_pos.sql — SaRiGaMa POS (in-person sales). Additive only; owned by PaymentPlatform.
--
-- Two new tables and nothing else: no ALTER, no DROP, no touch of any table the
-- check-in app reads. pgcrypto (gen_random_uuid) is already enabled by 0001.
--
-- Money is integer cents everywhere. pos_sales is the ledger; pos_items.stock is
-- advisory (the app gates on its cached catalog before taking payment, and the
-- server never refuses a well-formed sale for stock — see ARCHITECTURE.md §6).

create table pos_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  price_cents integer check (price_cents is null or price_cents >= 0), -- null = open amount
  stock       integer check (stock is null or stock >= 0),             -- null = unlimited
  category    text not null default 'General',
  color_hex   text not null default '#4F46E5',
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Devices poll `where updated_at > $cursor`; deactivations must reach them too,
-- so this index covers inactive rows on purpose.
create index pos_items_updated_at_idx on pos_items (updated_at);

create table pos_sales (
  id                       uuid primary key default gen_random_uuid(),
  idempotency_key          text not null,
  method                   text not null check (method in ('card','cash')),
  status                   text not null default 'paid' check (status in ('paid','refunded')),
  items                    jsonb not null,   -- [{itemId,name,unitPriceCents,quantity}] snapshot at sale time
  amount_total_cents       integer not null check (amount_total_cents >= 0),
  cash_tendered_cents      integer check (cash_tendered_cents is null or cash_tendered_cents >= amount_total_cents),
  stripe_payment_intent_id text,
  device_name              text,
  is_test                  boolean not null default false,
  taken_at                 timestamptz not null default now(),  -- client-reported sale time
  created_at               timestamptz not null default now(),  -- server receipt time
  refunded_at              timestamptz
);

-- The offline queue replays drafts until one succeeds; these two indexes are what
-- make a replay a no-op instead of a double charge. The bare `on conflict do
-- nothing` in POST /api/pos/sales relies on both.
create unique index pos_sales_idempotency_key_idx on pos_sales (idempotency_key);
create unique index pos_sales_stripe_pi_idx on pos_sales (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create index pos_sales_taken_at_idx on pos_sales (taken_at);

insert into pos_items (name, price_cents, stock, category, color_hex, sort_order) values
  ('Onam Sadhya Admission (6+)', 3000, null, 'Admission', '#0E7490', 0),
  ('Under 6',                    0,    null, 'Admission', '#0EA5E9', 1),
  ('Community Donation',         null, null, 'Donations', '#B45309', 2),
  ('SaRiGaMa T-Shirt',           2000, 25,   'Merch',     '#6D28D9', 3);
