-- No account creation/backfill or financial data modification.
-- Closed/suspended accounts also consume the user's single lifetime account.
CREATE UNIQUE INDEX "trading_accounts_beginner_owner_unique"
    ON "trading_accounts"("user_id")
    WHERE "mode" = 'beginner';
