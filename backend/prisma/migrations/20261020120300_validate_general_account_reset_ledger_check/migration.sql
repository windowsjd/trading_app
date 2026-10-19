-- Validates wallet_transactions_account_reset_reference_check (added NOT VALID
-- by 20261020120100_add_general_account_resets) on its own (2026-10-20).
-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE: ledger reads and
-- writes continue during the scan, and no row is rewritten. No existing row
-- carries account_reset or general_account_reset, so it cannot fail.
ALTER TABLE "wallet_transactions" VALIDATE CONSTRAINT "wallet_transactions_account_reset_reference_check";
