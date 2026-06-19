import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  ScrollView,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { OrderScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getAssetDetail } from '../../features/asset/api';
import { getCurrentSeason } from '../../features/season/api';
import { quoteOrder, createOrder } from '../../features/order/api';
import { getErrorMessageFromCode } from '../../services/api/errorMapper';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import OrderSuccessBottomSheet from './OrderSuccessBottomSheet';

type Props = OrderScreenProps;

function extractErrorCode(error: unknown): string | null {
  return (error as any)?.response?.data?.error?.code ?? null;
}

export default function OrderScreen({ route, navigation }: Props) {
  const { assetId, side = 'buy' } = route.params;
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();

  const [quantity, setQuantity] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<null | {
    symbol: string;
    side: 'buy' | 'sell';
    quantity: string;
    fillPriceLocal: string;
    fillCurrency: string;
    executedAt: string;
  }>(null);

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const assetQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });

  const quoteMutation = useMutation({
    mutationFn: quoteOrder,
    onSuccess: () => {
      setFieldError(null);
      setDomainError(null);
    },
    onError: (error) => {
      const code = extractErrorCode(error);
      setDomainError(getErrorMessageFromCode(code));
    },
  });

  const createMutation = useMutation({
    mutationFn: createOrder,
    onSuccess: async (result) => {
      setSuccessData({
        symbol: assetQuery.data?.asset.symbol ?? '',
        side,
        quantity: result.quantity,
        fillPriceLocal: result.fillPriceLocal,
        fillCurrency: result.fillCurrency,
        executedAt: result.executedAt,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.asset.detail(assetId) }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
      ]);
    },
    onError: (error) => {
      const code = extractErrorCode(error);
      setDomainError(
        getErrorMessageFromCode(code) ||
          '주문 가능 상태가 변경되어 다시 확인이 필요합니다.',
      );
    },
  });

  const inputInvalidReason = useMemo(() => {
    if (!quantity.trim()) return '수량을 입력해주세요.';
    if (Number.isNaN(Number(quantity))) return '숫자 형식을 확인해주세요.';
    if (Number(quantity) <= 0) return '0보다 큰 수량을 입력해주세요.';
    return null;
  }, [quantity]);

  const screenState = useMemo(() => {
    if (assetQuery.isLoading || seasonQuery.isLoading) return 'asset_loading';
    if (!assetQuery.data || !seasonQuery.data) return 'asset_error';

    const season = seasonQuery.data;
    const detail = assetQuery.data;

    if (season.status !== 'active' || !season.joined) return 'asset_season_blocked';
    if (detail.asset.marketStatus !== 'open') return 'asset_market_closed';
    if (detail.price.isStale) return 'asset_price_stale';

    return 'asset_ready';
  }, [assetQuery.isLoading, seasonQuery.isLoading, assetQuery.data, seasonQuery.data]);

  const orderState = useMemo(() => {
    if (inputInvalidReason) return 'order_input_invalid';
    if (quoteMutation.isPending) return 'order_quote_loading';
    if (createMutation.isPending) return 'order_submitting';
    if (successData) return 'order_success';
    if (quoteMutation.isError) return 'order_quote_rejected';
    if (createMutation.isError) return 'order_failed';
    if (quoteMutation.data) return 'order_quote_ready';
    return 'order_input_idle';
  }, [
    inputInvalidReason,
    quoteMutation.isPending,
    createMutation.isPending,
    successData,
    quoteMutation.isError,
    createMutation.isError,
    quoteMutation.data,
  ]);

  if (screenState === 'asset_loading') {
    return <FullPageLoading message="주문 화면을 준비하는 중입니다." />;
  }

  if (screenState === 'asset_error' || !assetQuery.data || !seasonQuery.data) {
    return (
      <ErrorState
        title="주문에 필요한 자산 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          assetQuery.refetch();
          seasonQuery.refetch();
        }}
      />
    );
  }

  if (screenState === 'asset_season_blocked') {
    return (
      <BlockedState
        title="현재 주문할 수 없습니다."
        message={
          seasonQuery.data.status === 'ended'
            ? '정산 중에는 거래할 수 없습니다.'
            : '시즌에 참가해야 거래할 수 있습니다.'
        }
      />
    );
  }

  if (screenState === 'asset_market_closed') {
    return (
      <BlockedState
        title="장 마감으로 주문할 수 없습니다."
        message="현재가는 볼 수 있지만 매수/매도는 차단됩니다."
      />
    );
  }

  if (screenState === 'asset_price_stale') {
    return (
      <BlockedState
        title="가격 갱신 대기 중입니다."
        message="최신 가격을 확인할 수 없어 주문을 진행할 수 없습니다."
      />
    );
  }

  const asset = assetQuery.data.asset;
  const detail = assetQuery.data;
  const position = detail.position;
  const quote = quoteMutation.data;
  const positionQuantity = position?.quantity ?? '0';

  const blockedSellReason =
    side === 'sell' && Number(positionQuantity) <= 0
      ? '보유 수량이 없어 매도할 수 없습니다.'
      : null;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.order.screen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{asset.symbol}</Text>
          <Text style={styles.helper}>{asset.name}</Text>
          <Text style={styles.helper}>주문 방향 {side === 'buy' ? '매수' : '매도'}</Text>
          <Text style={styles.helper}>현재가 {detail.price.priceLocal} {detail.price.priceCurrency}</Text>
          <Text style={styles.helper}>보유 수량 {positionQuantity}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>수량 입력</Text>

          <TextInput
            testID={TEST_IDS.order.quantityInput}
            style={styles.input}
            value={quantity}
            onChangeText={(value) => {
              setQuantity(value);
              setFieldError(null);
              setDomainError(null);
              setSuccessData(null);
            }}
            keyboardType="decimal-pad"
            placeholder="수량 입력"
          />

          {orderState === 'order_input_invalid' && inputInvalidReason ? (
            <Text style={styles.errorText}>{inputInvalidReason}</Text>
          ) : null}

          {blockedSellReason ? (
            <Text style={styles.errorText}>{blockedSellReason}</Text>
          ) : null}

          {fieldError ? <Text style={styles.errorText}>{fieldError}</Text> : null}
          {domainError ? <Text style={styles.errorText}>{domainError}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>주문 견적</Text>

          {orderState === 'order_quote_loading' ? (
            <SectionSkeleton lines={6} />
          ) : quote ? (
            <>
              <Text style={styles.helper}>예상 체결가 {quote.fillPriceLocal}</Text>
              <Text style={styles.helper}>수수료 {quote.feeAmountLocal}</Text>
              <Text style={styles.helper}>예상 순금액 {quote.netAmountLocal}</Text>
              <Text style={styles.helper}>주문 후 잔액 {quote.walletBalanceAfter}</Text>
              <Text style={styles.helper}>만료 시각 {quote.expiresAt}</Text>
            </>
          ) : (
            <Text style={styles.helper}>견적 확인 후 주문을 실행할 수 있습니다.</Text>
          )}
        </View>

        <View style={styles.row}>
          <CTAButton
            label="견적 확인"
            state={
              blockedSellReason
                ? 'blocked'
                : orderState === 'order_quote_loading'
                ? 'loading'
                : inputInvalidReason
                ? 'disabled'
                : 'enabled'
            }
            onPress={() => {
              if (blockedSellReason) {
                setDomainError(blockedSellReason);
                return;
              }

              if (inputInvalidReason) {
                setFieldError(inputInvalidReason);
                return;
              }

              setFieldError(null);
              setDomainError(null);

              quoteMutation.mutate({
                assetId,
                side,
                quantity,
              });
            }}
            style={styles.flex}
          />

          <CTAButton
            label="주문 실행"
            state={
              blockedSellReason
                ? 'blocked'
                : orderState === 'order_submitting'
                ? 'loading'
                : quote
                ? 'enabled'
                : 'disabled'
            }
            onPress={() => {
              if (blockedSellReason) {
                setDomainError(blockedSellReason);
                return;
              }

              if (!quote) {
                setDomainError('먼저 견적을 확인해주세요.');
                return;
              }

              setDomainError(null);

              createMutation.mutate({
                assetId,
                side,
                quantity,
              });
            }}
            style={styles.flex}
          />
        </View>
      </ScrollView>

      <OrderSuccessBottomSheet
        visible={!!successData}
        payload={successData}
        onClose={() => setSuccessData(null)}
        onGoAssetDetail={() => {
          setSuccessData(null);
          navigation.goBack();
        }}
        onGoHome={() => {
          setSuccessData(null);
          rootNavigation.reset({
            index: 0,
            routes: [
              {
                name: 'MainTabs',
                params: {
                  screen: 'HomeTab',
                  params: { screen: 'Home' },
                },
              },
            ],
          });
        }}
      />
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
    gap: 10,
  },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: '#666' },
  helper: { fontSize: 14, color: '#444' },
  errorText: { fontSize: 14, color: '#c62828' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#fff',
    fontSize: 16,
  },
});