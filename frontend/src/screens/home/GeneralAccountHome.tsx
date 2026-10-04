import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getTradingAccountPortfolio,
  getTradingAccountEquity,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { getPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';
import { formatKrw } from '../../utils/format';

import ErrorState from '../../components/states/ErrorState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import HomeAssetTrend, { type HomeEquityRange } from './HomeAssetTrend';
import HomeAssetHero from './HomeAssetHero';
import HomeHoldings, { useHomeHoldings } from './HomeHoldings';
import HomeHotMarket, { type HomeHotMarketData } from './HomeHotMarket';
import HomeAccountContext, { type HomeAccountContextData } from './HomeAccountContext';
import type { AssetType } from '../../features/market/api';

/**
 * Home for a GENERAL account (작업 10 §A-6).
 *
 * A general account has no season, no rank, no tier, and no reward — so this
 * view renders none of them. The season dashboard's "현재 진행 중인 시즌이
 * 없습니다" blocked screen is exactly wrong here: nothing is missing, the user
 * is simply looking at an account that was never about a season.
 *
 * The number at the top is a TIME-WEIGHTED return, and it is labelled from the
 * RESPONSE's `returnRateMethod` rather than from the account's mode. The two
 * must agree; if they ever disagree the response is the fact, and mislabelling
 * a TWR as an initial-capital return would misstate what the number measures.
 *
 * Ad-funded and other external inflows are shown as INFLOW, on their own lines,
 * with an explicit note that they are not investment profit. That separation is
 * the whole reason the backend computes TWR for this mode: money the user was
 * given is not money the user earned.
 */

type Props = {
  account: TradingAccountDto;
  onOpenAsset: (assetId: string) => void;
  onOpenMarket: (assetType: AssetType) => void;
  accountContext: HomeAccountContextData;
  hot: HomeHotMarketData;
};

/** Unknown is rendered as unknown. `0%` is a claim, and often a false one. */
function formatUnknownKrw(value: string | null | undefined) {
  if (value === null || value === undefined || value === '')
    return '알 수 없음';
  return formatKrw(value);
}

export default function GeneralAccountHome({
  account,
  onOpenAsset,
  onOpenMarket,
  accountContext,
  hot,
}: Props) {
  const accountId = account.id;
  const [trendExpanded, setTrendExpanded] = useState(false);
  const [equityRange, setEquityRange] = useState<HomeEquityRange>('30d');

  const portfolioQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
  });

  const holdings = useHomeHoldings(accountId);
  const positionsQuery = holdings.previewQuery;

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(accountId, equityRange, 'daily'),
    queryFn: () => getTradingAccountEquity(accountId, equityRange, 'daily'),
    enabled: trendExpanded,
  });
  const refresh = usePullToRefresh([
    portfolioQuery,
    positionsQuery,
    { ...holdings.fullQuery, enabled: holdings.expanded },
    ...accountContext.refreshQueries,
    hot.refreshQuery,
    { ...equityQuery, enabled: trendExpanded },
  ]);

  // Fail closed on structural errors in every account-scoped section.
  const integrityFailure = findAccountIntegrityFailure([
    { section: '전체 보유 종목', isError: holdings.fullQuery.isError, error: holdings.fullQuery.error, retry: () => void holdings.fullQuery.refetch() },
    {
      section: '자산 추이',
      isError: equityQuery.isError,
      error: equityQuery.error,
      retry: () => void equityQuery.refetch(),
    },
    {
      section: '총 자산',
      isError: portfolioQuery.isError,
      error: portfolioQuery.error,
      retry: () => void portfolioQuery.refetch(),
    },
    {
      section: '보유 종목',
      isError: positionsQuery.isError,
      error: positionsQuery.error,
      retry: () => void positionsQuery.refetch(),
    },
  ]);

  const withContext = (content: React.ReactNode) => (
    <ScrollView refreshControl={refresh.refreshControl} contentContainerStyle={styles.content}>
      <HomeAccountContext context={accountContext} />
      {content}
    </ScrollView>
  );

  if (integrityFailure) {
    return withContext(
      <View testID={TEST_IDS.tradingAccount.integrityError}>
        <ErrorState
          title={ACCOUNT_INTEGRITY_TITLE}
          message={integrityFailure.message}
          onRetry={integrityFailure.retry}
        />
      </View>
    );
  }

  if (portfolioQuery.isLoading) {
    return withContext(<SectionSkeleton lines={6} />);
  }

  if (!portfolioQuery.data) {
    return withContext(
      <ErrorState
        title="계정 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void portfolioQuery.refetch()}
      />
    );
  }

  const portfolio = portfolioQuery.data;
  const summary = portfolio.summary;
  const portfolioNotice = getPortfolioNotice(portfolio);

  return (
    <ScrollView
      refreshControl={refresh.refreshControl}
      testID={TEST_IDS.tradingAccount.generalSummary}
      contentContainerStyle={styles.content}
    >
      <HomeAccountContext context={accountContext} />
      {/* Section-level gaps arrive INSIDE a success envelope and stay
          section-level notices — they are not the same thing as damage. */}
      {portfolioNotice ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>{portfolioNotice.title}</Text>
          <Text style={styles.warningText}>{portfolioNotice.message}</Text>
        </View>
      ) : null}

      <View style={styles.assetOverview}>
        <HomeAssetHero compactBottom summary={summary} unavailableMessage={portfolioNotice?.message} />

        <HomeAssetTrend
          expanded={trendExpanded}
          onToggle={() => setTrendExpanded((value) => !value)}
          range={equityRange}
          onRangeChange={setEquityRange}
          equity={equityQuery.data}
          loading={equityQuery.isLoading}
          failed={equityQuery.isError}
          general
        />

        <HomeHoldings holdings={holdings} onOpenAsset={onOpenAsset} />
      </View>
      <HomeHotMarket hot={hot} onOpenAsset={onOpenAsset} onOpenMarket={onOpenMarket} />

      {summary ? (
        <View style={styles.card}>
          <Text style={styles.label}>자금 구성</Text>
          <Text style={styles.helper}>
            최초 지급 자본 {formatUnknownKrw(summary.initialFundingKrw)}
          </Text>
          <Text style={styles.helper}>
            누적 외부 자금 유입{' '}
            {formatUnknownKrw(summary.cumulativeExternalFundingKrw)}
          </Text>
          <Text style={styles.helper}>
            누적 광고 보상 {formatUnknownKrw(summary.cumulativeAdRewardKrw)}
          </Text>
          <Text style={styles.helper}>
            투자 손익 {formatUnknownKrw(summary.investmentPnlKrw)}
          </Text>
          {/* Said plainly, because the distinction is the point of TWR. */}
          <Text style={styles.note}>
            외부 자금 유입(광고 보상 포함)은 투자 수익이 아닙니다. 위 수익률은
            유입 시점의 영향을 제외한 시간가중 수익률입니다.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  assetOverview: { gap: 4, minWidth: 0 },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
  },
  label: { fontSize: 13, color: semantic.secondary },
  helper: { fontSize: 14, color: semantic.secondary, lineHeight: 21 },
  note: { fontSize: 13, color: semantic.warning, lineHeight: 19 },
  warningBox: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: semantic.warningSurface,
    gap: 4,
  },
  warningTitle: { fontSize: 14, fontWeight: '700', color: semantic.warning },
  warningText: { fontSize: 13, color: semantic.warning, lineHeight: 19 },
});
