import { readGeneralAccountResetBlockers } from './general-account-reset-blockers';

/** Each probe answers "nothing" unless a test says otherwise. */
function client(found: Partial<Record<string, unknown>> = {}) {
  const probe = (name: string) => ({
    findFirst: jest.fn().mockResolvedValue(found[name] ?? null),
  });
  return {
    position: probe('position'),
    futuresPosition: probe('futuresPosition'),
    order: probe('order'),
    limitOnCloseOrder: probe('limitOnCloseOrder'),
    futuresLimitOrder: probe('futuresLimitOrder'),
    conditionalBuyOrder: probe('conditionalBuyOrder'),
    conditionalSellOrder: probe('conditionalSellOrder'),
    futuresConditionalEntry: probe('futuresConditionalEntry'),
    futuresTpSlSetting: probe('futuresTpSlSetting'),
    entryTpSlPlan: probe('entryTpSlPlan'),
    protectionGroup: probe('protectionGroup'),
    cashWallet: probe('cashWallet'),
  };
}

describe('readGeneralAccountResetBlockers', () => {
  it('reports nothing for an account that holds and awaits nothing', async () => {
    expect(
      await readGeneralAccountResetBlockers(client() as never, 'account-1'),
    ).toEqual([]);
  });

  it.each([
    ['position', 'SPOT_HOLDINGS'],
    ['futuresPosition', 'FUTURES_POSITIONS'],
    ['order', 'OPEN_ORDERS'],
    ['limitOnCloseOrder', 'OPEN_ORDERS'],
    ['futuresLimitOrder', 'OPEN_ORDERS'],
    ['conditionalBuyOrder', 'ACTIVE_CONDITIONAL_ORDERS'],
    ['conditionalSellOrder', 'ACTIVE_CONDITIONAL_ORDERS'],
    ['futuresConditionalEntry', 'ACTIVE_CONDITIONAL_ORDERS'],
    ['futuresTpSlSetting', 'ACTIVE_CONDITIONAL_ORDERS'],
    ['entryTpSlPlan', 'ACTIVE_CONDITIONAL_ORDERS'],
    ['protectionGroup', 'ACTIVE_CONDITIONAL_ORDERS'],
    ['cashWallet', 'RESERVED_FUNDS'],
  ])('a live %s blocks with %s', async (model, blocker) => {
    expect(
      await readGeneralAccountResetBlockers(
        client({ [model]: { id: 'row' } }) as never,
        'account-1',
      ),
    ).toEqual([blocker]);
  });

  it('asks only for rows that are still held, pending or reserved', async () => {
    const probes = client();
    await readGeneralAccountResetBlockers(probes as never, 'account-1');
    const where = (name: keyof typeof probes) =>
      (probes[name].findFirst.mock.calls[0] as [{ where: unknown }])[0].where;
    expect(where('position')).toEqual({
      tradingAccountId: 'account-1',
      OR: [{ quantity: { gt: 0 } }, { reservedQuantity: { gt: 0 } }],
    });
    expect(where('futuresPosition')).toEqual({
      tradingAccountId: 'account-1',
      status: 'open',
    });
    expect(where('order')).toEqual({
      tradingAccountId: 'account-1',
      status: 'submitted',
    });
    expect(where('conditionalSellOrder')).toEqual({
      tradingAccountId: 'account-1',
      status: { in: ['watching', 'triggered'] },
    });
    expect(where('protectionGroup')).toEqual({
      tradingAccountId: 'account-1',
      status: { in: ['holding', 'active'] },
    });
    expect(where('cashWallet')).toEqual({
      tradingAccountId: 'account-1',
      reservedAmount: { gt: 0 },
    });
  });

  it('lists every distinct reason once, in a fixed order', async () => {
    expect(
      await readGeneralAccountResetBlockers(
        client({
          cashWallet: { id: 'w' },
          order: { id: 'o' },
          futuresLimitOrder: { id: 'f' },
          position: { id: 'p' },
        }) as never,
        'account-1',
      ),
    ).toEqual(['SPOT_HOLDINGS', 'OPEN_ORDERS', 'RESERVED_FUNDS']);
  });
});
