-- ===========================================================================
-- Stripe joins the ledger.
--
-- The new storefront at pay.scvsarigama.com sells admissions through Stripe
-- Checkout and provisions passes directly into this database so they scan
-- with the existing system. Its rows arrive with source = 'stripe' (source is
-- free text — no DDL needed) and source_record_id = the Checkout Session id,
-- which the existing (source, source_record_id) unique index already makes
-- idempotent. The only thing the schema lacks is the payment method itself.
--
-- ALTER TYPE ... ADD VALUE is safe inside the runner's per-file transaction
-- as long as the new value is not used in the same transaction; this file
-- only adds it.
-- ===========================================================================

alter type payment_method add value if not exists 'stripe';
