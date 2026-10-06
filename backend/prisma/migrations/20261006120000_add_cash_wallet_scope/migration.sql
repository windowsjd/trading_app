-- Wallet identity foundation only: no provisioning, transfer, or money writes.
-- The constant compatibility default classifies every existing wallet as
-- securities without updating IDs, amounts, timestamps, or ledger/FK links.
-- Apply the schema before deploying the regenerated Prisma client. Crypto
-- provisioning/routing must remain disabled until all consumers support it.
BEGIN;

CREATE TYPE "WalletScope" AS ENUM ('securities', 'crypto_spot', 'crypto_futures');

ALTER TABLE "cash_wallets"
  ADD COLUMN "wallet_scope" "WalletScope" NOT NULL DEFAULT 'securities';

-- Prisma does not model CHECK constraints. Enumerate both sides explicitly
-- so a future enum/currency addition cannot silently become a valid pair.
ALTER TABLE "cash_wallets"
  ADD CONSTRAINT "cash_wallets_scope_currency_check" CHECK (
    ("wallet_scope" = 'securities' AND "currency_code" IN ('KRW', 'USD'))
    OR
    ("wallet_scope" IN ('crypto_spot', 'crypto_futures') AND "currency_code" = 'USD')
  );

-- The old unique proves there is still exactly one compatibility wallet per
-- existing account/currency. Establish its replacement before dropping it.
-- ALTER TABLE holds the table lock until COMMIT; no writer can observe a gap.
CREATE UNIQUE INDEX "cash_wallets_trading_account_id_wallet_scope_currency_code_key"
  ON "cash_wallets"("trading_account_id", "wallet_scope", "currency_code");

DROP INDEX "cash_wallets_trading_account_id_currency_code_key";

COMMIT;
