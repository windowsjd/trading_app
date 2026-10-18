import { BeginnerQuestEvidence } from './beginner-quest-evidence';
import {
  BEGINNER_LOCK_MESSAGES,
  assertBeginnerLearningAccess,
  beginnerFuturesAction,
  beginnerOrderAction,
  type BeginnerLearningAction,
} from './beginner-learning-policy';
import type { QuestClient } from './beginner-quest-evidence';

const client = {} as QuestClient;
const beginner = { id: 'beginner-a', mode: 'beginner' };
const ACTIONS = [
  'transfer',
  'fxTransfer',
  'cryptoMarketBuy',
  'spotProtection',
  'cryptoLimitBuy',
  'krStockMarketBuy',
  'usStockMarketBuy',
  'futuresLongOpen',
  'futuresShortOpen',
  'allTrading',
] as const;
const QUEST_IDS = [
  'common-01-exchange',
  'common-02-transfer',
  'common-03-market-buy',
  'common-04-protection',
  'common-05-market-sell',
  'common-06-limit-buy',
  'market-kr-stock',
  'market-us-stock',
  'market-futures-long',
  'market-futures-short',
];

/** Evidence with the given permissions and completed quest ids. */
function evidence(
  allowed: Partial<Record<(typeof ACTIONS)[number], boolean>>,
  completed: string[] = [],
) {
  return jest.spyOn(BeginnerQuestEvidence.prototype, 'read').mockResolvedValue({
    learningPermissions: {
      exchange: true,
      ...Object.fromEntries(ACTIONS.map((action) => [action, false])),
      ...allowed,
    },
    quests: QUEST_IDS.map((questId) => ({
      questId,
      status: completed.includes(questId) ? 'completed' : 'not_started',
    })),
  } as unknown as Awaited<ReturnType<BeginnerQuestEvidence['read']>>);
}
async function lock(work: Promise<void>) {
  try {
    await work;
  } catch (error) {
    const response = (
      error as {
        status: number;
        response: { error: { code: string; message: string } };
      }
    ).response.error;
    expect((error as { status: number }).status).toBe(403);
    expect(response.code).toBe('BEGINNER_FEATURE_LOCKED');
    return response.message;
  }
  throw new Error('expected BEGINNER_FEATURE_LOCKED');
}

afterEach(() => jest.restoreAllMocks());
it.each(['general', 'season'])(
  '%s never reads beginner evidence',
  async (mode) => {
    const spy = jest.spyOn(BeginnerQuestEvidence.prototype, 'read');
    for (const action of ACTIONS)
      await assertBeginnerLearningAccess(client, { id: 'other', mode }, action);
    expect(spy).not.toHaveBeenCalled();
  },
);
it('risk reduction and exchange never require progress, including unavailable database', async () => {
  await assertBeginnerLearningAccess(client, beginner, 'riskReduction');
  await assertBeginnerLearningAccess(client, beginner, 'exchange');
});
it('enforces exactly the server permissions, read once per check for this account', async () => {
  const spy = evidence({ transfer: true, krStockMarketBuy: true });
  await assertBeginnerLearningAccess(client, beginner, 'transfer');
  await assertBeginnerLearningAccess(client, beginner, 'krStockMarketBuy');
  for (const action of ACTIONS.filter(
    (name) => name !== 'transfer' && name !== 'krStockMarketBuy',
  ))
    await lock(assertBeginnerLearningAccess(client, beginner, action));
  expect(spy).toHaveBeenCalledWith('beginner-a');
});
it('names the step that opens an action, or full completion once its quest has passed', async () => {
  evidence({}, []);
  expect(
    await lock(assertBeginnerLearningAccess(client, beginner, 'transfer')),
  ).toBe(BEGINNER_LOCK_MESSAGES.exchangeFirst);
  expect(
    await lock(
      assertBeginnerLearningAccess(client, beginner, 'spotProtection'),
    ),
  ).toBe(BEGINNER_LOCK_MESSAGES.laterStep);
  expect(
    await lock(
      assertBeginnerLearningAccess(client, beginner, 'krStockMarketBuy'),
    ),
  ).toBe(BEGINNER_LOCK_MESSAGES.foundationFirst);
  jest.restoreAllMocks();
  // QUEST 06 and QUEST 07 complete: crypto practice and Korean stocks wait
  // for every quest; an open long blocks only a new long.
  evidence({}, [...QUEST_IDS.slice(0, 7)]);
  for (const action of [
    'cryptoMarketBuy',
    'cryptoLimitBuy',
    'krStockMarketBuy',
    'allTrading',
  ] as const)
    expect(
      await lock(assertBeginnerLearningAccess(client, beginner, action)),
    ).toBe(BEGINNER_LOCK_MESSAGES.allQuests);
  expect(
    await lock(
      assertBeginnerLearningAccess(client, beginner, 'futuresLongOpen', {
        leverage: 2,
      }),
    ),
  ).toBe(BEGINNER_LOCK_MESSAGES.closeOpenPosition);
});
it('a practice Futures open must use leverage above 1x; full access does not', async () => {
  evidence({ futuresLongOpen: true, futuresShortOpen: true }, [
    ...QUEST_IDS.slice(0, 6),
  ]);
  for (const leverage of [undefined, 0, 1])
    expect(
      await lock(
        assertBeginnerLearningAccess(client, beginner, 'futuresShortOpen', {
          leverage,
        }),
      ),
    ).toBe(BEGINNER_LOCK_MESSAGES.futuresLeverage);
  await assertBeginnerLearningAccess(client, beginner, 'futuresLongOpen', {
    leverage: 2,
  });
  jest.restoreAllMocks();
  evidence({ futuresLongOpen: true, allTrading: true }, QUEST_IDS);
  await assertBeginnerLearningAccess(client, beginner, 'futuresLongOpen', {
    leverage: 1,
  });
});
it('an evidence failure cannot grant permission', async () => {
  jest
    .spyOn(BeginnerQuestEvidence.prototype, 'read')
    .mockRejectedValue(new Error('unavailable'));
  await expect(
    assertBeginnerLearningAccess(client, beginner, 'allTrading'),
  ).rejects.toThrow('unavailable');
});
it('only a market SELL or an exit a setting fires is risk reduction', () => {
  for (const assetType of ['crypto', 'domestic_stock', 'us_stock']) {
    expect(
      beginnerOrderAction({ side: 'sell', orderType: 'market' }, assetType),
    ).toBe('riskReduction');
    // A user's own limit or LOC SELL is a later order type.
    expect(
      beginnerOrderAction({ side: 'sell', orderType: 'limit' }, assetType),
    ).toBe('allTrading');
    for (const exit of [
      { protectionChildId: 'child' },
      { conditionalSellOrderId: 'intent' },
    ])
      expect(
        beginnerOrderAction(
          { side: 'sell', orderType: 'limit', ...exit },
          assetType,
        ),
      ).toBe('riskReduction');
  }
  const buy = (orderType: string, assetType: string) =>
    beginnerOrderAction({ side: 'buy', orderType }, assetType);
  expect([
    buy('market', 'crypto'),
    buy('limit', 'crypto'),
    buy('market', 'domestic_stock'),
    buy('market', 'us_stock'),
    buy('limit', 'domestic_stock'),
    buy('limit', 'us_stock'),
  ] satisfies BeginnerLearningAction[]).toEqual([
    'cryptoMarketBuy',
    'cryptoLimitBuy',
    'krStockMarketBuy',
    'usStockMarketBuy',
    'allTrading',
    'allTrading',
  ]);
});
it('a Futures open follows its direction; an increase needs full access; reduce and close reduce risk', () => {
  expect(
    [
      { operation: 'open', direction: 'long' },
      { operation: 'open', direction: 'short' },
      { operation: 'increase', direction: 'long' },
      { operation: 'reduce', direction: 'long' },
      { operation: 'close', direction: 'short' },
      { operation: 'open', direction: 'sideways' },
    ].map(beginnerFuturesAction),
  ).toEqual([
    'futuresLongOpen',
    'futuresShortOpen',
    'allTrading',
    'riskReduction',
    'riskReduction',
    'allTrading',
  ]);
});
