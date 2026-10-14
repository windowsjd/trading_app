import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { RankingsResponseDto } from './api.ts';
import {
  RANKING_TIER_CUTOFF_RATIOS,
  buildRankingInsights,
  describeRankingInsights,
  kstDateOf,
  nextReturnGoal,
  previousDayRank,
  previousRankingDate,
  rankChange,
  rankingTierLastRanks,
  upperTierLastRank,
  wonToReach,
  type RankingInsight,
  type RankingInsightInput,
  type RankingInsightRow,
} from './rankingInsights.ts';

const INITIAL = '10000000';
const row = (rank: number, userId: string, totalAssetKrw: string, provisionalTier: string): RankingInsightRow =>
  ({ rank, userId, nickname: userId, totalAssetKrw, provisionalTier });
// Primitive views only: messages are compared field by field, never as objects with hidden state.
const view = (messages: RankingInsight[]) =>
  messages.map(({ key, label, value, suffix, glyph }) => [key, label, value, suffix, glyph].join('|'));
const goalView = (goal: ReturnType<typeof nextReturnGoal>) =>
  goal ? `${goal.percent}% ${goal.amount.toFixed(0)}` : 'none';

describe('수익률 목표 사다리', () => {
  it('picks the first goal strictly above my asset (spec table, initial 10,000,000)', () => {
    const table: Array<[string, string]> = [
      ['10001962', '10% 998038'],
      ['9955269.00000000', '0% 44731'],
      ['9458377', '0% 541623'],
      ['10000000', '10% 1000000'],
      ['11000000.00000000', '30% 2000000'],
      ['9000000', '0% 1000000'],
      ['5000000', '-30% 2000000'],
      ['4000000', '-50% 1000000'],
      ['3000000', '-50% 2000000'],
      ['20000000', '150% 5000000'],
      ['24999999', '150% 1'],
      ['27500000', '200% 2500000'],
      ['12999999.5', '30% 1'],
    ];
    for (const [asset, expected] of table) assert.equal(goalView(nextReturnGoal(INITIAL, asset)), expected, asset);
  });

  it('keeps climbing by 50 past +100% and labels 본전 separately', () => {
    assert.equal(goalView(nextReturnGoal(INITIAL, '40000000')), '350% 5000000');
    assert.equal(goalView(nextReturnGoal(INITIAL, '1000000000')), '9950% 5000000');
    const labels = (asset: string) => view(buildRankingInsights({ ...meOnly(asset), initialCapitalKrw: INITIAL }));
    assert.deepEqual(labels('9955269'), ['goal|본전(수익률 0%)까지|44,731|원|0%']);
    assert.deepEqual(labels('10001962'), ['goal|수익률 10%까지|998,038|원|%']);
    assert.deepEqual(labels('5000000'), ['goal|수익률 -30%까지|2,000,000|원|%']);
  });

  it('hides only the goal when the starting capital is unknown or not a number', () => {
    for (const initial of [undefined, null, '', 'abc', '0', '-1', 'NaN']) {
      assert.equal(goalView(nextReturnGoal(initial, '9955269')), 'none', String(initial));
      const messages = buildRankingInsights({ ...meOnly('9955269'), initialCapitalKrw: initial, previousRank: 35 });
      assert.deepEqual(messages.map((message) => message.key), ['change']);
    }
  });
});

function meOnly(totalAssetKrw: string, rank = 1): RankingInsightInput {
  return {
    me: { rank, totalAssetKrw, provisionalTier: 'master' },
    participants: 100, first: null, above: null, tierEdge: null, previousRank: null,
  };
}

describe('금액', () => {
  it('rounds the remaining amount up to whole won (at least 1) and hides level or passed targets', () => {
    assert.equal(wonToReach('103389', '100000')?.toFixed(0), '3389');
    assert.equal(wonToReach('100.2', '100')?.toFixed(0), '1');
    assert.equal(wonToReach('100.00000001', '100')?.toFixed(0), '1');
    assert.equal(wonToReach('100.5', '99.7')?.toFixed(0), '1');
    // Decimal, not float: these differ below Number's integer precision.
    assert.equal(wonToReach('9007199254740995', '9007199254740993.5')?.toFixed(0), '2');
    for (const [target, current] of [['100', '100'], ['99', '100'], ['100.00000000', '100'], ['abc', '1'], ['1', '']]) {
      assert.equal(wonToReach(target, current) === null, true, `${target} vs ${current}`);
    }
  });

  it('drops a message whose person is level with me (a tie in total asset)', () => {
    const messages = buildRankingInsights({
      me: { rank: 31, totalAssetKrw: '9955269', provisionalTier: 'gold' }, participants: 100,
      first: row(1, 'demiant', '10001962', 'master'), above: row(30, 'hana', '9955269.00000000', 'gold'),
      tierEdge: null, previousRank: null,
    });
    assert.deepEqual(view(messages), ['first|1위 demiant까지|46,693|원|1']);
  });
});

describe('티어 마지막 순위', () => {
  it('matches the backend expression exactly', () => {
    assert.deepEqual(rankingTierLastRanks(100), [4, 11, 23, 40, 70, 100]);
    assert.deepEqual(rankingTierLastRanks(3), [1, 1, 1, 2, 3, 3]);
    assert.deepEqual(rankingTierLastRanks(1), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(rankingTierLastRanks(5), [1, 1, 2, 2, 4, 5]);
  });

  it('gives the last rank of the tier directly above (N=100)', () => {
    const above = Object.fromEntries(['master', 'diamond', 'platinum', 'gold', 'silver', 'bronze']
      .map((tier) => [tier, upperTierLastRank(tier, 100)]));
    assert.deepEqual(above, { master: null, diamond: 4, platinum: 11, gold: 23, silver: 40, bronze: 70 });
    assert.equal(upperTierLastRank('Gold', 100), 23, 'tier names are case-insensitive like the API');
    for (const tier of [null, undefined, '', 'grandmaster']) assert.equal(upperTierLastRank(tier, 100), null);
    assert.equal(upperTierLastRank('gold', 0), null);
  });

  it('is an exact copy of backend/src/ranking/ranking-tier.policy.ts', () => {
    const backend = readFileSync(path.join(process.cwd(), '../backend/src/ranking/ranking-tier.policy.ts'), 'utf8');
    const rules = [...backend.matchAll(/\{\s*tier:\s*'(\w+)',\s*cumulativeRatio:\s*([\d.]+)\s*\}/g)]
      .map(([, tier, ratio]) => `${tier}=${ratio}`);
    assert.deepEqual(rules, RANKING_TIER_CUTOFF_RATIOS.map((rule) => `${rule.tier}=${rule.cumulativeRatio}`));
    const code = backend.replace(/\s/g, '').replace(/,\)/g, ')');
    assert.equal(code.includes('Math.max(1,Math.ceil(totalParticipants*rule.cumulativeRatio))'), true,
      'the backend cutoff expression changed: update the copy and its tests');
  });
});

describe('윗 티어 (tier)', () => {
  const tierInput = (me: { rank: number; tier: string }, participants: number,
    edge: RankingInsightInput['tierEdge']): RankingInsightInput => ({
    me: { rank: me.rank, totalAssetKrw: '1000', provisionalTier: me.tier }, participants,
    first: null, above: null, tierEdge: edge, previousRank: null,
  });

  it('names the tier of the row at the edge, which can skip an empty tier', () => {
    // N=100 gold → rank 23 is platinum.
    assert.deepEqual(view(buildRankingInsights(tierInput({ rank: 31, tier: 'gold' }, 100,
      [row(23, 'p23', '1500', 'platinum'), row(24, 'g24', '1400', 'gold')]))), ['tier|Platinum 티어까지|500|원|P']);
    // N=3, 3rd silver → rank 2 is gold.
    assert.deepEqual(view(buildRankingInsights(tierInput({ rank: 3, tier: 'silver' }, 3,
      [row(2, 'g2', '1200', 'gold'), row(3, 'me', '1000', 'silver')]))), ['tier|Gold 티어까지|200|원|G']);
    // N=5, 3rd silver → rank 2 is platinum (gold is empty).
    const messages = buildRankingInsights(tierInput({ rank: 3, tier: 'silver' }, 5,
      [row(2, 'p2', '1200', 'platinum'), row(3, 'me', '1000', 'silver')]));
    assert.deepEqual(view(messages), ['tier|Platinum 티어까지|200|원|P']);
    assert.equal(messages[0].tier, 'platinum');
    // master is shown as Whale.
    assert.deepEqual(view(buildRankingInsights(tierInput({ rank: 5, tier: 'diamond' }, 100,
      [row(4, 'w4', '1100', 'master'), row(5, 'me', '1000', 'diamond')]))), ['tier|Whale 티어까지|100|원|W']);
  });

  it('fails closed when the rows do not sit where the copied policy puts the edge', () => {
    const cases: Array<[string, RankingInsightInput]> = [
      ['top tier', tierInput({ rank: 1, tier: 'master' }, 100, [row(1, 'me', '1000', 'master'), row(2, 'x', '900', 'master')])],
      ['my rank inside the upper tier', tierInput({ rank: 23, tier: 'gold' }, 100, [row(23, 'me', '1000', 'gold'), row(24, 'x', '900', 'gold')])],
      ['edge row has my tier', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'gold'), row(24, 'b', '1400', 'gold')])],
      ['row after the edge is another tier', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'platinum'), row(24, 'b', '1400', 'platinum')])],
      ['a hidden row shifted the ranks', tierInput({ rank: 31, tier: 'gold' }, 100, [row(24, 'a', '1500', 'platinum'), row(25, 'b', '1400', 'gold')])],
      ['missing row', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'platinum'), null])],
      ['unknown tier name', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'grandmaster'), row(24, 'b', '1400', 'gold')])],
      ['not read', tierInput({ rank: 31, tier: 'gold' }, 100, null)],
    ];
    for (const [name, input] of cases) assert.deepEqual(view(buildRankingInsights(input)), [], name);
  });
});

describe('병합과 순서', () => {
  // N=3: rank 1 master, rank 2 gold, rank 3 silver.
  const rows = [row(1, 'alpha', '12000000', 'master'), row(2, 'beta', '10500000', 'gold'), row(3, 'gamma', '9800000', 'silver')];
  const at = (rank: number) => rows[rank - 1];
  const input = (rank: number): RankingInsightInput => {
    const mine = at(rank);
    const edge = upperTierLastRank(mine.provisionalTier, 3);
    return {
      me: { rank, totalAssetKrw: mine.totalAssetKrw, provisionalTier: mine.provisionalTier },
      participants: 3, first: at(1), above: rank > 1 ? at(rank - 1) : null,
      tierEdge: edge === null ? null : [at(edge), at(edge + 1)],
      initialCapitalKrw: INITIAL, previousRank: 3,
    };
  };

  it('1위: no person to chase, only the goal and yesterday remain', () => {
    assert.deepEqual(view(buildRankingInsights(input(1))), [
      'goal|수익률 30%까지|1,000,000|원|%',
      'change|어제보다|2|계단 상승|▲',
    ]);
  });

  it('2위: 바로 위, 1위 and the upper tier are one person — 1위 wins, in the first slot', () => {
    assert.deepEqual(view(buildRankingInsights(input(2))), [
      'first|1위 alpha까지|1,500,000|원|1',
      'goal|수익률 10%까지|500,000|원|%',
      'change|어제보다|1|계단 상승|▲',
    ]);
  });

  it('3위: 바로 위 and the upper tier merge as the tier; 1위 stays separate', () => {
    assert.deepEqual(view(buildRankingInsights(input(3))), [
      'tier|Gold 티어까지|700,000|원|G',
      'first|1위 alpha까지|2,200,000|원|1',
      'goal|본전(수익률 0%)까지|200,000|원|0%',
    ]);
  });

  it('바로 위 that is the tier edge keeps the earlier slot under the tier label', () => {
    const messages = buildRankingInsights({
      me: { rank: 24, totalAssetKrw: '9000000', provisionalTier: 'gold' }, participants: 100,
      first: row(1, 'demiant', '12000000', 'master'), above: row(23, 'p23', '9500000', 'platinum'),
      tierEdge: [row(23, 'p23', '9500000', 'platinum'), row(24, 'me', '9000000', 'gold')], previousRank: null,
    });
    assert.deepEqual(view(messages), ['tier|Platinum 티어까지|500,000|원|P', 'first|1위 demiant까지|3,000,000|원|1']);
  });

  it('drops 바로 위 and 1위 rows that are not the ranks they claim (a hidden participant)', () => {
    const messages = buildRankingInsights({
      me: { rank: 31, totalAssetKrw: '9955269', provisionalTier: 'gold' }, participants: 100,
      first: row(2, 'second', '10001962', 'master'), above: row(31, 'me', '9955269', 'gold'),
      tierEdge: null, previousRank: null,
    });
    assert.deepEqual(view(messages), []);
  });
});

describe('어제 날짜', () => {
  it('subtracts one calendar day from the business date without a clock or time zone', () => {
    assert.equal(previousRankingDate('2026-03-01'), '2026-02-28');
    assert.equal(previousRankingDate('2026-01-01'), '2025-12-31');
    assert.equal(previousRankingDate('2028-03-01'), '2028-02-29');
    assert.equal(previousRankingDate('2026-10-14'), '2026-10-13');
    for (const value of ['2026-02-30', '2026-13-01', '20261014', '', null, undefined]) {
      assert.equal(previousRankingDate(value), null, String(value));
    }
  });

  it('reads the KST calendar date of a UTC instant', () => {
    assert.equal(kstDateOf('2026-10-13T14:59:59.999Z'), '2026-10-13');
    assert.equal(kstDateOf('2026-10-13T15:00:00.000Z'), '2026-10-14');
    assert.equal(kstDateOf('not a date'), null);
  });
});

describe('순위 변화', () => {
  const yesterday = (patch: Record<string, unknown> = {}, state: 'available' | 'unavailable' = 'available') => ({
    state, rankingDate: '2026-10-13', capturedAt: '2026-10-13T14:55:00.000Z',
    myRanking: { state: 'available', rank: 35, rankingDate: '2026-10-13', capturedAt: '2026-10-13T14:55:00.000Z', ...patch },
  }) as unknown as RankingsResponseDto;

  it('counts steps up or down and hides an unchanged or unknown rank', () => {
    assert.deepEqual(rankChange(31, 35), { steps: 4, direction: 'up' });
    assert.deepEqual(rankChange(35, 31), { steps: 4, direction: 'down' });
    assert.equal(rankChange(31, 31), null);
    assert.equal(rankChange(31, null), null);
    const change = (previousRank: number) => view(buildRankingInsights({ ...meOnly('1', 31), previousRank }));
    assert.deepEqual(change(35), ['change|어제보다|4|계단 상승|▲']);
    assert.deepEqual(change(30), ['change|어제보다|1|계단 하락|▼']);
    assert.deepEqual(change(31), []);
  });

  it("uses yesterday's last set only when it was captured on that KST date", () => {
    assert.equal(previousDayRank(yesterday(), '2026-10-13'), 35);
    // 23:59:59 KST is still yesterday; 00:00 KST of today is not.
    assert.equal(previousDayRank(yesterday({ capturedAt: '2026-10-13T14:59:59.000Z' }), '2026-10-13'), 35);
    assert.equal(previousDayRank(yesterday({ capturedAt: '2026-10-13T15:00:00.000Z' }), '2026-10-13'), null);
    // A set stored under its UTC date (before 2026-10-14) and captured after 15:00 UTC.
    assert.equal(previousDayRank(yesterday({ capturedAt: '2026-10-13T20:00:00.000Z' }), '2026-10-13'), null);
    assert.equal(previousDayRank(yesterday({ rankingDate: '2026-10-12' }), '2026-10-13'), null);
    assert.equal(previousDayRank(yesterday({}, 'unavailable'), '2026-10-13'), null);
    assert.equal(previousDayRank(yesterday({ state: 'not_joined' }), '2026-10-13'), null);
    assert.equal(previousDayRank(yesterday({ rank: 0 }), '2026-10-13'), null);
    assert.equal(previousDayRank(undefined, '2026-10-13'), null);
    assert.equal(previousDayRank(yesterday(), null), null);
  });
});

describe('조립 예시 (N=100, 31위 gold)', () => {
  it('builds the five messages in order with static amounts, and one screen-reader sentence list', () => {
    const messages = buildRankingInsights({
      me: { rank: 31, totalAssetKrw: '9955269.00000000', provisionalTier: 'gold' },
      participants: 100,
      first: row(1, 'demiant', '10001962.00000000', 'master'),
      above: row(30, 'hana', '9958658.00000000', 'gold'),
      tierEdge: [row(23, 'plat', '9972410.00000000', 'platinum'), row(24, 'gold24', '9970000.00000000', 'gold')],
      initialCapitalKrw: '10000000.00000000',
      previousRank: 35,
    });
    assert.deepEqual(view(messages), [
      'above|바로 위 hana까지|3,389|원|↑',
      'first|1위 demiant까지|46,693|원|1',
      'tier|Platinum 티어까지|17,141|원|P',
      'goal|본전(수익률 0%)까지|44,731|원|0%',
      'change|어제보다|4|계단 상승|▲',
    ]);
    assert.equal(messages[4].direction, 'up');
    assert.equal(describeRankingInsights(messages),
      '순위 안내. 바로 위 hana까지 3,389원. 1위 demiant까지 46,693원. Platinum 티어까지 17,141원. '
      + '본전(수익률 0%)까지 44,731원. 어제보다 4계단 상승.');
  });
});
