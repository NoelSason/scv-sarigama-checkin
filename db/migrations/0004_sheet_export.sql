-- ===========================================================================
-- Walk-in write-back to the payments sheet.
--
-- Walk-ins are created in the app, but the organizers' running record of who
-- paid is the spreadsheet. Without a write-back, anyone reading the sheet after
-- the event sees an incomplete picture of the money.
--
-- Tracked per household so an append happens exactly once: a second append
-- would show the same family twice to a human reading the sheet, even though
-- the importer would ignore both.
-- ===========================================================================

alter table households
  add column if not exists exported_to_sheet_at timestamptz;

-- Partial index: the export query only ever asks for the not-yet-exported ones.
create index if not exists households_pending_sheet_export
  on households (created_at)
  where exported_to_sheet_at is null and source = 'walk_in';
