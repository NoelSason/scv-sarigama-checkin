-- ===========================================================================
-- One automatic pass email per household, per mailing, per total, per address.
--
-- What went wrong: Square delivered payment.created and payment.updated for the
-- same order within the same second, to two different serverless instances. The
-- webhook's own dedupe is keyed on the Square event id, and these were two
-- genuinely different events, so both were processed — correctly. Both then ran
-- the dispatcher, both asked "has this guest been sent their pass?", and because
-- neither had written a delivery row yet, both got the same answer: no. Two
-- identical passes arrived in the same inbox one second apart.
--
-- No amount of care in the SELECT fixes that. "Read, decide, then act" is a race
-- whenever two copies of the code can run at once, and on serverless they always
-- can. The decision has to be made by a write that only one of them can win.
--
-- So: the pending delivery row IS the claim. The dispatcher inserts it before
-- the network call, and this index means the second instance's insert simply
-- does nothing — no email, no second row.
--
-- The key is deliberately four columns wide, because each one is a case where a
-- second send is the correct behaviour and must stay possible:
--
--   household_id     obvious
--   kind             the week-of reminder is a different mailing from the pass
--   tickets_at_send  buying again makes the old pass understate the total
--   to_email         a corrected address never received the first one
--
-- Failed attempts drop out (status <> 'failed'), so a send that genuinely did
-- not leave the building is retried on the next run rather than being counted
-- as done.
--
-- Only automatic sends are constrained. A human at the registration desk asking
-- for a resend is not a race — it is a decision — and it must always work.
-- ===========================================================================

alter table email_deliveries
  add column if not exists auto boolean not null default false;

comment on column email_deliveries.auto is
  'True when the dispatcher sent this without a human asking. Such rows double as the claim that stops a second instance sending the same pass.';

create unique index if not exists email_deliveries_one_auto_send
  on email_deliveries (household_id, kind, coalesce(tickets_at_send, -1), lower(to_email))
  where auto and status <> 'failed';
