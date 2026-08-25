import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { PortfolioScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { TEST_IDS } from '../../constants/testIds';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { PortfolioViewState } from '../../models/enums/viewState';
import type {
  PortfolioAllocationDto,
  PortfolioAssetType,
} from '../../features/portfolio/api';
import {
  getTradingAccountEquity,
  getTradingAccountPortfolio,
  getTradingAccountPositions,
  type TradingAccountEquityRange,
  type TradingAccountPortfolioSummaryDto,
} from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { classifyAccountError } from '../../features/tradingAccount/integrityErrors';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { getReturnRateMethodLabel } from '../../features/tradingAccount/accountDisplay';
import { getCapabilityBlockMessage } from '../../features/tradingAccount/capabilities';
import { getPositionDisplay } from '../../features/position/display';
import { getPortfolioNotice as getTradingAccountPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import {
  DonutChart,
  LineChart,
  type DonutChartSegment,
  type LineChartPoint,
} from '../../components/charts';
import {
  formatKrw,
  formatKstDateTime,
  formatPercent,
  getAssetNameDisplay,
} from '../../utils/format';

type Props = PortfolioScreenProps;

const POSITION_TABS: Array<{ key: PortfolioAssetType; label: string }> = [
  { key: 'domestic_stock', label: '국내 주식' },
  { key: 'us_stock', label: '미국 주식' },
  { key: 'crypto', label: '암호화폐' },
];

/**
 * The account-scoped equity endpoint's ranges (작업 9 §B-5). `all` means "since
 * the account opened", which for a season account is the season and for a
 * general account is its whole life — one label cannot claim to be both, so it
 * is called 전체 rather than 시즌.
 */
const RANGE_TABS: Array<{ key: TradingAccountEquityRange; label: string }> = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'all', label: '전체' },
];

const POSITIONS_PAGE_SIZE = 20;

/** One row of the position list, normalised from the account-scoped payload. */
type PortfolioPositionRow = {
  positionId: string;
  assetId: string;
  symbol: string;
  name: string;
  quantity: string;
  averageCost: string;
  currentPrice: string | null;
  positionValueKrw: string;
  unrealizedPnlKrw: string;
  returnRate: string;
  priceNotice: string | null;
};

function formatKrwChartValue(value: number) {
  return `${formatKrw(value)}원`;
}

function getAllocationSegments(
  allocation: PortfolioAllocationDto,
): DonutChartSegment[] {
  return [
    { key: 'cash', label: '현금', value: allocation.cashKrwValue },
    {
      key: 'domestic_stock',
      label: '국내 주식',
      value: allocation.domesticStockValueKrw,
    },
    { key: 'us_stock', label: '미국 주식', value: allocation.usStockValueKrw },
    { key: 'crypto', label: '암호화폐', value: allocation.cryptoValueKrw },
  ];
}

function getEquityChartPoints(
  points: Array<{ time: string; totalAssetKrw: string }>,
): LineChartPoint[] {
  return points.map((point) => ({
    x: point.time,
    y: point.totalAssetKrw,
    label: formatKstDateTime(point.time),
  }));
}

export default function PortfolioScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const {
    selectedAccountId,
    capabilities,
    isLoading: accountsLoading,
    isEmpty: noAccounts,
    handleSelectedAccountMissing,
  } = useTradingAccount();
  const [assetType, setAssetType] =
    useState<PortfolioAssetType>('domestic_stock');
  const [range, setRange] = useState<TradingAccountEquityRange>('all');

  // Every query below is keyed on the accountId and disabled until one is
  // selected (작업 9 §B-4). Because the key CHANGES on a switch rather than
  // being invalidated, react-query treats the new account as a different query
  // with no data — so the previous account's numbers are never shown under the
  // new account's heading, not even for one frame.
  const accountId = selectedAccountId ?? '';
  const hasAccount = !!selectedAccountId;

  const overviewQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
    enabled: hasAccount,
  });

  const isPortfolioAvailable =
    overviewQuery.data?.state === 'available' && !!overviewQuery.data.summary;

  const positionsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, {
      assetType,
      limit: POSITIONS_PAGE_SIZE,
    }),
    queryFn: ({ pageParam }) =>
      getTradingAccountPositions(accountId, {
        assetType,
        limit: POSITIONS_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
    enabled: hasAccount,
  });

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(accountId, range),
    queryFn: () => getTradingAccountEquity(accountId, range),
    enabled: hasAccount && isPortfolioAvailable,
  });

  // A selected account the server no longer recognises as ours (unknown id, or
  // another user's) is not an error screen: refresh the owned list and let the
  // selection policy land somewhere valid (작업 9 §B-9).
  const missingAccount =
    overviewQuery.isError &&
    classifyAccountError(overviewQuery.error) === 'account_not_found';

  useEffect(() => {
    if (missingAccount) {
      void handleSelectedAccountMissing();
    }
  }, [missingAccount, handleSelectedAccountMissing]);

  const positions = useMemo(() => {
    const byAssetId = new Map<string, PortfolioPositionRow>();

    positionsQuery.data?.pages.forEach((page) => {
      page.positions.forEach((item) => {
        const display = getPositionDisplay(item);
        byAssetId.set(item.assetId, {
          positionId: item.positionId,
          assetId: item.assetId,
          symbol: item.symbol,
          name: item.name,
          quantity: display.quantity,
          averageCost: display.averageCost,
          currentPrice: display.currentPrice,
          positionValueKrw: display.positionValueKrw,
          unrealizedPnlKrw: display.unrealizedPnlKrw,
          returnRate: display.returnRate,
          priceNotice: display.priceNotice,
        });
      });
    });

    return Array.from(byAssetId.values());
  }, [positionsQuery.data]);

  const viewState = useMemo<PortfolioViewState>(() => {
    if (overviewQuery.isLoading) {
      return 'portfolio_loading';
    }

    if (overviewQuery.isError || !overviewQuery.data) {
      return 'portfolio_error';
    }

    if (positionsQuery.isSuccess && !positions.length) {
      return 'portfolio_no_positions';
    }

    if (
      positionsQuery.isError ||
      (isPortfolioAvailable && equityQuery.isError)
    ) {
      return 'portfolio_partial_unavailable';
    }

    return 'portfolio_ready';
  }, [
    overviewQuery.isLoading,
    overviewQuery.isError,
    overviewQuery.data,
    isPortfolioAvailable,
    positionsQuery.isError,
    positionsQuery.isSuccess,
    positions.length,
    equityQuery.isError,
  ]);

  if (accountsLoading || (hasAccount && viewState === 'portfolio_loading')) {
    return <FullPageLoading message="포트폴리오를 불러오는 중입니다." />;
  }

  // No accounts at all is an explicit empty state, not an error and not a
  // zero-value portfolio (작업 9 §B-2).
  if (noAccounts || !hasAccount) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <AccountSwitcher />
        </View>
      </SafeAreaView>
    );
  }

  // Structural integrity faults get their OWN state. Showing them as an empty
  // portfolio would hide server-detected data damage behind a calm screen
  // (작업 9 §B-9). Since 작업 12 §3 this covers the positions and equity queries
  // too: `portfolio_partial_unavailable` is the right answer for a price gap,
  // and the wrong one for a scope mismatch.
  const integrityFailure = findAccountIntegrityFailure([
    {
      section: '포트폴리오',
      isError: overviewQuery.isError,
      error: overviewQuery.error,
      retry: () => void overviewQuery.refetch(),
    },
    {
      section: '보유 종목',
      isError: positionsQuery.isError,
      error: positionsQuery.error,
      retry: () => void positionsQuery.refetch(),
    },
    {
      section: '자산 추이',
      isError: equityQuery.isError,
      error: equityQuery.error,
      retry: () => void equityQuery.refetch(),
    },
  ]);

  if (integrityFailure) {
    return (
      <SafeAreaView
        style={styles.container}
        testID={TEST_IDS.tradingAccount.integrityError}
      >
        <View style={styles.content}>
          <AccountSwitcher />
          <ErrorState
            title={ACCOUNT_INTEGRITY_TITLE}
            message={integrityFailure.message}
            onRetry={integrityFailure.retry}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (viewState === 'portfolio_error' || !overviewQuery.data) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <AccountSwitcher />
          <ErrorState
            title="포트폴리오를 불러오지 못했습니다."
            message="잠시 후 다시 시도해주세요."
            onRetry={() => void overviewQuery.refetch()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const overview = overviewQuery.data;
  const summary = overview.summary;
  /**
   * An expected capability limit, not a failure (작업 9 §B-7). The user is told
   * up front that general-mode trading and FX are 준비 중, instead of being
   * handed a live-looking button whose only outcome is a 409.
   */
  const capabilityNotice = capabilities?.canTrade
    ? null
    : getCapabilityBlockMessage(capabilities, capabilities?.tradeBlockReason);
  const portfolioNotice = getTradingAccountPortfolioNotice(overview);
  const equity = equityQuery.data?.points ?? [];
  const allocationSegments = getAllocationSegments(overview.allocation);
  const equityChartPoints = getEquityChartPoints(equity);

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.portfolio.screen}
        data={positions}
        keyExtractor={(item) => item.positionId}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (
            positionsQuery.hasNextPage &&
            !positionsQuery.isFetchingNextPage
          ) {
            void positionsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            <AccountSwitcher />

            <AccountSummaryCard summary={summary} />

            {capabilityNotice ? (
              <View
                style={styles.inlineNotice}
                testID={TEST_IDS.tradingAccount.capabilityNotice}
              >
                <Text style={styles.inlineNoticeText}>{capabilityNotice}</Text>
              </View>
            ) : null}

            {portfolioNotice ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  {portfolioNotice.title}
                </Text>
                <Text style={styles.helper}>{portfolioNotice.message}</Text>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.label}>자산 비중</Text>
              <DonutChart
                segments={allocationSegments}
                valueFormatter={formatKrwChartValue}
                emptyMessage="자산 비중 데이터가 없습니다."
              />
            </View>

            {viewState === 'portfolio_partial_unavailable' ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  일부 포트폴리오 정보를 불러오지 못했습니다.
                </Text>
              </View>
            ) : null}

            {isPortfolioAvailable ? (
              <View style={styles.card}>
                <Text style={styles.label}>자산 추이</Text>

                <View style={styles.row}>
                  {RANGE_TABS.map((tab) => {
                    const active = tab.key === range;
                    return (
                      <Pressable
                        key={tab.key}
                        testID={TEST_IDS.portfolio.equityRange(tab.key)}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => setRange(tab.key)}
                      >
                        <Text
                          style={
                            active ? styles.chipTextActive : styles.chipText
                          }
                        >
                          {tab.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {equityQuery.isLoading ? (
                  <SectionSkeleton lines={5} />
                ) : equityQuery.isError ? (
                  <View style={styles.sectionFallback}>
                    <InlineEmptyState
                      title="자산 추이를 불러오지 못했습니다."
                      message="잠시 후 다시 시도해주세요."
                    />
                    <CTAButton
                      label="자산 추이 다시 불러오기"
                      onPress={() => void equityQuery.refetch()}
                    />
                  </View>
                ) : equity.length ? (
                  <LineChart
                    points={equityChartPoints}
                    valueFormatter={formatKrwChartValue}
                    emptyMessage="자산 추이를 표시하려면 데이터가 더 필요합니다."
                  />
                ) : (
                  <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
                )}
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.label}>보유 포지션</Text>

              <View style={styles.row}>
                {POSITION_TABS.map((tab) => {
                  const active = tab.key === assetType;
                  return (
                    <Pressable
                      key={tab.key}
                      testID={TEST_IDS.portfolio.assetTab(tab.key)}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setAssetType(tab.key)}
                    >
                      <Text
                        style={active ? styles.chipTextActive : styles.chipText}
                      >
                        {tab.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          positionsQuery.isLoading ? (
            <SectionSkeleton lines={4} />
          ) : positionsQuery.isError ? (
            <View style={styles.sectionFallback}>
              <InlineEmptyState
                title="보유 포지션을 불러오지 못했습니다."
                message="잠시 후 다시 시도해주세요."
              />
              <CTAButton
                label="포지션 다시 불러오기"
                onPress={() => void positionsQuery.refetch()}
              />
            </View>
          ) : viewState === 'portfolio_no_positions' ? (
            <InlineEmptyState
              title="보유 포지션이 없습니다."
              message="해당 자산군의 보유 포지션이 없습니다."
            />
          ) : null
        }
        renderItem={({ item }) => {
          const nameDisplay = getAssetNameDisplay(item);
          return (
            <Pressable
              testID={TEST_IDS.portfolio.positionItem(item.assetId)}
              style={styles.positionRow}
              onPress={() =>
                rootNavigation.navigate('MainTabs', {
                  screen: 'MarketTab',
                  params: {
                    screen: 'AssetDetail',
                    params: { assetId: item.assetId },
                  },
                })
              }
            >
              <View>
                <Text style={styles.itemTitle}>{nameDisplay.primary}</Text>
                {nameDisplay.secondary ? (
                  <Text style={styles.helper}>{nameDisplay.secondary}</Text>
                ) : null}
                <Text style={styles.helper}>수량 {item.quantity}</Text>
                <Text style={styles.helper}>
                  평균 매입가 {item.averageCost}
                </Text>
              </View>

              <View style={styles.alignEnd}>
                <Text style={styles.itemTitle}>{item.positionValueKrw}</Text>
                <Text style={styles.helper}>
                  현재가 {item.currentPrice ?? '시세 조회 불가'}
                </Text>
                <Text style={styles.helper}>수익률 {item.returnRate}</Text>
                <Text style={styles.helper}>
                  평가손익 {item.unrealizedPnlKrw}
                </Text>
                {item.priceNotice ? (
                  <Text style={styles.inlineWarningText}>
                    {item.priceNotice}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
        ListFooterComponent={
          <View style={styles.footerActions}>
            {positionsQuery.isFetchingNextPage ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator />
              </View>
            ) : null}
            <CTAButton
              label="마켓으로 이동"
              onPress={() =>
                rootNavigation.navigate('MainTabs', {
                  screen: 'MarketTab',
                  params: { screen: 'Market' },
                })
              }
            />
            <CTAButton label="뒤로가기" onPress={() => navigation.goBack()} />
          </View>
        }
      />
    </SafeAreaView>
  );
}

/**
 * The summary card, split by what the numbers MEAN (작업 9 §B-6).
 *
 * A general account and a season account do not have "a return rate" in the
 * same sense, so they do not share a card:
 *
 *   - `time_weighted` excludes ad-funded external inflows from performance. The
 *     inflow is a deposit and is labelled as one; presenting it as profit is
 *     the exact misstatement the backend's TWR work exists to prevent.
 *   - `initial_capital` is the season's return against its starting capital,
 *     with no external-funding concept at all — which is why those fields come
 *     back `null` rather than 0 for a season account.
 *
 * The label comes from `summary.returnRateMethod` in the RESPONSE, not from the
 * selected account's mode: the two must agree, and if they ever disagree the
 * response is the fact.
 */
function AccountSummaryCard({
  summary,
}: {
  summary: TradingAccountPortfolioSummaryDto | null;
}) {
  if (!summary) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>총 자산</Text>
        <Text style={styles.big}>-</Text>
        {/* Deliberately NOT 0%: an unavailable performance figure is unknown,
            and 0% is a claim about it (작업 9 §B-6). */}
        <Text style={styles.helper}>수익률 정보를 준비 중입니다.</Text>
      </View>
    );
  }

  const isGeneral = summary.returnRateMethod === 'time_weighted';
  const returnRateLabel = getReturnRateMethodLabel(summary.returnRateMethod);

  return (
    <View
      style={styles.card}
      testID={
        isGeneral
          ? TEST_IDS.tradingAccount.generalSummary
          : TEST_IDS.tradingAccount.seasonSummary
      }
    >
      <Text style={styles.label}>총 자산</Text>
      <Text style={styles.big}>{formatKrw(summary.totalAssetKrw)}원</Text>
      <Text style={styles.helper}>
        {returnRateLabel} {formatPercent(summary.returnRate)}%
      </Text>

      {isGeneral ? (
        <>
          <Text style={styles.helper}>
            최초 지급 자본 {formatKrw(summary.initialFundingKrw)}
          </Text>
          <Text style={styles.helper}>
            누적 외부 유입 {formatKrw(summary.cumulativeExternalFundingKrw)}
          </Text>
          <Text style={styles.helper}>
            누적 광고 보상 {formatKrw(summary.cumulativeAdRewardKrw)}
          </Text>
          {/* Investment PnL is the ONLY figure here that is performance. */}
          <Text style={styles.helper}>
            투자 손익 {formatKrw(summary.investmentPnlKrw)}
          </Text>
          <Text style={styles.footnote}>
            광고 보상 등 외부 자금 유입은 투자 수익에 포함되지 않습니다.
          </Text>
        </>
      ) : null}

      <Text style={styles.helper}>KRW 현금 {formatKrw(summary.krwCash)}</Text>
      <Text style={styles.helper}>
        USD 환산 KRW {formatKrw(summary.usdCashKrw)}
      </Text>
      <Text style={styles.helper}>
        자산 평가 {formatKrw(summary.assetValueKrw)}
      </Text>
      <Text style={styles.helper}>
        실현손익 {formatKrw(summary.realizedPnlKrw)}
      </Text>
      <Text style={styles.helper}>
        평가손익 {formatKrw(summary.unrealizedPnlKrw)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  label: { fontSize: 13, color: '#666' },
  big: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  inlineWarning: {
    borderWidth: 1,
    borderColor: '#f2d4a8',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#fff8ed',
    marginBottom: 12,
  },
  inlineWarningText: { color: '#7a4b00', fontWeight: '600' },
  inlineNotice: {
    borderWidth: 1,
    borderColor: '#cfd8dc',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#eceff1',
    marginBottom: 12,
  },
  // Wraps freely: a capability explanation must stay fully readable at narrow
  // widths and enlarged font scales (작업 9 §B-3).
  inlineNoticeText: { color: '#37474f', fontSize: 13, lineHeight: 19 },
  footnote: { fontSize: 12, color: '#78909c', lineHeight: 17 },
  sectionFallback: { gap: 10 },
  chip: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  chipActive: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  chipText: { color: '#111', fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  positionRow: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  alignEnd: { alignItems: 'flex-end' },
  footerLoader: { paddingVertical: 16 },
  footerActions: { marginTop: 12, gap: 10 },
});
