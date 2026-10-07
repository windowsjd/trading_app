jest.mock('../generated/prisma/client', () => {
  const { Decimal, sqltag } = jest.requireActual(
    '@prisma/client/runtime/client',
  );
  return {
    ...jest.requireActual('../generated/prisma/enums'),
    Prisma: { Decimal, sql: sqltag },
    PrismaClient: class PrismaClient {},
  };
});

import { isWalletFxTransferRoute } from './trading-account-wallet-fx-transfer.service';
import { CANONICAL_CASH_WALLET_IDENTITIES } from './canonical-cash-wallets';

describe('Composite transfer route policy', () => {
  const allowed = new Set(['0:2', '2:0', '0:3', '3:0']);
  for (const [from, source] of CANONICAL_CASH_WALLET_IDENTITIES.entries()) {
    for (const [
      to,
      destination,
    ] of CANONICAL_CASH_WALLET_IDENTITIES.entries()) {
      it(`${source.walletScope}/${source.currencyCode} → ${destination.walletScope}/${destination.currencyCode}`, () => {
        expect(isWalletFxTransferRoute(source, destination)).toBe(
          allowed.has(`${from}:${to}`),
        );
      });
    }
  }
});
