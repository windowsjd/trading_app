-- TradingAccount canonical ownership hardening.
--
-- Legacy season_participant_id columns, foreign keys, indexes, uniques, and
-- dual-write behavior are deliberately retained for the next removal work.
-- This migration changes only account-scope identifiers:
--   1. fail closed on participant/account ownership corruption,
--   2. fill a NULL row.trading_account_id only from that row's own verified
--      SeasonParticipant link,
--   3. fail if any NULL or mismatch remains,
--   4. make the canonical account link NOT NULL.
--
-- It never updates balances, reservations, quantities, costs, PnL, order or
-- request status, prices, fees, rates, hashes, idempotency keys, snapshots,
-- ranks, participant/season state, or timestamps.

BEGIN;

-- -------------------------------------------------------------------------
-- 1) The participant -> season account link must already be deterministic.
-- Missing links must be handled by the existing explicit repair-links flow;
-- this migration does not create or guess TradingAccount rows.
DO $$
DECLARE
  finding_count bigint;
BEGIN
  SELECT count(*) INTO finding_count
  FROM "season_participants" sp
  WHERE sp."trading_account_id" IS NULL;

  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % SeasonParticipant row(s) have no trading_account_id. Stop old writers and run trading-accounts:repair-links --apply before this migration; no account is guessed here.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "season_participants" sp
  LEFT JOIN "trading_accounts" ta
    ON ta."id" = sp."trading_account_id"
  WHERE ta."id" IS NULL
     OR ta."mode" <> 'season'::"TradingAccountMode"
     OR ta."user_id" <> sp."user_id"
     OR ta."initial_capital_krw" IS DISTINCT FROM sp."initial_capital_krw"
     OR ta."opened_at" IS DISTINCT FROM sp."joined_at";

  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % SeasonParticipant row(s) are linked to a missing, non-season, different-user, or foundation-mismatched TradingAccount. Nothing was changed; investigate manually.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "trading_accounts" ta
  LEFT JOIN "season_participants" sp
    ON sp."trading_account_id" = ta."id"
  WHERE ta."mode" = 'season'::"TradingAccountMode"
    AND sp."id" IS NULL;

  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % season TradingAccount row(s) have no participant. A second/orphan account cannot be attributed safely; investigate manually.',
      finding_count;
  END IF;
END
$$;

-- -------------------------------------------------------------------------
-- 2) Reject every already-non-null row whose two identities disagree. A
-- non-null account id is never overwritten, even when the participant link
-- looks plausible: one of the stored identities is damaged and SQL cannot
-- decide which one is authoritative historically.
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
    'daily_portfolio_snapshots',
    'season_rankings'
  ]
  LOOP
    EXECUTE format(
      'SELECT count(*)
         FROM %I row
         JOIN trading_accounts ta ON ta.id = row.trading_account_id
         LEFT JOIN season_participants sp ON sp.id = row.season_participant_id
        WHERE row.trading_account_id IS NOT NULL
          AND (
            (row.season_participant_id IS NULL AND ta.mode <> ''general''::"TradingAccountMode")
            OR
            (row.season_participant_id IS NOT NULL AND (
              sp.id IS NULL
              OR sp.trading_account_id IS DISTINCT FROM row.trading_account_id
              OR ta.mode <> ''season''::"TradingAccountMode"
              OR ta.user_id <> sp.user_id
            ))
          )',
      table_name
    ) INTO finding_count;

    IF finding_count > 0 THEN
      RAISE EXCEPTION
        'make_trading_account_canonical_scope: table % has % already-scoped row(s) whose participant/account ownership or mode disagrees. Non-null scope is never overwritten.',
        table_name,
        finding_count;
    END IF;
  END LOOP;
END
$$;

-- Row-local relationships that must agree with the canonical account.
DO $$
DECLARE
  finding_count bigint;
BEGIN
  SELECT count(*) INTO finding_count
  FROM "wallet_transactions" wt
  JOIN "cash_wallets" w ON w."id" = wt."wallet_id"
  WHERE wt."trading_account_id" IS DISTINCT FROM w."trading_account_id"
     OR wt."season_participant_id" IS DISTINCT FROM w."season_participant_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % WalletTransaction row(s) disagree with their CashWallet scope.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "orders" o
  JOIN "quotes" q ON q."id" = o."quote_id"
  WHERE o."trading_account_id" IS DISTINCT FROM q."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % Order row(s) disagree with their Quote account scope.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "fx_execute_requests" r
  JOIN "exchange_transactions" e ON e."id" = r."exchange_transaction_id"
  WHERE r."trading_account_id" IS DISTINCT FROM e."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % FxExecuteRequest row(s) disagree with their ExchangeTransaction account scope.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "quotes" q
  JOIN "trading_accounts" ta ON ta."id" = q."trading_account_id"
  WHERE q."user_id" <> ta."user_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % Quote row(s) belong to a different user than their TradingAccount.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "fx_execute_requests" r
  JOIN "trading_accounts" ta ON ta."id" = r."trading_account_id"
  WHERE r."user_id" <> ta."user_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % FxExecuteRequest row(s) belong to a different user than their TradingAccount.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "season_rankings" sr
  JOIN "season_participants" sp ON sp."id" = sr."season_participant_id"
  WHERE sr."season_id" <> sp."season_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % SeasonRanking row(s) disagree with their participant season.',
      finding_count;
  END IF;
END
$$;

-- -------------------------------------------------------------------------
-- 3) Conservative backfill. Only NULL account identifiers are copied, and
-- only from the same row's already-verified participant link.
DO $$
DECLARE
  table_name text;
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
    'daily_portfolio_snapshots',
    'season_rankings'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I row
          SET trading_account_id = sp.trading_account_id
         FROM season_participants sp
         JOIN trading_accounts ta ON ta.id = sp.trading_account_id
        WHERE row.season_participant_id = sp.id
          AND row.trading_account_id IS NULL
          AND ta.mode = ''season''::"TradingAccountMode"
          AND ta.user_id = sp.user_id',
      table_name
    );
  END LOOP;
END
$$;

-- Re-run ownership and row-local consistency checks after the guarded
-- backfill. This catches relationships where one side was NULL before step 3
-- and therefore could not be compared conclusively in the preflight.
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
    'daily_portfolio_snapshots',
    'season_rankings'
  ]
  LOOP
    EXECUTE format(
      'SELECT count(*)
         FROM %I row
         JOIN trading_accounts ta ON ta.id = row.trading_account_id
         LEFT JOIN season_participants sp ON sp.id = row.season_participant_id
        WHERE (row.season_participant_id IS NULL AND ta.mode <> ''general''::"TradingAccountMode")
           OR (row.season_participant_id IS NOT NULL AND (
             sp.id IS NULL
             OR sp.trading_account_id IS DISTINCT FROM row.trading_account_id
             OR ta.mode <> ''season''::"TradingAccountMode"
             OR ta.user_id <> sp.user_id
           ))',
      table_name
    ) INTO finding_count;

    IF finding_count > 0 THEN
      RAISE EXCEPTION
        'make_trading_account_canonical_scope: table % has % row(s) whose post-backfill participant/account ownership or mode disagrees.',
        table_name,
        finding_count;
    END IF;
  END LOOP;

  SELECT count(*) INTO finding_count
  FROM "wallet_transactions" wt
  JOIN "cash_wallets" w ON w."id" = wt."wallet_id"
  WHERE wt."trading_account_id" IS DISTINCT FROM w."trading_account_id"
     OR wt."season_participant_id" IS DISTINCT FROM w."season_participant_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % WalletTransaction row(s) disagree with their CashWallet scope after backfill.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "orders" o
  JOIN "quotes" q ON q."id" = o."quote_id"
  WHERE o."trading_account_id" IS DISTINCT FROM q."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % Order row(s) disagree with their Quote account scope after backfill.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "fx_execute_requests" r
  JOIN "exchange_transactions" e ON e."id" = r."exchange_transaction_id"
  WHERE r."trading_account_id" IS DISTINCT FROM e."trading_account_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % FxExecuteRequest row(s) disagree with their ExchangeTransaction account scope after backfill.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "quotes" q
  JOIN "trading_accounts" ta ON ta."id" = q."trading_account_id"
  WHERE q."user_id" <> ta."user_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % Quote row(s) belong to a different user than their TradingAccount after backfill.',
      finding_count;
  END IF;

  SELECT count(*) INTO finding_count
  FROM "fx_execute_requests" r
  JOIN "trading_accounts" ta ON ta."id" = r."trading_account_id"
  WHERE r."user_id" <> ta."user_id";
  IF finding_count > 0 THEN
    RAISE EXCEPTION
      'make_trading_account_canonical_scope: % FxExecuteRequest row(s) belong to a different user than their TradingAccount after backfill.',
      finding_count;
  END IF;
END
$$;

-- No participant-less legacy row can be attributed safely. Abort instead of
-- inventing an owner. The whole migration transaction rolls back its guarded
-- backfill if any such row remains.
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
    'daily_portfolio_snapshots',
    'season_rankings'
  ]
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE trading_account_id IS NULL',
      table_name
    ) INTO finding_count;

    IF finding_count > 0 THEN
      RAISE EXCEPTION
        'make_trading_account_canonical_scope: table % still has % row(s) without trading_account_id. Ownership is not deterministic, so the migration was rolled back.',
        table_name,
        finding_count;
    END IF;
  END LOOP;
END
$$;

-- -------------------------------------------------------------------------
-- 4) Database-level canonical ownership. Legacy participant columns and all
-- their constraints/indexes remain in place for the follow-up removal work.
ALTER TABLE "season_participants"
  ALTER COLUMN "trading_account_id" SET NOT NULL;

ALTER TABLE "cash_wallets"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "wallet_transactions"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "exchange_transactions"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "fx_execute_requests"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "orders"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "positions"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "quotes"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "equity_snapshots"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "daily_portfolio_snapshots"
  ALTER COLUMN "trading_account_id" SET NOT NULL;
ALTER TABLE "season_rankings"
  ALTER COLUMN "trading_account_id" SET NOT NULL;

COMMIT;
