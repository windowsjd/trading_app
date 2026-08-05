import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getTradingAccountPortfolio,
  getTradingAccountPositions,
  getTradingAccountWallets,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import { getReturnRateMethodLabel } from '../../features/tradingAccount/accountDisplay';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { CAPABILITY_BLOCK_MESSAGE } from '../../features/tradingAccount/capabilities';
import type { TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getWalletBalanceAmount } from '../../features/wallet/mapper';
import { formatKrw, formatPercent, getAssetNameDisplay } from '../../utils/format';

import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';

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
  onOpenLedger: () => void;
};

const POSITIONS_PREVIEW_LIMIT = 5;

/** Unknown is rendered as unknown. `0%` is a claim, and often a false one. */
function formatUnknownable(value: string | null | undefined, suffix = '') {
  if (value === null || value === undefined || value === '') return '알 수 없음';
  return `${value}${suffix}`;
}

export default function GeneralAccountHome({
  account,
  capabilities,
  onOpenLedger,
}: Props) {
  const accountId = account.id;

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

  /**
   * EVERY account-scoped query on this screen, not just the overview
   * (작업 12 §3).
   *
   * A scope mismatch on the wallet or positions query used to fall through to
   * "지갑 요약을 불러오지 못했습니다" / "보유 종목이 없습니다" — a grey box beside a
   * confident 총 자산 figure. The server refusing to vouch for part of an
   * account is not a partial outage of that part; it is a reason to stop
   * presenting the account as readable at all.
   */
  const integrityFailure = findAccountIntegrityFailure([
    {
      section: '총 자산',
      isError: portfolioQuery.isError,
      error: portfolioQuery.error,
      retry: () => void portfolioQuery.refetch(),
    },
    {
      section: '지갑',
      isError: walletsQuery.isError,
      error: walletsQuery.error,
      retry: () => void walletsQuery.refetch(),
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
  const positions = positionsQuery.data?.positions ?? [];
  const tradeNotice =
    capabilities && !capabilities.canTrade && capabilities.tradeBlockReason
      ? CAPABILITY_BLOCK_MESSAGE[capabilities.tradeBlockReason]
      : null;

  return (
    <ScrollView
      testID={TEST_IDS.tradingAccount.generalSummary}
      contentContainerStyle={styles.content}
    >
      {/* Section-level gaps arrive INSIDE a success envelope and stay
          section-level notices — they are not the same thing as damage. */}
      {portfolio.sectionErrors.length > 0 ? (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>일부 정보 지연</Text>
          <Text style={styles.warningText}>
            {portfolio.sectionErrors[0]?.message ??
              '일부 계정 정보를 불러오지 못했습니다.'}
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.label}>총 자산</Text>
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
          </>
        ) : (
          <InlineEmptyState
            title="수익률을 계산할 수 없습니다."
            message={
              portfolio.message ??
              '계정 성과 데이터가 아직 준비되지 않았습니다. 0%가 아니라 알 수 없는 상태입니다.'
            }
          />
        )}
      </View>

      {summary ? (
        <View style={styles.card}>
          <Text style={styles.label}>자금 구성</Text>
          <Text style={styles.helper}>
            최초 지급 자본 {formatUnknownable(summary.initialFundingKrw)}
          </Text>
          <Text style={styles.helper}>
            누적 외부 자금 유입{' '}
            {formatUnknownable(summary.cumulativeExternalFundingKrw)}
          </Text>
          <Text style={styles.helper}>
            누적 광고 보상 {formatUnknownable(summary.cumulativeAdRewardKrw)}
          </Text>
          <Text style={styles.helper}>
            투자 손익 {formatUnknownable(summary.investmentPnlKrw)}
          </Text>
          {/* Said plainly, because the distinction is the point of TWR. */}
          <Text style={styles.note}>
            외부 자금 유입(광고 보상 포함)은 투자 수익이 아닙니다. 위 수익률은
            유입 시점의 영향을 제외한 시간가중 수익률입니다.
          </Text>
        </View>
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
            <Pressable style={styles.retryButton} onPress={onOpenLedger}>
              <Text style={styles.retryText}>원장 보기</Text>
            </Pressable>
          </>
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
              <View key={position.assetId} style={styles.positionRow}>
                <Text style={styles.positionName}>{nameDisplay.primary}</Text>
                <Text style={styles.positionValue}>
                  {formatKrw(position.marketValueKrw)}
                </Text>
              </View>
            );
          })
        )}
      </View>

      {tradeNotice ? (
        <View
          testID={TEST_IDS.tradingAccount.capabilityNotice}
          style={styles.noticeBox}
        >
          <Text style={styles.warningTitle}>준비 중인 기능</Text>
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
  label: { fontSize: 13, color: '#666' },
  // Ten-plus digit amounts wrap instead of running off the screen.
  big: { fontSize: 26, fontWeight: '700', lineHeight: 34, flexShrink: 1 },
  helper: { fontSize: 14, color: '#444', lineHeight: 21 },
  note: { fontSize: 13, color: '#725400', lineHeight: 19 },
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
  // A long Korean asset name wraps; the amount keeps its own track and is
  // never pushed off the row.
  positionName: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20 },
  positionValue: { flexShrink: 0, fontSize: 14, fontWeight: '600' },
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
