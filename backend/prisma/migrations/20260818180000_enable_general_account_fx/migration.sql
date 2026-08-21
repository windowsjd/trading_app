-- General FX rows are account-scoped and intentionally have no season
-- participant. Existing season rows and their participant links are left
-- untouched; only the two transitional foreign-key columns become nullable.
ALTER TABLE "exchange_transactions"
  ALTER COLUMN "season_participant_id" DROP NOT NULL;

ALTER TABLE "fx_execute_requests"
  ALTER COLUMN "season_participant_id" DROP NOT NULL;
