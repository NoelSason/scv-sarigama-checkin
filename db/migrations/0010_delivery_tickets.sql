-- ===========================================================================
-- How many admissions a pass email claimed when it was sent.
--
-- Without this, "have they been sent their pass?" is the only question the
-- dispatcher can ask, and the answer stops being useful the moment somebody
-- buys again: they hold an email saying 2 while the ledger says 5, and nothing
-- will ever correct it because a pass was, technically, sent.
--
-- Recording the count turns it into "have they been sent their CURRENT pass?",
-- which is the question that actually matters after a second purchase.
-- ===========================================================================

alter table email_deliveries
  add column if not exists tickets_at_send integer;

comment on column email_deliveries.tickets_at_send is
  'tickets_purchased at the moment this email was sent. A later purchase makes the delivery stale and the dispatcher re-sends with the new total.';
