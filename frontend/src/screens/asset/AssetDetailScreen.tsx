import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Pressable,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { AssetDetailScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import {
  ASSET_CHART_RANGES,
  getAssetCandles,
  getAssetDetail,
  type AssetCandleRange,
  type AssetDetailPriceDto,
} from '../../features/asset/api';
import {
  getPositionForAsset,
  getPositions,
} from '../../features/position/api';
import { getCurrentSeason } from '../../features/season/api';
import { toSeasonDomainState } from '../../features/season/mapper';
import { useAssetTicker } from '../../features/asset/useAssetTicker';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { buildWsUrl } from '../../constants/env';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';

type Props = AssetDetailScreenProps;

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function isOpenMarket(status?: string | null) {
  return status?.toLowerCase() === 'open';
}

function isPriceAvailable(price?: AssetDetailPriceDto | null) {
  return price?.state === 'available' && !!price.currentPrice;
}

export default function AssetDetailScreen({ route, navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const { assetId } = route.params;
  const [selectedRange, setSelectedRange] =
    useState<AssetCandleRange>('1d');
  const assetTickerWsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });

  const positionQuery = useQuery({
    queryKey: QUERY_KEYS.position.list({ assetId, limit: 20, offset: 0 }),
    queryFn: () => getPositions({ assetId, limit: 20, offset: 0 }),
  });

  const candlesQuery = useQuery({
    queryKey: QUERY_KEYS.asset.candles(assetId, selectedRange),
    queryFn: () => getAssetCandles(assetId, { range: selectedRange, limit: 100 }),
  });

  const {
    connectionState,
    latestTicker,
    showReconnectBanner,
    isStale: isTickerStale,
  } = useAssetTicker({
    assetId,
    wsUrl: assetTickerWsUrl ?? '',
    enabled: !!assetTickerWsUrl,
  });

  if (detailQuery.isLoading) {
    return <FullPageLoading message="종목 정보를 불러오는 중입니다." />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ErrorState
        title="종목 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const { asset } = detailQuery.data;
  const price = asset.price;
  const position = getPositionForAsset(positionQuery.data, assetId);
  const hasPosition = Number(position?.quantity ?? '0') > 0;
  const seasonState = seasonQuery.data
    ? toSeasonDomainState(seasonQuery.data)
    : null;
  const canTradeSeason = seasonState === 'season_active_joined';
  const priceAvailable = isPriceAvailable(price);
  const livePriceAvailable = !!latestTicker?.priceLocal;
  const orderPriceAvailable = priceAvailable || livePriceAvailable;

  const displayPriceLocal =
    latestTicker?.priceLocal ??
    (priceAvailable ? price?.currentPrice : null);
  const displayPriceCurrency =
    latestTicker?.priceCurrency ?? asset.priceCurrency;
  const displayPriceKrw =
    latestTicker?.priceKrw ??
    (price?.priceKrwState === 'available' ? price?.priceKrw : null);
  const displayChangeRate = latestTicker?.changeRate ?? price?.changeRate;
  const displayCapturedAt =
    latestTicker?.priceCapturedAt ??
    latestTicker?.capturedAt ??
    price?.priceCapturedAt;
  const displayEffectiveAt =
    latestTicker?.priceEffectiveAt ?? price?.priceEffectiveAt;
  const displayFreshnessAgeSeconds = latestTicker?.freshnessAgeSeconds;

  const seasonBlockedReason =
    seasonQuery.isLoading
      ? '시즌 상태를 확인하는 중입니다.'
      : seasonQuery.isError || !seasonQuery.data
      ? '시즌 상태를 확인할 수 없어 주문을 잠시 막았습니다.'
      : seasonState === 'season_active_not_joined'
      ? '시즌에 참가해야 거래할 수 있습니다.'
      : seasonState === 'season_ended_unsettled'
      ? '정산 중에는 거래할 수 없습니다.'
      : !canTradeSeason
      ? '현재 거래 가능한 시즌이 아닙니다.'
      : null;

  const assetBlockedReason =
    !asset.isActive
      ? '비활성 자산입니다.'
      : !asset.tradable
      ? asset.tradeBlockedReason ?? '현재 거래할 수 없는 자산입니다.'
      : !isOpenMarket(asset.marketStatus)
      ? '장 마감으로 주문할 수 없습니다.'
      : isTickerStale
      ? '실시간 시세가 오래되어 주문할 수 없습니다.'
      : !orderPriceAvailable
      ? '시세를 확인할 수 없어 주문할 수 없습니다.'
      : null;

  const buyBlockedReason = seasonBlockedReason ?? assetBlockedReason;
  const sellBlockedReason =
    buyBlockedReason ??
    (positionQuery.isError
      ? '보유 수량을 확인할 수 없어 매도할 수 없습니다.'
      : !hasPosition
      ? '보유 수량이 없어 매도할 수 없습니다.'
      : null);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.assetDetail.screen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{asset.symbol}</Text>
          <Text style={styles.helper}>{asset.name}</Text>
          <Text style={styles.value}>
            {orderPriceAvailable
              ? `${displayValue(displayPriceLocal)} ${displayPriceCurrency}`
              : '시세 준비 중'}
          </Text>
          <Text style={styles.helper}>KRW 환산 {displayValue(displayPriceKrw)}</Text>
          <Text style={styles.helper}>등락률 {displayValue(displayChangeRate)}%</Text>
          <Text style={styles.helper}>시장 {asset.market}</Text>
          <Text style={styles.helper}>시장 상태 {asset.marketStatus}</Text>
          <Text style={styles.helper}>
            거래 상태 {asset.tradable ? '거래 가능' : '거래 제한'}
          </Text>
          <Text style={styles.helper}>
            가격 통화 {asset.priceCurrency} · 결제 통화 {asset.settlementCurrency}
          </Text>
          {asset.settlementCurrency === 'USD' ? (
            <Text style={styles.helper}>USD Wallet으로 결제됩니다.</Text>
          ) : null}
          <Text style={styles.helper}>가격 수집 {displayValue(displayCapturedAt)}</Text>
          <Text style={styles.helper}>
            가격 기준 {displayValue(displayEffectiveAt)}
          </Text>
          <Text style={styles.helper}>
            최신성 {displayValue(displayFreshnessAgeSeconds)}초
          </Text>
          <Text style={styles.helper}>실시간 연결 {connectionState}</Text>
          <Text style={styles.helper}>가격 소스 {displayValue(price?.priceSource)}</Text>

          {asset.tradeBlockedReason ? (
            <Text style={styles.errorText}>{asset.tradeBlockedReason}</Text>
          ) : null}
          {asset.tradingNote ? (
            <Text style={styles.helper}>{asset.tradingNote}</Text>
          ) : null}
          {buyBlockedReason ? (
            <View style={styles.inlineWarning}>
              <Text style={styles.inlineWarningText}>{buyBlockedReason}</Text>
              {seasonState === 'season_active_not_joined' ? (
                <Pressable
                  style={styles.retryButton}
                  onPress={() => rootNavigation.navigate('SeasonJoin')}
                >
                  <Text style={styles.retryText}>시즌 참가하기</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {isTickerStale ? (
            <View style={styles.inlineWarning}>
              <Text style={styles.inlineWarningText}>
                실시간 시세 최신성이 낮습니다. 최신 가격 확인 후 주문해주세요.
              </Text>
            </View>
          ) : null}

          {showReconnectBanner ? (
            <View testID={TEST_IDS.assetDetail.reconnectBanner} style={styles.banner}>
              <Text style={styles.bannerText}>
                실시간 연결이 불안정합니다. 마지막 성공 데이터를 표시 중입니다.
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>내 포지션</Text>
          {positionQuery.isLoading ? (
            <SectionSkeleton lines={4} />
          ) : positionQuery.isError ? (
            <>
              <InlineEmptyState
                title="포지션을 불러오지 못했습니다."
                message="자산 정보는 계속 볼 수 있습니다."
              />
              <Pressable
                style={styles.retryButton}
                onPress={() => positionQuery.refetch()}
              >
                <Text style={styles.retryText}>포지션 다시 시도</Text>
              </Pressable>
            </>
          ) : hasPosition && position ? (
            <>
              <Text style={styles.helper}>수량 {position.quantity}</Text>
              <Text style={styles.helper}>
                평균단가 {displayValue(position.avgEntryPriceLocal ?? position.avgEntryPrice)}
              </Text>
              <Text style={styles.helper}>
                평가금액 {displayValue(position.marketValueKrw)}
              </Text>
              <Text style={styles.helper}>
                평가손익 {displayValue(position.unrealizedPnlKrw)}
              </Text>
              <Text style={styles.helper}>수익률 {displayValue(position.returnRate)}%</Text>
            </>
          ) : (
            <InlineEmptyState
              title="보유 없음"
              message="아직 이 자산을 보유하고 있지 않습니다."
            />
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>차트</Text>
          <View style={styles.row}>
            {ASSET_CHART_RANGES.map((tab) => {
              const active = tab.range === selectedRange;
              return (
                <Pressable
                  key={tab.range}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setSelectedRange(tab.range)}
                >
                  <Text style={active ? styles.chipTextActive : styles.chipText}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {candlesQuery.isLoading ? (
            <SectionSkeleton lines={5} />
          ) : candlesQuery.isError ? (
            <>
              <SectionSkeleton lines={4} />
              <Pressable
                testID={TEST_IDS.assetDetail.chartRetry}
                style={styles.retryButton}
                onPress={() => candlesQuery.refetch()}
              >
                <Text style={styles.retryText}>차트 다시 시도</Text>
              </Pressable>
            </>
          ) : candlesQuery.data?.candles?.length ? (
            candlesQuery.data.candles.slice(0, 6).map((candle) => (
              <Text key={candle.time} style={styles.helper}>
                {candle.time} · {candle.close}
              </Text>
            ))
          ) : (
            <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
          )}
        </View>

        <View style={styles.row}>
          <CTAButton
            testID={TEST_IDS.assetDetail.buyButton}
            label="매수"
            state={buyBlockedReason ? 'blocked' : 'enabled'}
            style={styles.flex}
            onPress={() => navigation.navigate('Order', { assetId, side: 'buy' })}
          />
          <CTAButton
            testID={TEST_IDS.assetDetail.sellButton}
            label="매도"
            state={sellBlockedReason ? 'blocked' : 'enabled'}
            style={styles.flex}
            onPress={() => navigation.navigate('Order', { assetId, side: 'sell' })}
          />
        </View>

        {sellBlockedReason && !buyBlockedReason ? (
          <Text style={styles.errorText}>{sellBlockedReason}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  flex: { flex: 1 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  title: { fontSize: 24, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
  value: { fontSize: 20, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  errorText: { fontSize: 14, color: '#c62828' },
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
  inlineWarning: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#F2D48B',
    borderRadius: 10,
    padding: 10,
    backgroundColor: '#FFF8E1',
    gap: 8,
  },
  inlineWarningText: { color: '#725400', fontSize: 13 },
  banner: {
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#FFF3CD',
  },
  bannerText: {
    color: '#7A5D00',
    fontSize: 13,
  },
});
