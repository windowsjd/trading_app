import { semantic } from '../../theme/tokens';
import React from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from '../../theme/native';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getTradingAccountPortfolio,
  getTradingAccountEquity,
  getTradingAccountPositions,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { getCapabilityBlockMessage } from '../../features/tradingAccount/capabilities';
import type { TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import { getPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';
import { formatKrw } from '../../utils/format';

import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import HomePortfolioCharts from './HomePortfolioCharts';
import HomeAssetHero from './HomeAssetHero';

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
  capabilities: TradingAccountCapabilities | null;
  onOpenFx: () => void;
  onOpenAsset: (assetId: string) => void;
};

const POSITIONS_PREVIEW_LIMIT = 5;

/** Unknown is rendered as unknown. `0%` is a claim, and often a false one. */
function formatUnknownKrw(value: string | null | undefined) {
  if (value === null || value === undefined || value === '')
    return '알 수 없음';
  return formatKrw(value);
}

export default function GeneralAccountHome({
  account,
  capabilities,
  onOpenFx,
  onOpenAsset,
}: Props) {
  const accountId = account.id;

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
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(accountId, '30d', 'daily'),
    queryFn: () => getTradingAccountEquity(accountId, '30d', 'daily'),
  });

  // Fail closed on structural errors in every account-scoped section.
  const integrityFailure = findAccountIntegrityFailure([
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

  if (portfolioQuery.isError || !portfolioQuery.data) {
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
  const capabilityNotice = capabilities?.canExchange
    ? null
    : getCapabilityBlockMessage(
        capabilities,
        capabilities?.exchangeBlockReason,
      );

  return (
    <ScrollView
      testID={TEST_IDS.tradingAccount.generalSummary}
      contentContainerStyle={styles.content}
    >
      {/* Section-level gaps arrive INSIDE a success envelope and stay
          section-level notices — they are not the same thing as damage. */}
      {portfolioNotice ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>{portfolioNotice.title}</Text>
          <Text style={styles.warningText}>{portfolioNotice.message}</Text>
        </View>
      ) : null}

      <HomeAssetHero summary={summary} unavailableMessage={portfolioNotice?.message} />

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

      <HomePortfolioCharts
        portfolio={portfolio}
        equity={equityQuery.data}
        loading={equityQuery.isLoading}
        failed={equityQuery.isError}
        general
      />

      <View style={styles.card}>
        <Text style={styles.label}>보유 종목</Text>
        {positionsQuery.isLoading ? (
          <SectionSkeleton lines={3} />
        ) : positionsQuery.isError ? (
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

      {capabilityNotice ? (
        <View
          testID={TEST_IDS.tradingAccount.capabilityNotice}
          style={styles.noticeBox}
        >
          <Text style={styles.warningTitle}>환전 안내</Text>
          <Text style={styles.warningText}>{capabilityNotice}</Text>
        </View>
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
  label: { fontSize: 13, color: semantic.secondary },
  helper: { fontSize: 14, color: semantic.secondary, lineHeight: 21 },
  note: { fontSize: 13, color: semantic.warning, lineHeight: 19 },
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
