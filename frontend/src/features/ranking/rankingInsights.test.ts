import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { RankingsResponseDto } from './api.ts';
import {
  RANKING_INSIGHT_KEYS,
  RANKING_TIER_CUTOFF_RATIOS,
  buildRankingInsights,
  describeRankingInsights,
  explainRankingInsights,
  kstDateOf,
  nextReturnGoal,
  previousDayStanding,
  previousRankingDate,
  rankChange,
  rankingTierLastRanks,
  upperTierLastRank,
  wonChange,
  wonToPass,
  wonToReach,
  type RankingInsight,
  type RankingInsightInput,
  type RankingInsightRow,
} from './rankingInsights.ts';

const INITIAL = '10000000';
const row = (rank: number, userId: string, totalAssetKrw: string, provisionalTier: string): RankingInsightRow =>
  ({ rank, userId, nickname: userId, totalAssetKrw, provisionalTier });
// Primitive views only: messages are compared field by field, never as objects with hidden state.
const view = (messages: RankingInsight[]) => messages.map(({ key, label, value, suffix, glyph, detail }) =>
  [key, label, value, suffix, glyph, ...(detail ? [detail.text] : [])].join('|'));
const goalView = (goal: ReturnType<typeof nextReturnGoal>) =>
  goal ? `${goal.percent}% ${goal.amount.toFixed(0)}` : 'none';
const reasons = (input: RankingInsightInput) => {
  const explanation = explainRankingInsights(input);
  return RANKING_INSIGHT_KEYS.map((key) => `${key}=${explanation[key].reason}`).join(' ');
};

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
    assert.deepEqual(labels('9955269'), ['goal|본전까지|44,731|원|0%']);
    assert.deepEqual(labels('10001962'), ['goal|수익률 10%까지|998,038|원|%']);
    assert.deepEqual(labels('5000000'), ['goal|수익률 -30%까지|2,000,000|원|%']);
  });

  it('hides only the goal when the starting capital is unknown or not a number', () => {
    for (const initial of [undefined, null, '', 'abc', '0', '-1', 'NaN']) {
      assert.equal(goalView(nextReturnGoal(initial, '9955269')), 'none', String(initial));
      const messages = buildRankingInsights({ ...meOnly('9955269'), initialCapitalKrw: initial,
        previous: { rank: 35, totalAssetKrw: '9900000' } });
      assert.deepEqual(messages.map((message) => message.key), ['change']);
    }
  });
});

function meOnly(totalAssetKrw: string, rank = 1): RankingInsightInput {
  return {
    me: { rank, totalAssetKrw, provisionalTier: 'master' },
    participants: 100, first: null, above: null, tierEdge: null, previous: 'not_read',
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

  it('passes a person with the gap rounded up, 1 won on a tie, and never when they hold less', () => {
    assert.equal(wonToPass('103389', '100000')?.toFixed(0), '3389');
    assert.equal(wonToPass('100.2', '100')?.toFixed(0), '1');
    assert.equal(wonToPass('100.00000001', '100')?.toFixed(0), '1');
    assert.equal(wonToPass('100.5', '99.7')?.toFixed(0), '1');
    assert.equal(wonToPass('9007199254740995', '9007199254740993.5')?.toFixed(0), '2');
    assert.equal(wonToPass('100', '100')?.toFixed(0), '1', 'a tie is one won');
    assert.equal(wonToPass('100.00000000', '100')?.toFixed(0), '1', 'a tie in another scale');
    for (const [target, current] of [['99', '100'], ['99.99999999', '100'], ['abc', '1'], ['1', ''], ['Infinity', '1'], ['NaN', '1']]) {
      assert.equal(wonToPass(target, current) === null, true, `${target} vs ${current}`);
    }
  });

  it('a person level with me (a tie in total asset) is 1 won away', () => {
    const messages = buildRankingInsights({
      me: { rank: 31, totalAssetKrw: '9955269', provisionalTier: 'gold' }, participants: 100,
      first: row(1, 'demiant', '10001962', 'master'), above: row(30, 'hana', '9955269.00000000', 'gold'),
      tierEdge: null, previous: 'not_read',
    });
    assert.deepEqual(view(messages), ['above|바로 위 hana까지|1|원|↑', 'first|1위 demiant까지|46,693|원|1']);
  });

  it('hides a message whose person holds less than I do (the ranks and the amounts disagree)', () => {
    const input: RankingInsightInput = {
      me: { rank: 31, totalAssetKrw: '9955269', provisionalTier: 'gold' }, participants: 100,
      first: row(1, 'demiant', '9955268.99', 'master'), above: row(30, 'hana', '9955000', 'gold'),
      tierEdge: [row(23, 'plat', '9000000', 'platinum'), row(24, 'gold24', '8000000', 'gold')], previous: 'not_read',
    };
    assert.deepEqual(view(buildRankingInsights(input)), []);
    assert.equal(reasons(input), 'above=amount_invalid first=amount_invalid tier=amount_invalid '
      + 'goal=no_initial_capital change=not_read');
  });

  it('rounds a fractional gap up to whole won, at least 1', () => {
    const messages = buildRankingInsights({
      me: { rank: 3, totalAssetKrw: '9955269.6', provisionalTier: 'silver' }, participants: 3,
      first: row(1, 'alpha', '9955300.1', 'master'), above: row(2, 'beta', '9955269.7', 'gold'),
      tierEdge: [row(2, 'beta', '9955269.7', 'gold'), row(3, 'me', '9955269.6', 'silver')], previous: 'not_read',
    });
    assert.deepEqual(view(messages), ['above|바로 위 beta까지|1|원|↑', 'first|1위 alpha까지|31|원|1', 'tier|Gold 티어까지|1|원|G']);
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
    first: null, above: null, tierEdge: edge, previous: 'not_read',
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
    const cases: Array<[string, RankingInsightInput, string]> = [
      ['top tier', tierInput({ rank: 1, tier: 'master' }, 100, [row(1, 'me', '1000', 'master'), row(2, 'x', '900', 'master')]), 'top_tier'],
      ['my rank inside the upper tier', tierInput({ rank: 23, tier: 'gold' }, 100, [row(23, 'me', '1000', 'gold'), row(24, 'x', '900', 'gold')]), 'edge_mismatch'],
      ['edge row has my tier', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'gold'), row(24, 'b', '1400', 'gold')]), 'edge_mismatch'],
      ['row after the edge is another tier', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'platinum'), row(24, 'b', '1400', 'platinum')]), 'edge_mismatch'],
      ['a hidden row shifted the ranks', tierInput({ rank: 31, tier: 'gold' }, 100, [row(24, 'a', '1500', 'platinum'), row(25, 'b', '1400', 'gold')]), 'row_missing_or_rank_gap'],
      ['missing row', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'platinum'), null]), 'row_missing_or_rank_gap'],
      ['unknown tier name', tierInput({ rank: 31, tier: 'gold' }, 100, [row(23, 'a', '1500', 'grandmaster'), row(24, 'b', '1400', 'gold')]), 'edge_mismatch'],
      ['not read', tierInput({ rank: 31, tier: 'gold' }, 100, null), 'row_missing_or_rank_gap'],
      ['my tier unknown', tierInput({ rank: 31, tier: 'grandmaster' }, 100, null), 'unknown_tier'],
      ['no participant count', tierInput({ rank: 31, tier: 'gold' }, 0, null), 'edge_mismatch'],
    ];
    for (const [name, input, reason] of cases) {
      assert.deepEqual(view(buildRankingInsights(input)), [], name);
      assert.equal(explainRankingInsights(input).tier.reason, reason, name);
    }
  });
});

describe('합치지 않음과 순서', () => {
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
      initialCapitalKrw: INITIAL, previous: { rank: 3, totalAssetKrw: '10000000' },
    };
  };

  it('1위: no person to chase, only the goal and yesterday remain', () => {
    assert.deepEqual(view(buildRankingInsights(input(1))), [
      'goal|수익률 30%까지|1,000,000|원|%',
      'change|어제보다 자산|+2,000,000|원|▲|▲ 순위 2계단 상승',
    ]);
    assert.equal(reasons(input(1)), 'above=is_first first=is_first tier=top_tier goal=ok change=ok');
  });

  it('2위: 바로 위, 1위 and the upper tier are one person — each is still its own message', () => {
    assert.deepEqual(view(buildRankingInsights(input(2))), [
      'above|바로 위 alpha까지|1,500,000|원|↑',
      'first|1위 alpha까지|1,500,000|원|1',
      'tier|Whale 티어까지|1,500,000|원|W',
      'goal|수익률 10%까지|500,000|원|%',
      'change|어제보다 자산|+500,000|원|▲|▲ 순위 1계단 상승',
    ]);
  });

  it('3위: 바로 위 and the upper tier are one person, 1위 another; all three are shown', () => {
    assert.deepEqual(view(buildRankingInsights(input(3))), [
      'above|바로 위 beta까지|700,000|원|↑',
      'first|1위 alpha까지|2,200,000|원|1',
      'tier|Gold 티어까지|700,000|원|G',
      'goal|본전까지|200,000|원|0%',
      'change|어제보다 자산|-200,000|원|▼|– 순위 변동 없음',
    ]);
  });

  it('바로 위 that is the tier edge is shown under both labels, each in its own slot', () => {
    const messages = buildRankingInsights({
      me: { rank: 24, totalAssetKrw: '9000000', provisionalTier: 'gold' }, participants: 100,
      first: row(1, 'demiant', '12000000', 'master'), above: row(23, 'p23', '9500000', 'platinum'),
      tierEdge: [row(23, 'p23', '9500000', 'platinum'), row(24, 'me', '9000000', 'gold')], previous: 'not_read',
    });
    assert.deepEqual(view(messages), [
      'above|바로 위 p23까지|500,000|원|↑',
      'first|1위 demiant까지|3,000,000|원|1',
      'tier|Platinum 티어까지|500,000|원|P',
    ]);
  });

  it('drops 바로 위 and 1위 rows that are not the ranks they claim (a hidden participant)', () => {
    const messages = buildRankingInsights({
      me: { rank: 31, totalAssetKrw: '9955269', provisionalTier: 'gold' }, participants: 100,
      first: row(2, 'second', '10001962', 'master'), above: row(31, 'me', '9955269', 'gold'),
      tierEdge: null, previous: 'not_read',
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

describe('어제보다 (자산 증감 + 순위 변동)', () => {
  const yesterday = (patch: Record<string, unknown> = {}, state: 'available' | 'unavailable' = 'available') => ({
    state, rankingDate: '2026-10-13', capturedAt: '2026-10-13T14:55:00.000Z',
    myRanking: { state: 'available', rank: 35, totalAssetKrw: '9900000.00000000', rankingDate: '2026-10-13',
      capturedAt: '2026-10-13T14:55:00.000Z', ...patch },
  }) as unknown as RankingsResponseDto;
  const standing = (response: RankingsResponseDto | undefined, date: string | null = '2026-10-13') => {
    const read = previousDayStanding(response, date);
    return typeof read === 'string' ? read : `#${read.rank} ${read.totalAssetKrw}`;
  };

  it('counts rank steps up or down, 0 when unchanged, and nothing for an unknown rank', () => {
    assert.deepEqual(rankChange(31, 35), { steps: 4, direction: 'up' });
    assert.deepEqual(rankChange(35, 31), { steps: 4, direction: 'down' });
    assert.deepEqual(rankChange(31, 31), { steps: 0 });
    assert.equal(rankChange(31, null), null);
    const change = (previousRank: number) =>
      view(buildRankingInsights({ ...meOnly('1', 31), previous: { rank: previousRank, totalAssetKrw: '1' } }));
    assert.deepEqual(change(35), ['change|어제보다 자산|변동 없음||–|▲ 순위 4계단 상승']);
    assert.deepEqual(change(30), ['change|어제보다 자산|변동 없음||–|▼ 순위 1계단 하락']);
    assert.deepEqual(change(31), ['change|어제보다 자산|변동 없음||–|– 순위 변동 없음']);
  });

  it("uses yesterday's last set only when it was captured on that KST date, and says why not", () => {
    assert.equal(standing(yesterday()), '#35 9900000.00000000');
    // 23:59:59 KST is still yesterday; 00:00 KST of today is not.
    assert.equal(standing(yesterday({ capturedAt: '2026-10-13T14:59:59.000Z' })), '#35 9900000.00000000');
    assert.equal(standing(yesterday({ capturedAt: '2026-10-13T15:00:00.000Z' })), 'captured_at_mismatch');
    // A set stored under its UTC date (before 2026-10-14) and captured after 15:00 UTC.
    assert.equal(standing(yesterday({ capturedAt: '2026-10-13T20:00:00.000Z' })), 'captured_at_mismatch');
    assert.equal(standing(yesterday({ rankingDate: '2026-10-12' })), 'date_mismatch');
    assert.equal(standing(yesterday({}, 'unavailable')), 'no_previous_set');
    assert.equal(standing(yesterday({ state: 'not_joined' })), 'no_my_row');
    assert.equal(standing(yesterday({ rank: 0 })), 'previous_rank_invalid');
    assert.equal(standing(yesterday({ totalAssetKrw: 'abc' })), 'previous_asset_invalid');
    assert.equal(standing(yesterday({ totalAssetKrw: 'Infinity' })), 'previous_asset_invalid');
    assert.equal(standing(yesterday({ totalAssetKrw: null })), 'previous_asset_invalid');
    assert.equal(standing(undefined), 'not_read');
    assert.equal(standing(yesterday(), null), 'no_previous_date');
    // Every miss hides the whole message.
    for (const response of [yesterday({ rankingDate: '2026-10-12' }), yesterday({}, 'unavailable'), yesterday({ totalAssetKrw: 'abc' }), undefined]) {
      const previous = previousDayStanding(response, '2026-10-13');
      assert.deepEqual(view(buildRankingInsights({ ...meOnly('9955269', 31), previous })), []);
    }
  });

  it('rounds the asset change to whole won half up, signed, and says 변동 없음 at zero', () => {
    const won = (now: string, before: string) => wonChange(now, before)?.toFixed(0) ?? 'none';
    assert.equal(won('9955269', '9900000'), '55269');
    assert.equal(won('9955269.5', '9900000'), '55270');
    assert.equal(won('9955269.49', '9900000'), '55269');
    assert.equal(won('9855269.5', '9900000'), '-44731', 'a half won moves away from zero');
    assert.equal(won('9855269.51', '9900000'), '-44730');
    assert.equal(won('100.4', '100'), '0');
    assert.equal(won('99.6', '100'), '0');
    assert.equal(won('abc', '100'), 'none');
    const value = (now: string, before: string) => {
      const [message] = buildRankingInsights({ ...meOnly(now, 31), previous: { rank: 31, totalAssetKrw: before } });
      return [message.value, message.suffix, message.glyph, message.direction ?? '-'].join(' ');
    };
    assert.equal(value('9955269.5', '9900000'), '+55,270 원 ▲ up');
    assert.equal(value('9855269.5', '9900000'), '-44,731 원 ▼ down');
    assert.equal(value('100.4', '100'), '변동 없음  – -');
    assert.equal(value('99.6', '100.0000'), '변동 없음  – -');
    assert.equal(value('100.5', '100'), '+1 원 ▲ up');
    assert.equal(value('99.5', '100'), '-1 원 ▼ down');
    assert.equal(reasons({ ...meOnly('abc', 31), previous: { rank: 31, totalAssetKrw: '100' } }).endsWith('change=amount_invalid'), true);
    assert.equal(reasons({ ...meOnly('100', 31), previous: { rank: 31, totalAssetKrw: 'abc' } }).endsWith('change=previous_asset_invalid'), true);
  });

  it('colors the figure by the asset and the second line by the rank, each with its own direction', () => {
    const [up] = buildRankingInsights({ ...meOnly('9955269', 2), previous: { rank: 1, totalAssetKrw: '9900000' } });
    assert.deepEqual([up.direction, up.detail?.direction, up.detail?.text, up.detail?.spoken],
      ['up', 'down', '▼ 순위 1계단 하락', '순위 1계단 하락']);
    const [same] = buildRankingInsights({ ...meOnly('9900000', 2), previous: { rank: 2, totalAssetKrw: '9900000' } });
    assert.deepEqual([same.direction === undefined, same.detail?.direction === undefined, same.detail?.spoken],
      [true, true, '순위 변동 없음']);
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
      previous: { rank: 35, totalAssetKrw: '9900000.00000000' },
    });
    assert.deepEqual(view(messages), [
      'above|바로 위 hana까지|3,389|원|↑',
      'first|1위 demiant까지|46,693|원|1',
      'tier|Platinum 티어까지|17,141|원|P',
      'goal|본전까지|44,731|원|0%',
      'change|어제보다 자산|+55,269|원|▲|▲ 순위 4계단 상승',
    ]);
    assert.equal(messages[4].direction, 'up');
    assert.equal(describeRankingInsights(messages),
      '순위 안내. 바로 위 hana까지 3,389원. 1위 demiant까지 46,693원. Platinum 티어까지 17,141원. '
      + '본전까지 44,731원. 어제보다 자산 +55,269원, 순위 4계단 상승.');
    const [unchanged] = buildRankingInsights({ ...meOnly('9900000', 31), previous: { rank: 31, totalAssetKrw: '9900000' } });
    assert.equal(describeRankingInsights([unchanged]), '순위 안내. 어제보다 자산 변동 없음, 순위 변동 없음.');
  });
});

// ---------------------------------------------------------------------------
// The task's test vectors (1-10). Tiers are assigned here the way the backend
// assigns them (assignRankingTier), written out independently of the copy.

const BACKEND_TIERS = [['master', 0.04], ['diamond', 0.11], ['platinum', 0.23], ['gold', 0.4], ['silver', 0.7], ['bronze', 1]] as const;
const DISPLAY: Record<string, string> = { master: 'Whale', diamond: 'Diamond', platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
const lastRankOf = (index: number, n: number) => Math.max(1, Math.ceil(n * BACKEND_TIERS[index][1]));
const tierIndexAt = (rank: number, n: number) => BACKEND_TIERS.findIndex((_, index) => rank <= lastRankOf(index, n));
const tierAt = (rank: number, n: number) => BACKEND_TIERS[tierIndexAt(rank, n)][0];

/** A league in rank order: `[nickname, total asset]`. */
function league(people: ReadonlyArray<readonly [string, string]>): RankingInsightRow[] {
  return people.map(([nickname, totalAssetKrw], index) => ({
    rank: index + 1, userId: nickname, nickname, totalAssetKrw, provisionalTier: tierAt(index + 1, people.length),
  }));
}

/** What useRankingInsights hands over for my rank: rows by rank, the edge at b and b + 1. */
function leagueInput(rows: RankingInsightRow[], myRank: number,
  previous: RankingInsightInput['previous'] = 'no_previous_set'): RankingInsightInput {
  const at = (rank: number) => rows.find((candidate) => candidate.rank === rank) ?? null;
  const mine = at(myRank)!;
  const edge = upperTierLastRank(mine.provisionalTier, rows.length);
  return {
    me: { rank: myRank, totalAssetKrw: mine.totalAssetKrw, provisionalTier: mine.provisionalTier },
    participants: rows.length, first: at(1), above: at(myRank - 1),
    tierEdge: edge === null ? null : [at(edge), at(edge + 1)],
    initialCapitalKrw: INITIAL, previous,
  };
}

// `key · 라벨 · 값 · 글리프` (+ the second line), as the task writes them.
const spec = (messages: RankingInsight[]) => messages.map(({ key, label, value, suffix, glyph, detail }) =>
  [key, label, `${value}${suffix}`, glyph, ...(detail ? [detail.text] : [])].join(' · '));

describe('테스트 벡터 (1-10)', () => {
  const caseLeague = league([['demiant', '10001962'], ['mycroft', '9955269'], ['john', '9458377']]);

  it('케이스 A: 3명, mycroft 2위 (Gold); 어제 3위 9,900,000', () => {
    assert.deepEqual(caseLeague.map((person) => person.provisionalTier), ['master', 'gold', 'silver']);
    const messages = buildRankingInsights(leagueInput(caseLeague, 2, { rank: 3, totalAssetKrw: '9900000' }));
    assert.deepEqual(spec(messages), [
      'above · 바로 위 demiant까지 · 46,693원 · ↑',
      'first · 1위 demiant까지 · 46,693원 · 1',
      'tier · Whale 티어까지 · 46,693원 · W',
      'goal · 본전까지 · 44,731원 · 0%',
      'change · 어제보다 자산 · +55,269원 · ▲ · ▲ 순위 1계단 상승',
    ]);
    assert.equal(messages[2].tier, 'master', 'the tier glyph takes the master palette');
    assert.deepEqual([messages[4].direction, messages[4].detail?.direction], ['up', 'up']);
  });

  it('케이스 A의 어제 변형과 어제 세트 없음', () => {
    const change = (previous: RankingInsightInput['previous']) =>
      spec(buildRankingInsights(leagueInput(caseLeague, 2, previous))).find((message) => message.startsWith('change')) ?? 'none';
    assert.equal(change({ rank: 2, totalAssetKrw: '10000000' }), 'change · 어제보다 자산 · -44,731원 · ▼ · – 순위 변동 없음');
    assert.equal(change({ rank: 2, totalAssetKrw: '9955269' }), 'change · 어제보다 자산 · 변동 없음 · – · – 순위 변동 없음');
    assert.equal(change({ rank: 1, totalAssetKrw: '10100000' }), 'change · 어제보다 자산 · -144,731원 · ▼ · ▼ 순위 1계단 하락');
    assert.equal(change('no_previous_set'), 'none');
    assert.equal(buildRankingInsights(leagueInput(caseLeague, 2, 'no_previous_set')).length, 4);
  });

  it('케이스 B: 같은 리그, john 3위 (Silver); 어제 3위 9,500,000', () => {
    assert.deepEqual(spec(buildRankingInsights(leagueInput(caseLeague, 3, { rank: 3, totalAssetKrw: '9500000' }))), [
      'above · 바로 위 mycroft까지 · 496,892원 · ↑',
      'first · 1위 demiant까지 · 543,585원 · 1',
      'tier · Gold 티어까지 · 496,892원 · G',
      'goal · 본전까지 · 541,623원 · 0%',
      'change · 어제보다 자산 · -41,623원 · ▼ · – 순위 변동 없음',
    ]);
  });

  it('케이스 C (동점): 30명, 1위만 10,300,000, 15위 Silver, 어제 세트 없음', () => {
    const rows = league(Array.from({ length: 30 }, (_, index) =>
      [`user${index + 1}`, index === 0 ? '10300000' : '10000000'] as const));
    assert.equal(rows[14].provisionalTier, 'silver');
    assert.deepEqual(spec(buildRankingInsights(leagueInput(rows, 15))), [
      'above · 바로 위 user14까지 · 1원 · ↑',
      'first · 1위 user1까지 · 300,000원 · 1',
      'tier · Gold 티어까지 · 1원 · G',
      'goal · 수익률 10%까지 · 1,000,000원 · %',
    ]);
  });

  it('케이스 D (기준선): 10명, 7,000원 간격, 7위 Silver, 어제 세트 없음', () => {
    const rows = league(Array.from({ length: 10 }, (_, index) => [`user${index + 1}`, String(10_500_000 - 7_000 * index)] as const));
    assert.equal(rows[6].totalAssetKrw, '10458000');
    assert.equal(rows[6].provisionalTier, 'silver');
    assert.deepEqual(spec(buildRankingInsights(leagueInput(rows, 7))), [
      'above · 바로 위 user6까지 · 7,000원 · ↑',
      'first · 1위 user1까지 · 42,000원 · 1',
      'tier · Gold 티어까지 · 21,000원 · G',
      'goal · 수익률 10%까지 · 542,000원 · %',
    ]);
  });

  it('내가 1위이면 바로 위와 1위는 없다', () => {
    const input = leagueInput(caseLeague, 1, { rank: 1, totalAssetKrw: '10001962' });
    assert.deepEqual(buildRankingInsights(input).map((message) => message.key), ['goal', 'change']);
    assert.equal(reasons(input), 'above=is_first first=is_first tier=top_tier goal=ok change=ok');
  });
});

describe('전수 확인 (참가자 수와 순위 전체)', () => {
  /** Shown keys, checked against explainRankingInsights for the same input. */
  const shownKeys = (input: RankingInsightInput, failures: string[], where: string) => {
    const shown = buildRankingInsights(input).map((message) => message.key);
    const explanation = explainRankingInsights(input);
    for (const key of RANKING_INSIGHT_KEYS) {
      if (explanation[key].shown !== shown.includes(key)) failures.push(`${where}: explain disagrees on ${key}`);
    }
    return shown;
  };

  it('1,000원씩 줄어드는 리그, N = 1~300, 모든 순위', () => {
    const failures: string[] = [];
    let checked = 0;
    for (let n = 1; n <= 300; n += 1) {
      const rows = league(Array.from({ length: n }, (_, index) => [`u${index + 1}`, String(10_150_000 - 1_000 * index)] as const));
      for (let rank = 1; rank <= n; rank += 1) {
        const where = `N=${n} #${rank}`;
        const input = leagueInput(rows, rank);
        const messages = buildRankingInsights(input);
        const shown = shownKeys(input, failures, where);
        const index = tierIndexAt(rank, n);
        const expected = [
          ...(rank >= 2 ? ['above', 'first'] : []),
          ...(index > 0 ? ['tier'] : []),
          'goal',
        ];
        if (shown.join() !== expected.join()) failures.push(`${where}: ${shown.join()} != ${expected.join()}`);
        const value = (key: string) => messages.find((message) => message.key === key)?.value;
        if (rank >= 2 && value('above') !== '1,000') failures.push(`${where}: above ${value('above')}`);
        if (rank >= 2 && value('first') !== (1_000 * (rank - 1)).toLocaleString('en-US')) failures.push(`${where}: first ${value('first')}`);
        if (index > 0) {
          const edge = lastRankOf(index - 1, n);
          const tier = messages.find((message) => message.key === 'tier');
          const label = `${DISPLAY[tierAt(edge, n)]} 티어까지`;
          if (tier?.label !== label || tier.value !== (1_000 * (rank - edge)).toLocaleString('en-US')) {
            failures.push(`${where}: tier ${tier?.label} ${tier?.value} != ${label}`);
          }
        }
        checked += 1;
      }
    }
    assert.equal(checked, 45_150);
    assert.deepEqual(failures.slice(0, 5), []);
  });

  it('1위만 앞서고 나머지는 모두 동점인 리그, N = 2~120, 순위 2 이상', () => {
    const failures: string[] = [];
    for (let n = 2; n <= 120; n += 1) {
      const rows = league(Array.from({ length: n }, (_, index) => [`u${index + 1}`, index === 0 ? '10300000' : '10000000'] as const));
      for (let rank = 2; rank <= n; rank += 1) {
        const where = `N=${n} #${rank}`;
        const input = leagueInput(rows, rank);
        const messages = buildRankingInsights(input);
        const shown = shownKeys(input, failures, where);
        const index = tierIndexAt(rank, n);
        const expected = ['above', 'first', ...(index > 0 ? ['tier'] : []), 'goal'];
        if (shown.join() !== expected.join()) failures.push(`${where}: ${shown.join()} != ${expected.join()}`);
        const value = (key: string) => messages.find((message) => message.key === key)?.value;
        if (value('above') !== (rank === 2 ? '300,000' : '1')) failures.push(`${where}: above ${value('above')}`);
        if (value('first') !== '300,000') failures.push(`${where}: first ${value('first')}`);
        if (index > 0 && value('tier') !== (lastRankOf(index - 1, n) === 1 ? '300,000' : '1')) {
          failures.push(`${where}: tier ${value('tier')}`);
        }
      }
    }
    assert.deepEqual(failures.slice(0, 5), []);
  });
});

describe('숨김 이유 (explainRankingInsights)', () => {
  it('names the reason of every hidden message and agrees with what is shown', () => {
    const caseLeague = league([['demiant', '10001962'], ['mycroft', '9955269'], ['john', '9458377']]);
    assert.equal(reasons(leagueInput(caseLeague, 2, { rank: 3, totalAssetKrw: '9900000' })),
      'above=ok first=ok tier=ok goal=ok change=ok');
    assert.equal(reasons(leagueInput(caseLeague, 2)), 'above=ok first=ok tier=ok goal=ok change=no_previous_set');
    // A hidden participant between ranks: the rows read by offset are not the ranks expected.
    const gap = { ...leagueInput(caseLeague, 3), above: null, tierEdge: [null, null] as const };
    assert.equal(reasons(gap), 'above=row_missing_or_rank_gap first=ok tier=row_missing_or_rank_gap goal=ok change=no_previous_set');
    assert.equal(reasons({ ...leagueInput(caseLeague, 3), initialCapitalKrw: null }).includes('goal=no_initial_capital'), true);
    assert.equal(reasons({ ...leagueInput(caseLeague, 2), me: { rank: 0, totalAssetKrw: '1', provisionalTier: 'gold' } }),
      'above=my_rank_invalid first=my_rank_invalid tier=my_rank_invalid goal=my_rank_invalid change=my_rank_invalid');
    for (const miss of ['no_previous_date', 'not_read', 'no_my_row', 'date_mismatch', 'captured_at_mismatch'] as const) {
      assert.equal(explainRankingInsights(leagueInput(caseLeague, 2, miss)).change.reason, miss);
    }
  });
});
