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

import type { AssetDetailScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { getAssetDetail, getAssetCandles } from '../../features/asset/api';
import { getCurrentSeason } from '../../features/season/api';
import { useAssetTicker } from '../../features/asset/useAssetTicker';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { buildWsUrl } from '../../constants/env';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';

type Props = AssetDetailScreenProps;

export default function AssetDetailScreen({ route, navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const { assetId } = route.params;
  const assetTickerWsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });

  const candlesQuery = useQuery({
    queryKey: QUERY_KEYS.asset.candles(assetId, '1m'),
    queryFn: () => getAssetCandles(assetId, '1m'),
  });

  const { latestTicker, showReconnectBanner } = useAssetTicker({
    assetId,
    wsUrl: assetTickerWsUrl ?? '',
    enabled: !!assetTickerWsUrl,
  });

  const viewState = useMemo(() => {
    if (detailQuery.isLoading || seasonQuery.isLoading) return 'asset_loading';
    if (!detailQuery.data || !seasonQuery.data) return 'asset_error';

    const season = seasonQuery.data;
    const detail = detailQuery.data;
    const hasPosition = !!detail.position && Number(detail.position.quantity) > 0;

    if (season.status !== 'active' || !season.joined) return 'asset_season_blocked';
    if (detail.asset.marketStatus !== 'open') return 'asset_market_closed';
    if (detail.price.isStale) return 'asset_price_stale';
    if (!hasPosition) return 'asset_ready_not_holding';

    return 'asset_ready_tradable';
  }, [detailQuery.isLoading, seasonQuery.isLoading, detailQuery.data, seasonQuery.data]);

  if (viewState === 'asset_loading') {
    return <FullPageLoading message="종목 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'asset_error' || !detailQuery.data || !seasonQuery.data) {
    return (
      <ErrorState
        title="종목 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          detailQuery.refetch();
          seasonQuery.refetch();
        }}
      />
    );
  }

  const { asset, price, position } = detailQuery.data;
  const hasPosition = !!position && Number(position.quantity) > 0;

  const displayPriceLocal = latestTicker?.priceLocal ?? price.priceLocal;
  const displayPriceKrw = latestTicker?.priceKrw ?? price.priceKrw;
  const displayChangeRate = latestTicker?.changeRate ?? price.changeRate;

  if (viewState === 'asset_season_blocked') {
    return (
      <BlockedState
        title="현재 거래할 수 없습니다."
        message={
          seasonQuery.data.status === 'ended'
            ? '정산 중에는 거래할 수 없습니다.'
            : '시즌에 참가해야 거래할 수 있습니다.'
        }
        actionLabel={
          seasonQuery.data.status === 'active' && !seasonQuery.data.joined
            ? '시즌 참가하기'
            : undefined
        }
        onAction={
          seasonQuery.data.status === 'active' && !seasonQuery.data.joined
            ? () => rootNavigation.navigate('SeasonJoin')
            : undefined
        }
      />
    );
  }

  if (viewState === 'asset_market_closed') {
    return (
      <BlockedState
        title="장 마감으로 거래할 수 없습니다."
        message="현재가는 볼 수 있지만 매수/매도는 차단됩니다."
      />
    );
  }

  if (viewState === 'asset_price_stale') {
    return (
      <BlockedState
        title="가격 갱신 대기 중입니다."
        message="최신 가격을 확인할 수 없어 주문을 진행할 수 없습니다."
      />
    );
  }

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
            {displayPriceLocal} {price.priceCurrency}
          </Text>
          <Text style={styles.helper}>KRW 환산 {displayPriceKrw}</Text>
          <Text style={styles.helper}>등락률 {displayChangeRate}%</Text>
          <Text style={styles.helper}>시장 상태 {asset.marketStatus}</Text>

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
          {hasPosition ? (
            <>
              <Text style={styles.helper}>수량 {position.quantity}</Text>
              <Text style={styles.helper}>평균단가 {position.avgEntryPriceLocal}</Text>
              <Text style={styles.helper}>평가금액 {position.marketValueKrw}</Text>
              <Text style={styles.helper}>평가손익 {position.unrealizedPnlKrw}</Text>
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
            state="enabled"
            style={styles.flex}
            onPress={() => navigation.navigate('Order', { assetId, side: 'buy' })}
          />
          <CTAButton
            testID={TEST_IDS.assetDetail.sellButton}
            label="매도"
            state={hasPosition ? 'enabled' : 'blocked'}
            style={styles.flex}
            onPress={() => navigation.navigate('Order', { assetId, side: 'sell' })}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  row: { flexDirection: 'row', gap: 10 },
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
