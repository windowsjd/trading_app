import { BeginnerQuestEvidence } from './beginner-quest-evidence';
import {
  assertBeginnerLearningAccess,
  beginnerOrderAction,
  type BeginnerLearningAction,
} from './beginner-learning-policy';
import type { QuestClient } from './beginner-quest-evidence';

const client = {} as QuestClient;
const beginner = { id: 'beginner-a', mode: 'beginner' };
afterEach(() => jest.restoreAllMocks());
it.each(['general', 'season'])(
  '%s never reads beginner evidence',
  async (mode) => {
    const spy = jest.spyOn(BeginnerQuestEvidence.prototype, 'read');
    for (const action of [
      'transfer',
      'cryptoMarketBuy',
      'spotProtection',
      'cryptoLimitBuy',
      'allTrading',
    ] as const)
      await assertBeginnerLearningAccess(client, { id: 'other', mode }, action);
    expect(spy).not.toHaveBeenCalled();
  },
);
it('risk reduction and exchange never require progress, including unavailable database', async () => {
  await assertBeginnerLearningAccess(client, beginner, 'riskReduction');
  await assertBeginnerLearningAccess(client, beginner, 'exchange');
});
it.each([0, 1, 2, 3, 4, 5, 6])(
  'allows the current practice before completion, foundation count %s',
  async (count) => {
    const access = {
      exchange: true,
      transfer: count >= 1,
      cryptoMarketBuy: count >= 2,
      spotProtection: count >= 3,
      cryptoLimitBuy: count >= 5,
      allTrading: count >= 6,
    };
    const spy = jest
      .spyOn(BeginnerQuestEvidence.prototype, 'read')
      .mockResolvedValue({ learningAccess: access } as Awaited<
        ReturnType<BeginnerQuestEvidence['read']>
      >);
    for (const action of Object.keys(access) as Exclude<
      BeginnerLearningAction,
      'riskReduction'
    >[]) {
      const work = assertBeginnerLearningAccess(client, beginner, action);
      if (access[action]) await work;
      else
        await expect(work).rejects.toMatchObject({
          response: { error: { code: 'BEGINNER_FEATURE_LOCKED' } },
          status: 403,
        });
    }
    expect(spy).toHaveBeenCalledWith('beginner-a', false);
  },
);
it('an evidence failure cannot grant permission', async () => {
  jest
    .spyOn(BeginnerQuestEvidence.prototype, 'read')
    .mockRejectedValue(new Error('unavailable'));
  await expect(
    assertBeginnerLearningAccess(client, beginner, 'allTrading'),
  ).rejects.toThrow('unavailable');
});
it('never mistakes sell/cancel safety for a learning prerequisite', () => {
  for (const assetType of ['crypto', 'domestic_stock', 'us_stock'])
    for (const orderType of ['market', 'limit'])
      expect(beginnerOrderAction({ side: 'sell', orderType }, assetType)).toBe(
        'riskReduction',
      );
  expect(
    beginnerOrderAction({ side: 'buy', orderType: 'market' }, 'crypto'),
  ).toBe('cryptoMarketBuy');
  expect(
    beginnerOrderAction({ side: 'buy', orderType: 'limit' }, 'crypto'),
  ).toBe('cryptoLimitBuy');
  expect(
    beginnerOrderAction({ side: 'buy', orderType: 'market' }, 'us_stock'),
  ).toBe('allTrading');
});
