-- ===========================================================================
-- Household merges.
--
-- One person who paid twice is two rows here: Square writes one per order, the
-- payments sheet one per line. Left alone they become two passes with two QR
-- codes, and a guest who shows only one is turned away holding a valid ticket
-- for admissions the volunteer cannot see.
--
-- The absorbed row is KEPT, not deleted. Deleting it would be undone within
-- minutes: the Square webhook upserts on `square_order_id` and the sheet sync
-- matches on `source_record_id`, so a vanished row is simply recreated on the
-- next sync — with a fresh pass token and its own ticket count, silently
-- double-counting the guest. Keeping the row means the re-sync still finds it,
-- updates it in place, and this pointer keeps it out of every guest-facing path.
-- ===========================================================================

alter table households
  add column if not exists merged_into_id uuid references households(id) on delete set null,
  add column if not exists merged_at      timestamptz;

-- A survivor cannot itself be merged away: chains would make "how many
-- admissions does this pass carry" depend on traversal order.
create or replace function assert_merge_target_is_survivor() returns trigger
language plpgsql as $$
begin
  if new.merged_into_id is not null then
    if new.merged_into_id = new.id then
      raise exception 'household % cannot be merged into itself', new.id;
    end if;
    if exists (select 1 from households
                where id = new.merged_into_id and merged_into_id is not null) then
      raise exception 'household % is already merged away and cannot be a merge target',
        new.merged_into_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists households_merge_target_check on households;
create trigger households_merge_target_check
  before insert or update of merged_into_id on households
  for each row execute function assert_merge_target_is_survivor();

-- Every read of "real households" filters on this, so it earns an index.
create index if not exists households_merged_into on households (merged_into_id)
  where merged_into_id is not null;

-- ---------------------------------------------------------------------------
-- Audit trail. The ledger must be able to answer "where did these 9 admissions
-- come from" months later, so the pre-merge numbers are recorded here rather
-- than overwritten in place.
-- ---------------------------------------------------------------------------
create table if not exists household_merges (
  id                  uuid primary key default gen_random_uuid(),
  survivor_id         uuid not null references households(id) on delete restrict,
  absorbed_id         uuid not null references households(id) on delete restrict,
  basis               text not null,          -- email | name | manual
  tickets_moved       integer not null,
  redeemed_moved      integer not null,
  absorbed_snapshot   jsonb not null,
  staff_user_id       uuid references staff_users(id) on delete set null,
  created_at          timestamptz not null default now(),

  constraint household_merges_absorbed_uniq unique (absorbed_id)
);

create index if not exists household_merges_survivor
  on household_merges (survivor_id, created_at desc);
