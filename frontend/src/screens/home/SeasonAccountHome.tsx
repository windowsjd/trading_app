import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getTradingAccountEquity,
  getTradingAccountPortfolio,
  getTradingAccountPositions,
  getTradingAccountWallets,
  type TradingAccountAllocationDto,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import {
  getAccountDisplay,
  getReturnRateMethodLabel,
} from '../../features/tradingAccount/accountDisplay';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { CAPABILITY_BLOCK_MESSAGE } from '../../features/tradingAccount/capabilities';
import type { TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getRankings, getRankingTier } from '../../features/ranking/api';
import { getWalletBalanceAmount } from '../../features/wallet/mapper';
import { formatKrw, formatPercent, getAssetNameDisplay } from '../../utils/format';

import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import {
  DonutChart,
  LineChart,
  type LineChartPoint,
} from '../../components/charts';

/**
 * Home for a SEASON account (작업 11 §10.1).
 *
 * WHY THIS EXISTS INSTEAD OF `/home`
 * ----------------------------------
 * The season dashboard endpoint answers "how is this user doing in the CURRENT
 * season", resolving the participant itself from whichever season is running.
 * Home, though, is about the account the switcher names. Those two agree only
 * while the selected account happens to be the current season's — and the
 * selection policy can land on a settled season's account (rule 4), and the
 * user can pick any account they own at any time. In every other case the
 * screen showed one season's name over another season's money.
 *
 * So every number here is read with the account's own id, and the rank is read
 * with the account's own `seasonId`. There is no code path left that asks the
 * server "which season is current?" on this screen.
 *
 * WHAT IS NOT SHOWN
 * -----------------
 * No time-weighted return, no external-funding breakdown, no ad reward: those
 * are general-mode concepts. A season account is funded once, at a fixed
 * initial capital, and its return is measured against exactly that.
 */

type Props = {
  account: TradingAccountDto;
  capabilities: TradingAccountCapabilities | null;
  onOpenLedger: () => void;
  onOpenFx: () => void;
  onOpenPortfolio: () => void;
  onOpenMarket: () => void;
  onOpenRanking: () => void;
  onOpenReward: () => void;
  onOpenAsset: (assetId: string) => void;
};

const POSITIONS_PREVIEW_LIMIT = 5;
const EQUITY_RANGE = '30d' as const;

function formatKrwChartValue(value: number) {
  return `${formatKrw(value)}원`;
}

/** Allocation rows for the donut, from the ACCOUNT's own portfolio payload. */
function getAllocationSegments(allocation: TradingAccountAllocationDto | null) {
  if (!allocation || allocation.state !== 'available') return [];

  return [
    { key: 'cash', label: '현금', value: allocation.cashKrwValue },
    { key: 'domestic', label: '국내', value: allocation.domesticStockValueKrw },
    { key: 'us', label: '미국', value: allocation.usStockValueKrw },
    { key: 'crypto', label: '암호화폐', value: allocation.cryptoValueKrw },
  ].filter((item) => !!item.value);
}

export default function SeasonAccountHome({
  account,
  capabilities,
  onOpenLedger,
  onOpenFx,
  onOpenPortfolio,
  onOpenMarket,
  onOpenRanking,
  onOpenReward,
  onOpenAsset,
}: Props) {
  const accountId = account.id;
  const season = account.season;
  const display = getAccountDisplay(account);

  // A settled season is ranked by its FINAL table; a running one by the daily
  // snapshot. Asking for the wrong one returns an empty ranking, which would
  // read as "you are unranked".
  const rankType = season?.seasonStatus === 'settled' ? 'final' : 'daily';
  const isSettled = season?.seasonStatus === 'settled';

  const portfolioQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
  });

  const available = portfolioQuery.data?.state === 'available';

  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.wallets(accountId),
    queryFn: () => getTradingAccountWallets(accountId),
    enabled: available,
  });

  const positionsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, {
      limit: POSITIONS_PREVIEW_LIMIT,
    }),
    queryFn: () =>
      getTradingAccountPositions(accountId, {
        limit: POSITIONS_PREVIEW_LIMIT,
        offset: 0,
      }),
    enabled: available,
  });

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(accountId, EQUITY_RANGE),
    queryFn: () => getTradingAccountEquity(accountId, EQUITY_RANGE),
    enabled: available,
  });

  /**
   * The leaderboard row for THIS account's season, named explicitly. `near_me`
   * is requested for its `myRanking`; the surrounding rows are the ranking
   * tab's job, not Home's.
   */
  const rankingQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list({
      scope: 'near_me',
      seasonId: season?.seasonId ?? null,
      rankType,
      limit: 1,
      offset: 0,
    }),
    queryFn: () =>
      getRankings({
        scope: 'near_me',
        seasonId: season?.seasonId,
        rankType,
        limit: 1,
        offset: 0,
      }),
    enabled: !!season?.seasonId,
  });

  const integrityMessage = portfolioQuery.isError
    ? getIntegrityErrorMessage(portfolioQuery.error)
    : null;

  if (integrityMessage) {
    return (
      <View testID={TEST_IDS.tradingAccount.integrityError}>
        <ErrorState
          title="계정 데이터를 안전하게 표시할 수 없습니다."
          message={integrityMessage}
          onRetry={() => portfolioQuery.refetch()}
        />
      </View>
    );
  }

  if (portfolioQuery.isLoading) {
    return <SectionSkeleton lines={6} />;
  }

  if (portfolioQuery.isError || !portfolioQuery.data) {
    return (
      <ErrorState
        title="계정 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => portfolioQuery.refetch()}
      />
    );
  }

  const portfolio = portfolioQuery.data;
  const summary = portfolio.summary;
  const positions = positionsQuery.data?.positions ?? [];
  const myRanking = rankingQuery.data?.myRanking ?? null;
  const rank =
    myRanking?.rank === undefined || myRanking?.rank === null
      ? '-'
      : `#${myRanking.rank}`;
  const tier = getRankingTier(myRanking, rankType);
  const tradeNotice =
    capabilities && !capabilities.canTrade && capabilities.tradeBlockReason
      ? CAPABILITY_BLOCK_MESSAGE[capabilities.tradeBlockReason]
      : null;
  const allocationSegments = getAllocationSegments(portfolio.allocation);
  const equityPoints: LineChartPoint[] = (equityQuery.data?.points ?? [])
    .map<LineChartPoint | null>((point) => {
      const value = Number(point.totalAssetKrw);
      if (!Number.isFinite(value)) return null;
      return { x: point.time, y: value, label: point.time };
    })
    .filter((point): point is LineChartPoint => point !== null);

  return (
    <ScrollView
      testID={TEST_IDS.tradingAccount.seasonSummary}
      contentContainerStyle={styles.content}
    >
      <View style={styles.card}>
        {/* The season this screen is about, said before any number appears. */}
        <Text style={styles.label}>시즌</Text>
        <Text style={styles.seasonName}>{display.title}</Text>
        <Text style={styles.helper}>
          {display.subtitle ?? '시즌 정보를 확인할 수 없습니다.'}
        </Text>
        <Text style={styles.helper}>계정 상태 {display.statusLabel}</Text>
      </View>

      {portfolio.sectionErrors.length > 0 ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>일부 정보 지연</Text>
          <Text style={styles.warningText}>
            {portfolio.sectionErrors[0]?.message ??
              '일부 계정 정보를 불러오지 못했습니다.'}
          </Text>
        </View>
      ) : null}

      <View testID={TEST_IDS.home.summaryCard} style={styles.card}>
        <Text style={styles.label}>{isSettled ? '최종 자산' : '총 자산'}</Text>
        {summary ? (
          <>
            <Text style={styles.big}>{formatKrw(summary.totalAssetKrw)}원</Text>
            <Text style={styles.helper}>
              {getReturnRateMethodLabel(summary.returnRateMethod)}{' '}
              {summary.returnRate === null || summary.returnRate === undefined
                ? '알 수 없음'
                : `${formatPercent(summary.returnRate)}%`}
            </Text>
            <Text style={styles.helper}>
              KRW 현금 {formatKrw(summary.krwCash)}
            </Text>
            <Text style={styles.helper}>
              USD 환산 {formatKrw(summary.usdCashKrw)}
            </Text>
            <Text style={styles.helper}>
              보유자산 {formatKrw(summary.assetValueKrw)}
            </Text>
            <Text style={styles.helper}>
              실현 손익 {formatKrw(summary.realizedPnlKrw)}
            </Text>
            <Text style={styles.helper}>
              평가 손익 {formatKrw(summary.unrealizedPnlKrw)}
            </Text>
          </>
        ) : (
          // Unavailable performance is said, not rendered as 0원 / 0%.
          <InlineEmptyState
            title="수익률을 계산할 수 없습니다."
            message={
              portfolio.message ??
              '계정 성과 데이터가 아직 준비되지 않았습니다. 0%가 아니라 알 수 없는 상태입니다.'
            }
          />
        )}
      </View>

      <View style={styles.row}>
        <View style={[styles.card, styles.flex]}>
          <Text style={styles.label}>{isSettled ? '최종 순위' : '현재 순위'}</Text>
          {rankingQuery.isLoading ? (
            <SectionSkeleton lines={1} />
          ) : (
            <Text style={styles.medium}>{rank}</Text>
          )}
        </View>
        <View style={[styles.card, styles.flex]}>
          <Text style={styles.label}>{isSettled ? '최종 등급' : '현재 등급'}</Text>
          {rankingQuery.isLoading ? (
            <SectionSkeleton lines={1} />
          ) : (
            <Text style={styles.medium}>{tier}</Text>
          )}
        </View>
      </View>

      {rankingQuery.isError ? (
        <InlineEmptyState message="랭킹 정보를 불러오지 못했습니다. 자산 정보는 위에 표시된 값이 최신입니다." />
      ) : null}

      <View style={styles.card}>
        <Text style={styles.label}>지갑 요약</Text>
        {walletsQuery.isLoading ? (
          <SectionSkeleton lines={2} />
        ) : walletsQuery.isError ? (
          <InlineEmptyState message="지갑 요약을 불러오지 못했습니다." />
        ) : (
          <>
            <Text style={styles.helper}>
              KRW {formatKrw(getWalletBalanceAmount(walletsQuery.data, 'KRW'))}
            </Text>
            <Text style={styles.helper}>
              USD {getWalletBalanceAmount(walletsQuery.data, 'USD')}
            </Text>
            <Pressable style={styles.secondaryButton} onPress={onOpenLedger}>
              <Text style={styles.secondaryText}>원장 보기</Text>
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>자산 배분</Text>
        {allocationSegments.length > 0 ? (
          <DonutChart
            segments={allocationSegments}
            valueFormatter={formatKrwChartValue}
            emptyMessage="자산 배분 정보를 표시할 수 없습니다."
          />
        ) : (
          <InlineEmptyState
            message={
              portfolio.allocation.message ??
              '자산 배분 정보를 표시할 수 없습니다.'
            }
          />
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>자산 추이</Text>
        {equityQuery.isLoading ? (
          <SectionSkeleton lines={4} />
        ) : equityQuery.isError ? (
          <InlineEmptyState message="자산 추이를 불러오지 못했습니다." />
        ) : equityPoints.length > 0 ? (
          <LineChart
            points={equityPoints}
            valueFormatter={formatKrwChartValue}
            emptyMessage="수익 추이를 표시하려면 데이터가 더 필요합니다."
          />
        ) : (
          <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>보유 종목</Text>
        {positionsQuery.isLoading ? (
          <SectionSkeleton lines={3} />
        ) : positionsQuery.isError ? (
          <InlineEmptyState message="보유 종목을 불러오지 못했습니다." />
        ) : positions.length === 0 ? (
          <InlineEmptyState
            title="보유 종목이 없습니다."
            message="아직 매수한 종목이 없습니다."
          />
        ) : (
          positions.map((position) => {
            const nameDisplay = getAssetNameDisplay({
              name: position.name ?? position.asset?.name,
              symbol: position.symbol ?? position.asset?.symbol,
            });
            return (
              <Pressable
                key={position.assetId}
                testID={TEST_IDS.home.positionItem(position.assetId)}
                style={styles.positionRow}
                onPress={() => onOpenAsset(position.assetId)}
              >
                <Text style={styles.positionName}>{nameDisplay.primary}</Text>
                <Text style={styles.positionValue}>
                  {formatKrw(position.marketValueKrw)}
                </Text>
              </Pressable>
            );
          })
        )}
      </View>

      {/*
        CTAs follow the account's capabilities, not the app's mood (작업 11
        §10.3). A closed or settled season account keeps every READ route — its
        holdings, its ledger, its leaderboard row, its rewards — and is offered
        no route whose only outcome would be a refused mutation.
      */}
      <View style={styles.row}>
        {capabilities?.canExchange ? (
          <CTAButton label="환전하기" onPress={onOpenFx} style={styles.flex} />
        ) : null}
        <CTAButton
          label="포트폴리오"
          onPress={onOpenPortfolio}
          style={styles.flex}
        />
      </View>

      <View style={styles.row}>
        {capabilities?.canTrade ? (
          <CTAButton
            label="마켓으로 이동"
            onPress={onOpenMarket}
            style={styles.flex}
          />
        ) : null}
        <CTAButton label="랭킹 보기" onPress={onOpenRanking} style={styles.flex} />
      </View>

      {isSettled ? (
        <CTAButton label="보상 확인" onPress={onOpenReward} />
      ) : null}

      {tradeNotice ? (
        <View
          testID={TEST_IDS.tradingAccount.capabilityNotice}
          style={styles.noticeBox}
        >
          <Text style={styles.warningTitle}>거래 제한</Text>
          <Text style={styles.warningText}>{tradeNotice}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  row: { flexDirection: 'row', gap: 12 },
  // minWidth:0 so a long tier label wraps inside its half instead of pushing
  // the other card off the row.
  flex: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, color: '#666' },
  seasonName: { fontSize: 20, fontWeight: '700', lineHeight: 28 },
  big: { fontSize: 26, fontWeight: '700', lineHeight: 34, flexShrink: 1 },
  medium: { fontSize: 20, fontWeight: '700', lineHeight: 28 },
  helper: { fontSize: 14, color: '#444', lineHeight: 21 },
  warningBox: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#FFF3CD',
    gap: 4,
  },
  noticeBox: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#EEF3FB',
    gap: 4,
  },
  warningTitle: { fontSize: 14, fontWeight: '700', color: '#7A5D00' },
  warningText: { fontSize: 13, color: '#7A5D00', lineHeight: 19 },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  positionName: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20 },
  positionValue: { flexShrink: 0, fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  secondaryText: { color: '#111', fontWeight: '600' },
});
