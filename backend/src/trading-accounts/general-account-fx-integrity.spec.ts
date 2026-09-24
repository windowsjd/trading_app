jest.mock('../generated/prisma/client', () => ({
  ...jest.requireActual('../generated/prisma/enums'),
  PrismaClient: class PrismaClient {},
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));

import { HttpException } from '@nestjs/common';
import {
  CurrencyCode,
  FxExecuteRequestStatus,
  WalletTransactionType,
} from '../generated/prisma/client';
import {
  assertGeneralAccountFxRowsIntegrity,
  GENERAL_ACCOUNT_INTEGRITY_ERROR_CODE,
} from './general-account-integrity';

const ACCOUNT = 'general-account';
const USER = 'owner';

type Exchange = {
  id: string;
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  fxExecuteRequests: Array<{
    id: string;
    status: FxExecuteRequestStatus;
    tradingAccountId: string;
  }>;
};
type Ledger = {
  id: string;
  referenceId: string | null;
  tradingAccountId: string;
  currencyCode: CurrencyCode;
  direction: 'debit' | 'credit';
  txType: WalletTransactionType;
  wallet: { tradingAccountId: string };
};

function fixture(size: number) {
  const exchanges: Exchange[] = [];
  const ledgers: Ledger[] = [];
  for (let index = 0; index < size; index++) {
    const id = `exchange-${index}`;
    exchanges.push({
      id,
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      fxExecuteRequests: [
        {
          id: `request-${index}`,
          status: FxExecuteRequestStatus.succeeded,
          tradingAccountId: ACCOUNT,
        },
      ],
    });
    ledgers.push(
      {
        id: `source-${index}`,
        referenceId: id,
        tradingAccountId: ACCOUNT,
        currencyCode: CurrencyCode.KRW,
        direction: 'debit',
        txType: WalletTransactionType.exchange_source,
        wallet: { tradingAccountId: ACCOUNT },
      },
      {
        id: `target-${index}`,
        referenceId: id,
        tradingAccountId: ACCOUNT,
        currencyCode: CurrencyCode.USD,
        direction: 'credit',
        txType: WalletTransactionType.exchange_target,
        wallet: { tradingAccountId: ACCOUNT },
      },
    );
  }
  let referenceReads = 0;
  for (const row of ledgers) {
    let referenceId = row.referenceId;
    Object.defineProperty(row, 'referenceId', {
      get() {
        referenceReads += 1;
        return referenceId;
      },
      set(value: string | null) {
        referenceId = value;
      },
      enumerable: true,
    });
  }
  const client = {
    exchangeTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(exchanges),
    },
    fxExecuteRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    quote: { findFirst: jest.fn().mockResolvedValue(null) },
    walletTransaction: { findMany: jest.fn().mockResolvedValue(ledgers) },
  };
  return {
    exchanges,
    ledgers,
    client,
    get referenceReads() {
      return referenceReads;
    },
  };
}

async function rejectsIntegrity(input: ReturnType<typeof fixture>) {
  try {
    await assertGeneralAccountFxRowsIntegrity(
      input.client as never,
      ACCOUNT,
      USER,
    );
    throw new Error('corrupted FX rows were accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse() as {
      error: { code: string };
    };
    expect(body.error.code).toBe(GENERAL_ACCOUNT_INTEGRITY_ERROR_CODE);
  }
}

describe('general-account FX row integrity', () => {
  it.each([0, 1, 4])('accepts intact history E=%i', async (size) => {
    const input = fixture(size);
    await expect(
      assertGeneralAccountFxRowsIntegrity(input.client as never, ACCOUNT, USER),
    ).resolves.toBeUndefined();
    expect(input.client.exchangeTransaction.findMany).toHaveBeenCalledTimes(1);
    expect(input.client.walletTransaction.findMany).toHaveBeenCalledTimes(
      size ? 1 : 0,
    );
  });

  const damages: Array<[string, (input: ReturnType<typeof fixture>) => void]> =
    [
      [
        'missing source',
        ({ ledgers }) => {
          ledgers.splice(0, 1);
        },
      ],
      [
        'missing target',
        ({ ledgers }) => {
          ledgers.splice(1, 1);
        },
      ],
      [
        'duplicate source',
        ({ ledgers }) => {
          ledgers.push({ ...ledgers[0], id: 'extra-source' });
        },
      ],
      [
        'duplicate target',
        ({ ledgers }) => {
          ledgers.push({ ...ledgers[1], id: 'extra-target' });
        },
      ],
      [
        'three ledgers',
        ({ ledgers }) => {
          ledgers.push({
            ...ledgers[0],
            id: 'third',
            txType: WalletTransactionType.initial_grant,
          });
        },
      ],
      [
        'source currency',
        ({ ledgers }) => {
          ledgers[0].currencyCode = CurrencyCode.USD;
        },
      ],
      [
        'target currency',
        ({ ledgers }) => {
          ledgers[1].currencyCode = CurrencyCode.KRW;
        },
      ],
      [
        'source direction',
        ({ ledgers }) => {
          ledgers[0].direction = 'credit';
        },
      ],
      [
        'target direction',
        ({ ledgers }) => {
          ledgers[1].direction = 'debit';
        },
      ],
      [
        'foreign ledger account',
        ({ ledgers }) => {
          ledgers[0].tradingAccountId = 'foreign';
        },
      ],
      [
        'foreign wallet',
        ({ ledgers }) => {
          ledgers[0].wallet.tradingAccountId = 'foreign';
        },
      ],
      [
        'request absent',
        ({ exchanges }) => {
          exchanges[0].fxExecuteRequests = [];
        },
      ],
      [
        'request duplicate',
        ({ exchanges }) => {
          exchanges[0].fxExecuteRequests.push({
            ...exchanges[0].fxExecuteRequests[0],
            id: 'duplicate',
          });
        },
      ],
      [
        'request pending',
        ({ exchanges }) => {
          exchanges[0].fxExecuteRequests[0].status =
            FxExecuteRequestStatus.pending;
        },
      ],
      [
        'request account',
        ({ exchanges }) => {
          exchanges[0].fxExecuteRequests[0].tradingAccountId = 'foreign';
        },
      ],
    ];
  it.each(damages)('rejects %s', async (_label, mutate) => {
    const input = fixture(1);
    mutate(input);
    await rejectsIntegrity(input);
  });
  it('rejects the cross-account and foreign-user scope probes', async () => {
    for (const name of [
      'exchangeTransaction',
      'fxExecuteRequest',
      'quote',
    ] as const) {
      const input = fixture(1);
      input.client[name].findFirst.mockResolvedValue({ id: 'damaged' });
      await rejectsIntegrity(input);
    }
  });
  it.each([100, 200, 1000])(
    'reads reference IDs linearly for E=%i',
    async (size) => {
      const input = fixture(size);
      const started = performance.now();
      await assertGeneralAccountFxRowsIntegrity(
        input.client as never,
        ACCOUNT,
        USER,
      );
      const elapsedMs = performance.now() - started;
      const queries =
        input.client.exchangeTransaction.findFirst.mock.calls.length +
        input.client.fxExecuteRequest.findFirst.mock.calls.length +
        input.client.quote.findFirst.mock.calls.length +
        input.client.exchangeTransaction.findMany.mock.calls.length +
        input.client.walletTransaction.findMany.mock.calls.length;
      console.log(
        JSON.stringify({
          exchanges: size,
          ledgers: input.ledgers.length,
          referenceReads: input.referenceReads,
          elapsedMs,
          queries,
        }),
      );
      expect(queries).toBe(5);
      expect(input.referenceReads).toBe(6 * size);
      expect(input.client.walletTransaction.findMany).toHaveBeenCalledTimes(1);
    },
  );
});
