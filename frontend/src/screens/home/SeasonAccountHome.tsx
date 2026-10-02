import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, useWindowDimensions, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getTradingAccountEquity,
  getTradingAccountPortfolio,
  getTradingAccountPositions,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { getCapabilityBlockMessage } from '../../features/tradingAccount/capabilities';
import type { TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getRankings, getRankingTier } from '../../features/ranking/api';
import { getMe } from '../../features/me/api';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import { getPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';

import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import HomeAssetTrend, { type HomeEquityRange } from './HomeAssetTrend';
import HomeAssetHero from './HomeAssetHero';
import ProfileAvatar from '../../components/common/ProfileAvatar';

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
  onOpenFx: () => void;
  onOpenReward: () => void;
  onOpenAsset: (assetId: string) => void;
};

const POSITIONS_PREVIEW_LIMIT = 5;

export default function SeasonAccountHome({
  account,
  capabilities,
  onOpenFx,
  onOpenReward,
  onOpenAsset,
}: Props) {
  const accountId = account.id;
  const [trendExpanded, setTrendExpanded] = useState(false);
  const [equityRange, setEquityRange] = useState<HomeEquityRange>('30d');
  const season = account.season;
  const { fontScale } = useWindowDimensions();

  // A settled season is ranked by its FINAL table; a running one by the daily
  // snapshot. Asking for the wrong one returns an empty ranking, which would
  // read as "you are unranked".
  const rankType = season?.seasonStatus === 'settled' ? 'final' : 'daily';
  const isSettled = season?.seasonStatus === 'settled';

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
    staleTime: 60_000,
  });

  const portfolioQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
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
  });

  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(
      accountId,
      equityRange,
      'daily',
    ),
    queryFn: () => getTradingAccountEquity(accountId, equityRange, 'daily'),
    enabled: trendExpanded,
  });

  /**
   * The leaderboard row for THIS account's season, named explicitly. `all&limit=1`
   * is requested for its `myRanking`; the surrounding rows are the ranking
   * tab's job, not Home's.
   */
  const rankingQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list({
      scope: 'all',
      seasonId: season?.seasonId ?? null,
      rankType,
      limit: 1,
      offset: 0,
    }),
    queryFn: () =>
      getRankings({
        scope: 'all',
        seasonId: season?.seasonId,
        rankType,
        limit: 1,
        offset: 0,
      }),
    enabled: !!season?.seasonId,
  });
  const refresh = usePullToRefresh([
    portfolioQuery,
    positionsQuery,
    meQuery,
    { ...equityQuery, enabled: trendExpanded },
    { ...rankingQuery, enabled: !!season?.seasonId },
  ]);

  // Fail closed on structural errors in every account-scoped section.
  const integrityFailure = findAccountIntegrityFailure([
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

  if (integrityFailure) {
    return (
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
    return <SectionSkeleton lines={6} />;
  }

  if (!portfolioQuery.data) {
    return (
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
  const positions = positionsQuery.data?.positions;
  const myRanking = rankingQuery.data?.myRanking.state === 'available'
    ? rankingQuery.data.myRanking
    : null;
  const rank = myRanking ? `#${myRanking.rank}` : '-';
  const tier = getRankingTier(myRanking, rankType);
  const tradeNotice = capabilities?.canTrade
    ? null
    : getCapabilityBlockMessage(capabilities, capabilities?.tradeBlockReason);

  return (
    <ScrollView
      refreshControl={refresh.refreshControl}
      testID={TEST_IDS.tradingAccount.seasonSummary}
      contentContainerStyle={styles.content}
    >
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

      <HomeAssetHero
        summary={summary}
        settled={isSettled}
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

      <View testID={TEST_IDS.home.competition} style={styles.card}>
        {meQuery.isLoading ? (
          <SectionSkeleton lines={1} />
        ) : !meQuery.data ? (
          <InlineEmptyState message="사용자 정보를 불러오지 못했습니다." />
        ) : (
          <View style={styles.identity}>
            <ProfileAvatar profileImageUrl={meQuery.data.profileImageUrl} size={36} testID="home-profile-avatar" />
            <Text testID={TEST_IDS.home.nickname} style={styles.nickname}>{meQuery.data.nickname}</Text>
          </View>
        )}
        <View style={styles.row}>
          <View style={[styles.flex, { flexBasis: 100 * fontScale }]}>
            <Text style={styles.label}>
              {isSettled ? '최종 순위' : '현재 순위'}
            </Text>
            {rankingQuery.isLoading ? (
              <SectionSkeleton lines={1} />
            ) : (
              <Text testID={TEST_IDS.home.rank} style={styles.medium}>{rank}</Text>
            )}
          </View>
          <View style={[styles.flex, { flexBasis: 100 * fontScale }]}>
            <Text style={styles.label}>
              {isSettled ? '최종 등급' : '현재 등급'}
            </Text>
            {rankingQuery.isLoading ? (
              <SectionSkeleton lines={1} />
            ) : (
              <Text testID={TEST_IDS.home.tier} style={styles.medium}>{tier}</Text>
            )}
          </View>
        </View>
      </View>

      {rankingQuery.isError && !rankingQuery.data ? (
        <InlineEmptyState message="랭킹 정보를 불러오지 못했습니다. 자산 정보는 위에 표시된 값이 최신입니다." />
      ) : null}

      <View testID="home-holdings" style={[styles.card, styles.holdingsCard]}>
        <Text accessibilityRole="header" style={styles.holdingsTitle}>보유 종목</Text>
        {positionsQuery.isLoading ? (
          <SectionSkeleton lines={3} />
        ) : positionsQuery.isError && !positionsQuery.data ? (
          <InlineEmptyState message="보유 종목을 불러오지 못했습니다." />
        ) : !positions ? (
          <InlineEmptyState message="보유 종목을 확인할 수 없습니다." />
        ) : positions.length === 0 ? (
          <InlineEmptyState
            title="보유 종목이 없습니다."
            message="아직 매수한 종목이 없습니다."
          />
        ) : (
          positions.map((position) => (
            <PositionAssetRow
              key={position.positionId}
              position={position}
              testID={TEST_IDS.home.positionItem(position.assetId)}
              onPress={() => onOpenAsset(position.assetId)}
            />
          ))
        )}
      </View>

      {capabilities?.canExchange ? (
        <CTAButton label="환전하기" onPress={onOpenFx} />
      ) : null}

      {isSettled ? (
        <CTAButton label="보상 확인" onPress={onOpenReward} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  // Each value can wrap within its track; narrow rows can stack the tracks.
  flex: { flexGrow: 1, minWidth: 0, gap: 4 },
  holdingsCard: { paddingVertical: 10, gap: 4 },
  holdingsTitle: { fontSize: 18, lineHeight: 27, fontWeight: '700', color: semantic.text },
  label: { fontSize: 13, color: semantic.secondary },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nickname: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', lineHeight: 23 },
  medium: { fontSize: 20, fontWeight: '700', lineHeight: 28 },
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
