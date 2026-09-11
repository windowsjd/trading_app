-- Remove the legacy SeasonParticipant ownership copy from account-owned rows.
--
-- TradingAccount is already NOT NULL and foreign-keyed on every table below.
-- This migration first proves that the redundant participant value agrees with
-- that canonical account and that account-scoped uniqueness/indexes exist. It
-- then removes only participant FKs/indexes/columns. No row value is updated.

BEGIN;

-- Every season-owned row must resolve through its canonical account to exactly
-- the participant stored on the legacy column. General accounts must have no
-- participant and must carry NULL in the legacy column.
DO $$
DECLARE
  table_name text;
  finding_count bigint;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cash_wallets',
    'wallet_transactions',
    'exchange_transactions',
    'fx_execute_requests',
    'orders',
    'positions',
    'quotes',
    'equity_snapshots',
    'daily_portfolio_snapshots'
  ]
  LOOP
    EXECUTE format(
      'SELECT count(*)
         FROM %I row
         JOIN trading_accounts ta ON ta.id = row.trading_account_id
         LEFT JOIN season_participants sp ON sp.trading_account_id = ta.id
        WHERE (ta.mode = ''season''::"TradingAccountMode" AND (
                 sp.id IS NULL
                 OR row.season_participant_id IS DISTINCT FROM sp.id
               ))
           OR (ta.mode = ''general''::"TradingAccountMode" AND (
                 sp.id IS NOT NULL
                 OR row.season_participant_id IS NOT NULL
               ))',
      table_name
    ) INTO finding_count;

    IF finding_count > 0 THEN
      RAISE EXCEPTION
        'remove_legacy_financial_participant_scope: table % has % row(s) whose canonical TradingAccount mode/participant mapping disagrees with the legacy season_participant_id. Nothing was changed.',
        table_name,
        finding_count;
    END IF;
  END LOOP;
END
$$;

-- Direct child relationships must already agree on canonical account scope.
DO $$
DECLARE
  finding_count bigint;
BEGIN
  SELECT count(*) INTO finding_count
  FROM "wallet_transactions" wt
  JOIN "cash_wallets" w ON w."id" = wt."wallet_id"
  WHERE wt."trading_account_id" <> w."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'remove_legacy_financial_participant_scope: % WalletTransaction row(s) disagree with their CashWallet trading_account_id.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "orders" o
  JOIN "quotes" q ON q."id" = o."quote_id"
  WHERE o."trading_account_id" <> q."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'remove_legacy_financial_participant_scope: % Order row(s) disagree with their Quote trading_account_id.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "fx_execute_requests" r
  JOIN "exchange_transactions" e ON e."id" = r."exchange_transaction_id"
  WHERE r."trading_account_id" <> e."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'remove_legacy_financial_participant_scope: % FxExecuteRequest row(s) disagree with their ExchangeTransaction trading_account_id.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "quotes" q
  JOIN "trading_accounts" ta ON ta."id" = q."trading_account_id"
  WHERE q."user_id" <> ta."user_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'remove_legacy_financial_participant_scope: % Quote row(s) belong to a different user than their TradingAccount.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "fx_execute_requests" r
  JOIN "trading_accounts" ta ON ta."id" = r."trading_account_id"
  WHERE r."user_id" <> ta."user_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'remove_legacy_financial_participant_scope: % FxExecuteRequest row(s) belong to a different user than their TradingAccount.',
      finding_count;
  END IF;
END
$$;

-- Abort before dropping anything if an account-scoped uniqueness/lookup index
-- that replaces a participant-scoped index is unexpectedly absent.
DO $$
DECLARE
  index_name text;
BEGIN
  FOREACH index_name IN ARRAY ARRAY[
    'cash_wallets_trading_account_id_currency_code_key',
    'cash_wallets_trading_account_id_idx',
    'wallet_transactions_trading_account_id_occurred_at_idx',
    'exchange_transactions_trading_account_id_executed_at_idx',
    'fx_execute_requests_trading_account_id_idempotency_key_key',
    'fx_execute_requests_trading_account_id_requested_at_idx',
    'orders_trading_account_id_idempotency_key_key',
    'orders_trading_account_id_submitted_at_idx',
    'orders_trading_account_id_status_idx',
    'positions_trading_account_id_asset_id_key',
    'positions_trading_account_id_idx',
    'quotes_trading_account_id_created_at_idx',
    'quotes_trading_account_id_status_expires_at_idx',
    'equity_snapshots_trading_account_id_captured_at_idx',
    'daily_portfolio_snapshots_trading_account_id_snapshot_date_key',
    'daily_portfolio_snapshots_trading_account_id_captured_at_idx'
  ]
  LOOP
    IF to_regclass('public.' || index_name) IS NULL THEN
      RAISE EXCEPTION
        'remove_legacy_financial_participant_scope: required canonical account index % is missing. Nothing was changed.',
        index_name;
    END IF;
  END LOOP;
END
$$;

-- Legacy participant foreign keys.
ALTER TABLE "cash_wallets" DROP CONSTRAINT "cash_wallets_season_participant_id_fkey";
ALTER TABLE "wallet_transactions" DROP CONSTRAINT "wallet_transactions_season_participant_id_fkey";
ALTER TABLE "exchange_transactions" DROP CONSTRAINT "exchange_transactions_season_participant_id_fkey";
ALTER TABLE "fx_execute_requests" DROP CONSTRAINT "fx_execute_requests_season_participant_id_fkey";
ALTER TABLE "orders" DROP CONSTRAINT "orders_season_participant_id_fkey";
ALTER TABLE "positions" DROP CONSTRAINT "positions_season_participant_id_fkey";
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_season_participant_id_fkey";
ALTER TABLE "equity_snapshots" DROP CONSTRAINT "equity_snapshots_season_participant_id_fkey";
ALTER TABLE "daily_portfolio_snapshots" DROP CONSTRAINT "daily_portfolio_snapshots_season_participant_id_fkey";

-- Legacy participant uniqueness and lookup indexes.
DROP INDEX "cash_wallets_season_participant_id_currency_code_key";
DROP INDEX "cash_wallets_season_participant_id_idx";
DROP INDEX "wallet_transactions_season_participant_id_occurred_at_idx";
DROP INDEX "exchange_transactions_season_participant_id_executed_at_idx";
DROP INDEX "fx_execute_requests_season_participant_id_requested_at_idx";
DROP INDEX "orders_season_participant_id_idempotency_key_key";
DROP INDEX "orders_season_participant_id_submitted_at_idx";
DROP INDEX "orders_season_participant_id_status_idx";
DROP INDEX "positions_season_participant_id_asset_id_key";
DROP INDEX "positions_season_participant_id_idx";
DROP INDEX "quotes_season_participant_id_created_at_idx";
DROP INDEX "equity_snapshots_season_participant_id_captured_at_idx";
DROP INDEX "daily_portfolio_snapshots_season_participant_id_snapshot_da_key";
DROP INDEX "daily_portfolio_snapshots_season_participant_id_captured_at_idx";

-- The account id is NOT NULL now, so this transitional NULL-account partial
-- unique can never match a row. Account idempotency remains protected by the
-- required unique checked above.
DROP INDEX "fx_execute_requests_user_id_idempotency_key_legacy_null_key";

-- Remove only redundant ownership columns. Financial values, lifecycle state,
-- idempotency keys, timestamps, and season-domain rows are untouched.
ALTER TABLE "cash_wallets" DROP COLUMN "season_participant_id";
ALTER TABLE "wallet_transactions" DROP COLUMN "season_participant_id";
ALTER TABLE "exchange_transactions" DROP COLUMN "season_participant_id";
ALTER TABLE "fx_execute_requests" DROP COLUMN "season_participant_id";
ALTER TABLE "orders" DROP COLUMN "season_participant_id";
ALTER TABLE "positions" DROP COLUMN "season_participant_id";
ALTER TABLE "quotes" DROP COLUMN "season_participant_id";
ALTER TABLE "equity_snapshots" DROP COLUMN "season_participant_id";
ALTER TABLE "daily_portfolio_snapshots" DROP COLUMN "season_participant_id";

COMMIT;
