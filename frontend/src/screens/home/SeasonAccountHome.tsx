import FuturesEntry from '../futures/FuturesEntry';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getTradingAccountEquity,
  getTradingAccountPortfolio,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { getCapabilityBlockMessage } from '../../features/tradingAccount/capabilities';
import type { TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { portfolioReadPolicy, portfolioFailureFacts } from '../../features/tradingAccount/portfolioReadPolicy';
import { usePortfolioFocusRecovery } from './usePortfolioFocusRecovery';
import { getPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';

import ErrorState from '../../components/states/ErrorState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import HomeAssetTrend, { type HomeEquityRange } from './HomeAssetTrend';
import HomeAssetHero from './HomeAssetHero';
import HomeHoldings, { useHomeHoldings } from './HomeHoldings';
import HomeHotMarket, { type HomeHotMarketData } from './HomeHotMarket';
import HomeAccountContext, { type HomeAccountContextData } from './HomeAccountContext';
import type { AssetType } from '../../features/market/api';

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
  onOpenReward: () => void;
  onOpenAsset: (assetId: string) => void;
  onOpenMarket: (assetType: AssetType) => void;
  accountContext: HomeAccountContextData;
  hot: HomeHotMarketData;
};

export default function SeasonAccountHome({
  account,
  capabilities,
  onOpenReward,
  onOpenAsset,
  onOpenMarket,
  accountContext,
  hot,
}: Props) {
  const accountId = account.id;
  const [trendExpanded, setTrendExpanded] = useState(false);
  const [equityRange, setEquityRange] = useState<HomeEquityRange>('30d');
  const season = account.season;
  const isSettled = season?.seasonStatus === 'settled';
  const rankingQuery = accountContext.rankingQuery;

  const portfolioQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
    ...portfolioReadPolicy,
  });

  usePortfolioFocusRecovery(accountId);
  const holdings = useHomeHoldings(accountId);
  const positionsQuery = holdings.previewQuery;

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(
      accountId,
      equityRange,
      'daily',
    ),
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
    {
      section: '자산 추이',
      isError: equityQuery.isError,
      error: equityQuery.error,
      retry: () => void equityQuery.refetch(),
    },
    {
      section: '순위',
      isError: rankingQuery.isError,
      error: rankingQuery.error,
      retry: () => void rankingQuery.refetch(),
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
          diagnosticError={integrityFailure.error}
          diagnosticRuntime={integrityFailure.error === portfolioQuery.error ? portfolioFailureFacts(portfolioQuery.error) : undefined}
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
        title="포트폴리오 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        diagnosticError={portfolioQuery.error}
        diagnosticRuntime={portfolioFailureFacts(portfolioQuery.error)}
        onRetry={() => void portfolioQuery.refetch()}
      />
    );
  }

  const portfolio = portfolioQuery.data;
  const summary = portfolio.summary;
  const portfolioNotice = getPortfolioNotice(portfolio);
  const tradeNotice = capabilities?.canTrade
    ? null
    : getCapabilityBlockMessage(capabilities, capabilities?.tradeBlockReason);

  return (
    <ScrollView
      refreshControl={refresh.refreshControl}
      testID={TEST_IDS.tradingAccount.seasonSummary}
      contentContainerStyle={styles.content}
    >
      <HomeAccountContext context={accountContext} />
      {portfolioNotice ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>{portfolioNotice.title}</Text>
          <Text style={styles.warningText}>{portfolioNotice.message}</Text>
        </View>
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

      <View style={styles.assetOverview}>
        <HomeAssetHero compactBottom
          summary={summary}
          finalResult={portfolio.finalResult}
          settled={isSettled || !!portfolio.finalResult}
          unavailableMessage={portfolioNotice?.message}
        />

        <HomeAssetTrend
          expanded={trendExpanded}
          onToggle={() => setTrendExpanded((value) => !value)}
          range={equityRange}
          onRangeChange={setEquityRange}
          equity={equityQuery.data}
          loading={equityQuery.isLoading}
          failed={equityQuery.isError}
          general={false}
        />

        <FuturesEntry accountId={account.id} />
        <HomeHoldings holdings={holdings} onOpenAsset={onOpenAsset} />
      </View>
      <HomeHotMarket hot={hot} onOpenAsset={onOpenAsset} onOpenMarket={onOpenMarket} />

      {isSettled ? (
        <CTAButton label="보상 확인" onPress={onOpenReward} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  assetOverview: { gap: 4, minWidth: 0 },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 12, paddingBottom: 24 },
  warningBox: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: semantic.warningSurface,
    gap: 4,
  },
  noticeBox: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: semantic.infoSurface,
    gap: 4,
  },
  warningTitle: { fontSize: 14, fontWeight: '700', color: semantic.warning },
  warningText: { fontSize: 13, color: semantic.warning, lineHeight: 19 },
});
