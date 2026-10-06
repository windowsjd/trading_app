-- Activate cash containers only. No funds, reservations, ledger, account status
-- or historical results are moved/recomputed, including closed/settled accounts.
-- Quiesce account provisioning for migration + server deployment: an older
-- server still provisions only two wallets. Requests must never repair a gap.
BEGIN;

-- Match the existing provisioning lock order: account before wallet.
LOCK TABLE "trading_accounts" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "cash_wallets" IN SHARE ROW EXCLUSIVE MODE;

-- Do not disguise a damaged legacy Securities foundation as normalization.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "trading_accounts" a
    WHERE (SELECT count(*) FROM "cash_wallets" w
           WHERE w."trading_account_id" = a."id"
             AND w."wallet_scope" = 'securities'
             AND w."currency_code" IN ('KRW', 'USD')) <> 2
  ) THEN
    RAISE EXCEPTION 'Canonical wallet backfill requires intact Securities KRW/USD wallets; audit and repair deliberately.';
  END IF;
END $$;

INSERT INTO "cash_wallets" (
  "id", "trading_account_id", "wallet_scope", "currency_code",
  "balance_amount", "reserved_amount", "created_at", "updated_at"
)
SELECT md5('cash-wallet:' || a."id" || ':' || s.scope || ':USD')::uuid::text,
       a."id", s.scope::"WalletScope", 'USD'::"CurrencyCode",
       0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "trading_accounts" a
CROSS JOIN (VALUES ('crypto_spot'), ('crypto_futures')) s(scope)
ON CONFLICT ("trading_account_id", "wallet_scope", "currency_code") DO NOTHING;

COMMIT;
