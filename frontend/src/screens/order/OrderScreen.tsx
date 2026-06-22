import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  ScrollView,
  Pressable,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { OrderScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import {
  getAssetDetail,
  type AssetDetailPriceDto,
} from '../../features/asset/api';
import { getPositions, getPositionQuantity } from '../../features/position/api';
import { getCurrentSeason } from '../../features/season/api';
import { toSeasonDomainState } from '../../features/season/mapper';
import {
  quoteOrder,
  createOrder,
  type CreateOrderDto,
  type OrderQuoteDto,
} from '../../features/order/api';
import {
  getOrderQuoteDisplay,
  getOrderQuoteExpiresInSeconds,
  isOrderIdempotencyConflictCode,
  isOrderQuoteExpired,
  isOrderRequoteRequiredCode,
  isOrderSuccess,
} from '../../features/order/mapper';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { OrderFlowState } from '../../models/enums/viewState';
import {
  BLOCKED_REASON_MESSAGE,
  getApiErrorCode,
  getErrorMessageFromCode,
  mapOrderErrorCodeToBlockedReason,
} from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import OrderSuccessBottomSheet from './OrderSuccessBottomSheet';

type Props = OrderScreenProps;
type OrderDomainState = Extract<
  OrderFlowState,
  | 'order_quote_rejected'
  | 'order_requote_required'
  | 'order_idempotency_conflict'
  | 'order_failed'
>;

const QUOTE_EXPIRED_MESSAGE =
  '견적 유효 시간이 지났습니다. 다시 견적을 받아주세요.';
const REQUOTE_REQUIRED_MESSAGE =
  '가격 또는 환율이 변경되었습니다. 다시 견적을 받아주세요.';
const IDEMPOTENCY_CONFLICT_MESSAGE =
  '이미 다른 내용으로 처리 중인 요청입니다. 새 견적을 받아 다시 시도해주세요.';

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

function getOrderDomainErrorMessage(code?: string | null) {
  const blockedReason = mapOrderErrorCodeToBlockedReason(code);
  return blockedReason
    ? BLOCKED_REASON_MESSAGE[blockedReason]
    : getErrorMessageFromCode(code);
}

function validateQuantity(quantity: string) {
  const trimmed = quantity.trim();

  if (!trimmed) return '수량을 입력해주세요.';
  if (!/^(?:\d+|\d*\.\d{1,6})$/.test(trimmed)) {
    return '수량은 숫자와 소수점 이하 최대 6자리까지 입력할 수 있습니다.';
  }
  if (!Number.isFinite(Number(trimmed))) return '숫자 형식을 확인해주세요.';
  if (Number(trimmed) <= 0) return '0보다 큰 수량을 입력해주세요.';

  return null;
}

// TODO: Add ratio buttons after buy-side wallet sizing is available without guessing conversion.

export default function OrderScreen({ route, navigation }: Props) {
  const { assetId, side = 'buy' } = route.params;
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();

  const [quantity, setQuantity] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [quoteData, setQuoteData] = useState<OrderQuoteDto | null>(null);
  const [executeIdempotencyKey, setExecuteIdempotencyKey] = useState<
    string | null
  >(null);
  const [orderDomainState, setOrderDomainState] =
    useState<OrderDomainState | null>(null);
  const [successData, setSuccessData] = useState<CreateOrderDto | null>(null);
  const [quoteNow, setQuoteNow] = useState(() => Date.now());
  const latestQuoteInputRef = useRef({
    assetId,
    side,
    quantity: '',
  });

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const assetQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });

  const positionQuery = useQuery({
    queryKey: QUERY_KEYS.position.list({ assetId, limit: 20, offset: 0 }),
    queryFn: () => getPositions({ assetId, limit: 20, offset: 0 }),
  });

  useEffect(() => {
    latestQuoteInputRef.current = {
      assetId,
      side,
      quantity: quantity.trim(),
    };
  }, [assetId, side, quantity]);

  useEffect(() => {
    if (!quoteData) return undefined;

    setQuoteNow(Date.now());
    const intervalId = setInterval(() => {
      setQuoteNow(Date.now());
    }, 1000);

    return () => clearInterval(intervalId);
  }, [quoteData]);

  const quoteMutation = useMutation({
    mutationFn: quoteOrder,
    retry: false,
    onSuccess: (result, variables) => {
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.assetId !== latestInput.assetId ||
        variables.side !== latestInput.side ||
        variables.quantity !== latestInput.quantity
      ) {
        return;
      }

      setQuoteData(result);
      setExecuteIdempotencyKey(createIdempotencyKey('order'));
      setOrderDomainState(null);
      setFieldError(null);
      setDomainError(null);
      setSuccessData(null);
    },
    onError: (error, variables) => {
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.assetId !== latestInput.assetId ||
        variables.side !== latestInput.side ||
        variables.quantity !== latestInput.quantity
      ) {
        return;
      }

      const code = getApiErrorCode(error);

      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setOrderDomainState('order_quote_rejected');
      setDomainError(
        isOrderRequoteRequiredCode(code)
          ? REQUOTE_REQUIRED_MESSAGE
          : getOrderDomainErrorMessage(code),
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: createOrder,
    retry: false,
    onSuccess: async (result) => {
      if (!isOrderSuccess(result)) {
        setOrderDomainState('order_failed');
        setDomainError('주문 결과를 확인할 수 없습니다. 잠시 후 다시 확인해주세요.');
        return;
      }

      setSuccessData(result);
      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setOrderDomainState(null);
      setFieldError(null);
      setDomainError(null);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.asset.detail(assetId) }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.position.list({ assetId, limit: 20, offset: 0 }),
        }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.position.all }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ranking.all }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.portfolio.all }),
      ]);
    },
    onError: (error) => {
      const code = getApiErrorCode(error);

      if (isOrderRequoteRequiredCode(code)) {
        setQuoteData(null);
        setExecuteIdempotencyKey(null);
        setOrderDomainState('order_requote_required');
        setDomainError(
          code === ERROR_CODE.QUOTE_EXPIRED
            ? QUOTE_EXPIRED_MESSAGE
            : REQUOTE_REQUIRED_MESSAGE,
        );
        return;
      }

      if (isOrderIdempotencyConflictCode(code)) {
        setQuoteData(null);
        setExecuteIdempotencyKey(null);
        setOrderDomainState('order_idempotency_conflict');
        setDomainError(IDEMPOTENCY_CONFLICT_MESSAGE);
        return;
      }

      setOrderDomainState('order_failed');
      setDomainError(getOrderDomainErrorMessage(code));
    },
  });

  const resetOrderActionState = () => {
    setFieldError(null);
    setDomainError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setOrderDomainState(null);
    setSuccessData(null);
    quoteMutation.reset();
    createMutation.reset();
  };

  const inputInvalidReason = useMemo(
    () => validateQuantity(quantity),
    [quantity],
  );

  const quoteExpired = useMemo(
    () => (quoteData ? isOrderQuoteExpired(quoteData, quoteNow) : false),
    [quoteData, quoteNow],
  );

  const quoteExpiresInSeconds = useMemo(
    () =>
      quoteData ? getOrderQuoteExpiresInSeconds(quoteData, quoteNow) : 0,
    [quoteData, quoteNow],
  );

  const quoteDisplay = useMemo(
    () => (quoteData ? getOrderQuoteDisplay(quoteData) : null),
    [quoteData],
  );

  const asset = assetQuery.data?.asset;
  const price = asset?.price;
  const seasonState = seasonQuery.data
    ? toSeasonDomainState(seasonQuery.data)
    : null;
  const canTradeSeason = seasonState === 'season_active_joined';
  const positionQuantity = getPositionQuantity(positionQuery.data, assetId);

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
    asset && !asset.isActive
      ? '비활성 자산입니다.'
      : asset && !asset.tradable
      ? asset.tradeBlockedReason ?? '현재 거래할 수 없는 자산입니다.'
      : asset && !isOpenMarket(asset.marketStatus)
      ? '장 마감으로 주문할 수 없습니다.'
      : asset && !isPriceAvailable(price)
      ? '시세를 확인할 수 없어 주문할 수 없습니다.'
      : null;

  const sellBlockedReason =
    side === 'sell' && positionQuery.isLoading
      ? '보유 수량을 확인하는 중입니다.'
      : side === 'sell' && positionQuery.isError
      ? '보유 수량을 확인할 수 없어 매도할 수 없습니다.'
      : side === 'sell' && Number(positionQuantity) <= 0
      ? '보유 수량이 없어 매도할 수 없습니다.'
      : null;

  const preOrderBlockedReason =
    seasonBlockedReason ?? assetBlockedReason ?? sellBlockedReason;

  const viewState = useMemo<OrderFlowState>(() => {
    if (createMutation.isPending) return 'order_submitting';
    if (quoteMutation.isPending) return 'order_quote_loading';
    if (successData) return 'order_success';
    if (orderDomainState) return orderDomainState;
    if (quoteData && quoteExpired) return 'order_quote_expired';
    if (quoteData) return 'order_quote_ready';
    if (inputInvalidReason) {
      return quantity.trim() || fieldError
        ? 'order_input_invalid'
        : 'order_input_idle';
    }
    return 'order_input_idle';
  }, [
    createMutation.isPending,
    quoteMutation.isPending,
    successData,
    orderDomainState,
    quoteData,
    quoteExpired,
    inputInvalidReason,
    quantity,
    fieldError,
  ]);

  const canExecute =
    !preOrderBlockedReason &&
    !inputInvalidReason &&
    !!quoteData &&
    !quoteExpired &&
    !!executeIdempotencyKey &&
    orderDomainState !== 'order_requote_required' &&
    orderDomainState !== 'order_idempotency_conflict';

  const inputErrorMessage =
    fieldError ??
    (viewState === 'order_input_invalid' ? inputInvalidReason : null);

  const requestQuote = () => {
    if (preOrderBlockedReason) {
      setDomainError(preOrderBlockedReason);
      return;
    }

    if (inputInvalidReason) {
      setFieldError(inputInvalidReason);
      return;
    }

    setFieldError(null);
    setDomainError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setOrderDomainState(null);
    setSuccessData(null);
    createMutation.reset();

    quoteMutation.mutate({
      assetId,
      side,
      quantity: quantity.trim(),
    });
  };

  const executeQuote = () => {
    if (preOrderBlockedReason) {
      setDomainError(preOrderBlockedReason);
      return;
    }

    if (inputInvalidReason) {
      setFieldError(inputInvalidReason);
      return;
    }

    if (!quoteData) {
      setDomainError('먼저 견적을 확인해주세요.');
      return;
    }

    if (quoteExpired) {
      setDomainError(QUOTE_EXPIRED_MESSAGE);
      return;
    }

    if (!executeIdempotencyKey) {
      setOrderDomainState('order_failed');
      setDomainError(getErrorMessageFromCode(ERROR_CODE.IDEMPOTENCY_REQUIRED));
      return;
    }

    setFieldError(null);
    setDomainError(null);
    setOrderDomainState(null);

    createMutation.mutate({
      quoteId: quoteData.quoteId,
      assetId,
      side,
      quantity: quoteData.quantity,
      idempotencyKey: executeIdempotencyKey,
    });
  };

  if (assetQuery.isLoading) {
    return <FullPageLoading message="주문 화면을 준비하는 중입니다." />;
  }

  if (assetQuery.isError || !assetQuery.data || !asset) {
    return (
      <ErrorState
        title="주문에 필요한 자산 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => assetQuery.refetch()}
      />
    );
  }

  const isUsdSettlement = asset.settlementCurrency === 'USD';

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
          <Text style={styles.helper}>
            현재가 {displayValue(price?.currentPrice)} {asset.priceCurrency}
          </Text>
          <Text style={styles.helper}>보유 수량 {positionQuantity}</Text>
          <Text style={styles.helper}>
            가격 통화 {asset.priceCurrency} · 결제 통화 {asset.settlementCurrency}
          </Text>
          {isUsdSettlement ? (
            <Text style={styles.helper}>이 주문은 USD Wallet 잔액을 사용합니다.</Text>
          ) : null}
          <Text style={styles.helper}>시장 상태 {asset.marketStatus}</Text>
          <Text style={styles.helper}>
            거래 상태 {asset.tradable ? '거래 가능' : '거래 제한'}
          </Text>
          {asset.tradeBlockedReason ? (
            <Text style={styles.errorText}>{asset.tradeBlockedReason}</Text>
          ) : null}
          {preOrderBlockedReason ? (
            <Text style={styles.errorText}>{preOrderBlockedReason}</Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>수량 입력</Text>

          <TextInput
            testID={TEST_IDS.order.quantityInput}
            style={styles.input}
            value={quantity}
            onChangeText={(value) => {
              setQuantity(value);
              resetOrderActionState();
            }}
            keyboardType="decimal-pad"
            placeholder="수량 입력"
          />

          {inputErrorMessage ? (
            <Text style={styles.errorText}>{inputErrorMessage}</Text>
          ) : null}

          {domainError ? <Text style={styles.errorText}>{domainError}</Text> : null}

          {isUsdSettlement &&
          domainError &&
          domainError === getOrderDomainErrorMessage(ERROR_CODE.INSUFFICIENT_BALANCE) ? (
            <Pressable
              style={styles.retryButton}
              onPress={() =>
                rootNavigation.navigate('MainTabs', {
                  screen: 'HomeTab',
                  params: { screen: 'WalletFx' },
                })
              }
            >
              <Text style={styles.retryText}>USD 환전하러 가기</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>주문 견적</Text>

          {viewState === 'order_quote_loading' ? (
            <SectionSkeleton lines={7} />
          ) : quoteDisplay ? (
            <>
              <Text style={styles.helper}>견적 ID {quoteDisplay.quoteId}</Text>
              <Text style={styles.helper}>예상 체결가 {quoteDisplay.price}</Text>
              <Text style={styles.helper}>수량 {quoteDisplay.quantity}</Text>
              <Text style={styles.helper}>총 주문 금액 {quoteDisplay.grossAmount}</Text>
              <Text style={styles.helper}>수수료율 {quoteDisplay.feeRate}</Text>
              <Text style={styles.helper}>수수료 {quoteDisplay.feeAmount}</Text>
              <Text style={styles.helper}>예상 순금액 {quoteDisplay.netAmount}</Text>
              <Text style={styles.helper}>
                주문 전 잔액 {quoteDisplay.walletBalanceBefore}
              </Text>
              <Text style={styles.helper}>
                주문 후 예상 잔액 {quoteDisplay.estimatedWalletBalanceAfter}
              </Text>
              <Text style={styles.helper}>
                주문 전 포지션 {quoteDisplay.positionQuantityBefore}
              </Text>
              <Text style={styles.helper}>
                주문 후 예상 포지션 {quoteDisplay.estimatedPositionQuantityAfter}
              </Text>
              <Text style={styles.helper}>KRW 순금액 {quoteDisplay.krwNetAmount}</Text>
              <Text style={styles.helper}>만료 시각 {quoteDisplay.expiresAt}</Text>
              <Text style={styles.helper}>
                남은 시간 {quoteExpiresInSeconds}초
              </Text>
              <Text style={styles.helper}>
                허용 변동 {quoteDisplay.maxChangeBps}bps
              </Text>
              <Text style={styles.helper}>자산 가격 소스 {quoteDisplay.assetPriceSource}</Text>
              <Text style={styles.helper}>환율 소스 {quoteDisplay.fxRateSource}</Text>
              {quoteExpired ? (
                <Text style={styles.errorText}>{QUOTE_EXPIRED_MESSAGE}</Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.helper}>견적 확인 후 주문을 실행할 수 있습니다.</Text>
          )}

          {viewState === 'order_requote_required' ? (
            <Text style={styles.errorText}>{REQUOTE_REQUIRED_MESSAGE}</Text>
          ) : null}
          {viewState === 'order_idempotency_conflict' ? (
            <Text style={styles.errorText}>{IDEMPOTENCY_CONFLICT_MESSAGE}</Text>
          ) : null}
        </View>

        <View style={styles.row}>
          <CTAButton
            testID={TEST_IDS.order.quoteSubmit}
            label="견적 확인"
            state={
              viewState === 'order_quote_loading'
                ? 'loading'
                : preOrderBlockedReason || viewState === 'order_submitting'
                ? 'blocked'
                : inputInvalidReason
                ? 'disabled'
                : 'enabled'
            }
            onPress={requestQuote}
            style={styles.flex}
          />

          <CTAButton
            testID={TEST_IDS.order.executeSubmit}
            label="주문 실행"
            state={
              viewState === 'order_submitting'
                ? 'loading'
                : canExecute
                ? 'enabled'
                : 'disabled'
            }
            onPress={executeQuote}
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
