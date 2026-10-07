-- A separate additive enum transaction permits use in the following migration.
BEGIN;
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE 'futures_season_settlement';
COMMIT;
