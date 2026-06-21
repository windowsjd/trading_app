import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Pressable,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { HomeScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import {
  getHomeDashboard,
  type HomeAllocationSectionDto,
  type HomeSummarySectionDto,
  type HomeWalletSummarySectionDto,
} from '../../features/home/api';
import {
  getHomeEquityPoints,
  getHomeRankingDisplay,
  getHomeTopPositions,
  getHomeViewState,
  isSectionAvailable,
  isSectionEmpty,
  isSectionUnavailable,
} from '../../features/home/mapper';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';

type Props = HomeScreenProps;
type CurrencyCode = 'KRW' | 'USD';

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function parseMoney(value?: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTotalAssetKrw(summary?: HomeSummarySectionDto | null) {
  if (!summary || !isSectionAvailable(summary)) return '-';
  if (summary.totalAssetKrw) return summary.totalAssetKrw;

  const parts = [
    parseMoney(summary.krwCash ?? null),
    parseMoney(summary.usdCashKrw ?? null),
    parseMoney(summary.assetValueKrw ?? null),
  ];

  if (parts.some((item) => item === null)) return '-';

  return String(parts.reduce((total, item) => total + (item ?? 0), 0));
}

function getWalletSummaryAmount(
  walletSummary: HomeWalletSummarySectionDto | null | undefined,
  currencyCode: CurrencyCode,
) {
  if (
    !walletSummary ||
    isSectionUnavailable(walletSummary) ||
    isSectionEmpty(walletSummary)
  ) {
    return '-';
  }

  const direct = walletSummary[currencyCode];
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') {
    return displayValue(direct.balanceAmount);
  }

  const wallet = walletSummary.wallets?.find(
    (item) => item.currencyCode === currencyCode,
  );

  return displayValue(wallet?.balanceAmount);
}

function getAllocationRows(section?: HomeAllocationSectionDto | null) {
  if (!section || isSectionUnavailable(section) || isSectionEmpty(section)) {
    return [];
  }

  const items = section.items ?? section.allocations ?? [];

  if (items.length > 0) {
    return items.map((item, index) => ({
      key: item.assetType ?? item.label ?? String(index),
      label: item.label ?? item.assetType ?? '기타',
      value: displayValue(item.marketValueKrw ?? item.valueKrw),
    }));
  }

  return [
    { key: 'cash', label: '현금', value: section.cashKrwValue },
    { key: 'domestic', label: '국내', value: section.domesticStockValueKrw },
    { key: 'us', label: '미국', value: section.usStockValueKrw },
    { key: 'crypto', label: '암호화폐', value: section.cryptoValueKrw },
  ]
    .filter((item) => item.value)
    .map((item) => ({ ...item, value: displayValue(item.value) }));
}

export default function HomeScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();

  const homeQuery = useQuery({
    queryKey: QUERY_KEYS.home.dashboard,
    queryFn: getHomeDashboard,
  });

  const home = homeQuery.data;

  const viewState = useMemo(
    () =>
      getHomeViewState(home, {
        isLoading: homeQuery.isLoading,
        isError: homeQuery.isError,
      }),
    [home, homeQuery.isLoading, homeQuery.isError],
  );

  const ranking = useMemo(
    () => getHomeRankingDisplay(home?.ranking),
    [home?.ranking],
  );
  const topPositions = useMemo(
    () => getHomeTopPositions(home?.topPositions),
    [home?.topPositions],
  );
  const equityPoints = useMemo(
    () => getHomeEquityPoints(home?.equityChart),
    [home?.equityChart],
  );
  const allocationRows = useMemo(
    () => getAllocationRows(home?.allocation),
    [home?.allocation],
  );

  const retryHome = () => {
    homeQuery.refetch();
  };

  if (viewState === 'home_loading') {
    return <FullPageLoading message="홈 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'home_error') {
    return (
      <ErrorState
        title="홈 정보를 불러오지 못했습니다."
        message="네트워크 또는 일시적 서버 오류일 수 있습니다."
        onRetry={retryHome}
      />
    );
  }

  if (viewState === 'home_no_current_season') {
    return (
      <BlockedState
        title="현재 진행 중인 시즌이 없습니다."
        message="시즌이 열리면 홈에서 참가와 거래 상태를 확인할 수 있습니다."
        actionLabel="다시 확인"
        onAction={retryHome}
      />
    );
  }

  if (viewState === 'home_active_not_joined') {
    return (
      <BlockedState
        title="아직 이번 시즌에 참가하지 않았습니다."
        message="시즌에 참가해야 포트폴리오, 수익률, 거래 기능을 사용할 수 있습니다."
        actionLabel="시즌 참가하기"
        onAction={() => rootNavigation.navigate('SeasonJoin')}
      />
    );
  }

  if (viewState === 'home_upcoming') {
    return (
      <BlockedState
        title="시즌 시작 전입니다."
        message="시즌 시작 전에는 거래와 환전이 비활성입니다."
        actionLabel="시즌 안내 보기"
        onAction={() => rootNavigation.navigate('SeasonJoin')}
      />
    );
  }

  if (viewState === 'home_ended_unsettled') {
    return (
      <BlockedState
        title="시즌 정산 중입니다."
        message="정산 중에는 거래와 환전이 차단됩니다."
      />
    );
  }

  if (viewState === 'home_settled_not_joined') {
    return (
      <BlockedState
        title="시즌이 종료되었습니다."
        message="참가 기록이 없어 최종 결과가 없습니다. 다음 시즌을 기다려주세요."
      />
    );
  }

  if (!home) return null;

  if (viewState === 'home_settled') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView
          testID={TEST_IDS.home.screen}
          contentContainerStyle={styles.content}
        >
          <View testID={TEST_IDS.home.summaryCard} style={styles.card}>
            <Text style={styles.label}>최종 결과</Text>
            {isSectionAvailable(home.summary) ? (
              <>
                <Text style={styles.big}>
                  {getTotalAssetKrw(home.summary)} KRW
                </Text>
                <Text style={styles.helper}>
                  수익률 {displayValue(home.summary?.returnRate)}%
                </Text>
                <Text style={styles.helper}>
                  실현 손익 {displayValue(home.summary?.realizedPnlKrw)}
                </Text>
                <Text style={styles.helper}>
                  평가 손익 {displayValue(home.summary?.unrealizedPnlKrw)}
                </Text>
              </>
            ) : (
              <InlineEmptyState message="최종 자산 정보를 집계 중입니다." />
            )}
          </View>

          <View style={styles.row}>
            <View style={[styles.card, styles.flex]}>
              <Text style={styles.label}>최종 순위</Text>
              <Text style={styles.medium}>
                {ranking.rank === '-' ? '-' : `#${ranking.rank}`}
              </Text>
            </View>
            <View style={[styles.card, styles.flex]}>
              <Text style={styles.label}>최종 등급</Text>
              <Text style={styles.medium}>{ranking.tier}</Text>
            </View>
          </View>

          <CTAButton
            label="보상 확인"
            onPress={() =>
              rootNavigation.navigate('MainTabs', {
                screen: 'MyTab',
                params: { screen: 'Reward' },
              })
            }
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.home.screen}
        contentContainerStyle={styles.content}
      >
        {viewState === 'home_partial_error' ? (
          <View style={styles.card}>
            <Text style={styles.label}>일부 정보 지연</Text>
            <Text style={styles.helper}>
              가능한 홈 정보만 먼저 표시합니다. 누락된 섹션은 다시 시도할 수 있습니다.
            </Text>
          </View>
        ) : null}

        <View testID={TEST_IDS.home.summaryCard} style={styles.card}>
          <Text style={styles.label}>총 자산</Text>
          {isSectionAvailable(home.summary) ? (
            <>
              <Text style={styles.big}>{getTotalAssetKrw(home.summary)} KRW</Text>
              <Text style={styles.helper}>
                수익률 {displayValue(home.summary?.returnRate)}%
              </Text>
              <Text style={styles.helper}>
                KRW 현금 {displayValue(home.summary?.krwCash ?? home.summary?.krwBalance)}
              </Text>
              <Text style={styles.helper}>
                USD 환산 {displayValue(home.summary?.usdCashKrw)}
              </Text>
              <Text style={styles.helper}>
                보유자산 {displayValue(home.summary?.assetValueKrw)}
              </Text>
            </>
          ) : (
            <>
              <SectionSkeleton lines={3} />
              <Pressable style={styles.retryButton} onPress={retryHome}>
                <Text style={styles.retryText}>요약 다시 시도</Text>
              </Pressable>
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>지갑 요약</Text>
          {isSectionAvailable(home.walletSummary) ? (
            <>
              <Text style={styles.helper}>
                KRW {getWalletSummaryAmount(home.walletSummary, 'KRW')}
              </Text>
              <Text style={styles.helper}>
                USD {getWalletSummaryAmount(home.walletSummary, 'USD')}
              </Text>
            </>
          ) : (
            <InlineEmptyState message="지갑 요약을 불러오는 중입니다." />
          )}
        </View>

        <View style={styles.row}>
          <View style={[styles.card, styles.flex]}>
            <Text style={styles.label}>순위</Text>
            {isSectionAvailable(home.ranking) ? (
              <Text style={styles.medium}>
                {ranking.rank === '-' ? '-' : `#${ranking.rank}`}
              </Text>
            ) : (
              <Text style={styles.medium}>-</Text>
            )}
          </View>
          <View style={[styles.card, styles.flex]}>
            <Text style={styles.label}>등급</Text>
            <Text style={styles.medium}>
              {isSectionAvailable(home.ranking) ? ranking.tier : '-'}
            </Text>
          </View>
        </View>

        {isSectionUnavailable(home.ranking) ? (
          <View style={styles.card}>
            <InlineEmptyState message="랭킹 정보가 아직 준비되지 않았습니다." />
            <Pressable style={styles.retryButton} onPress={retryHome}>
              <Text style={styles.retryText}>랭킹 다시 시도</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.label}>자산 배분</Text>
          {allocationRows.length > 0 ? (
            allocationRows.map((item) => (
              <Text key={item.key} style={styles.helper}>
                {item.label} {item.value}
              </Text>
            ))
          ) : (
            <>
              <InlineEmptyState message="자산 배분 정보를 표시할 수 없습니다." />
              {isSectionUnavailable(home.allocation) ? (
                <Pressable style={styles.retryButton} onPress={retryHome}>
                  <Text style={styles.retryText}>배분 다시 시도</Text>
                </Pressable>
              ) : null}
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>자산 추이</Text>
          {isSectionUnavailable(home.equityChart) ? (
            <>
              <SectionSkeleton lines={4} />
              <Pressable style={styles.retryButton} onPress={retryHome}>
                <Text style={styles.retryText}>차트 다시 시도</Text>
              </Pressable>
            </>
          ) : equityPoints.length > 0 ? (
            equityPoints.slice(0, 8).map((point, index) => (
              <Text
                key={point.time ?? point.timestamp ?? point.label ?? String(index)}
                style={styles.helper}
              >
                {displayValue(point.label ?? point.time ?? point.timestamp)} ·{' '}
                {displayValue(point.totalAssetKrw ?? point.equityKrw)}
              </Text>
            ))
          ) : (
            <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>보유 포지션</Text>
          {isSectionUnavailable(home.topPositions) ? (
            <>
              <InlineEmptyState message="보유 포지션 정보를 불러오지 못했습니다." />
              <Pressable style={styles.retryButton} onPress={retryHome}>
                <Text style={styles.retryText}>포지션 다시 시도</Text>
              </Pressable>
            </>
          ) : topPositions.length === 0 ? (
            <InlineEmptyState
              title="보유 포지션이 없습니다."
              message="현재는 현금 비중만 보유 중입니다."
            />
          ) : (
            topPositions.map((item, index) => {
              const assetId = item.assetId ?? null;
              const rowKey = assetId ?? item.symbol ?? String(index);

              return (
                <Pressable
                  key={rowKey}
                  testID={TEST_IDS.home.positionItem(rowKey)}
                  style={styles.itemRow}
                  onPress={
                    assetId
                      ? () =>
                          rootNavigation.navigate('MainTabs', {
                            screen: 'MarketTab',
                            params: {
                              screen: 'AssetDetail',
                              params: { assetId },
                            },
                          })
                      : undefined
                  }
                >
                  <View>
                    <Text style={styles.itemTitle}>
                      {displayValue(item.symbol)}
                    </Text>
                    <Text style={styles.helper}>
                      {displayValue(item.name ?? item.assetName ?? item.assetType)}
                    </Text>
                  </View>
                  <View style={styles.alignEnd}>
                    <Text style={styles.itemTitle}>
                      {displayValue(item.marketValueKrw)}
                    </Text>
                    <Text style={styles.helper}>
                      {displayValue(item.returnRate)}%
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>

        <View style={styles.row}>
          <CTAButton
            label="환전하기"
            onPress={() => navigation.navigate('WalletFx')}
            style={styles.flex}
          />
          <CTAButton
            label="포트폴리오"
            onPress={() => navigation.navigate('Portfolio')}
            style={styles.flex}
          />
        </View>

        <View style={styles.row}>
          <CTAButton
            label="마켓으로 이동"
            onPress={() =>
              rootNavigation.navigate('MainTabs', {
                screen: 'MarketTab',
                params: { screen: 'Market' },
              })
            }
            style={styles.flex}
          />
          <CTAButton
            label="랭킹 보기"
            onPress={() =>
              rootNavigation.navigate('MainTabs', {
                screen: 'RankingTab',
                params: { screen: 'Ranking' },
              })
            }
            style={styles.flex}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  label: { fontSize: 13, color: '#666' },
  big: { fontSize: 26, fontWeight: '700' },
  medium: { fontSize: 20, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingVertical: 10,
  },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  alignEnd: { alignItems: 'flex-end' },
  retryButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  retryText: { color: '#111', fontWeight: '600' },
});
