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
import { isTradableMarketStatus } from '../../features/asset/mapper';
import {
  quoteOrder,
  createOrder,
  type OrderQuoteDto,
} from '../../features/order/api';
import {
  captureOrderSuccess,
  clearOrderSuccess,
  EMPTY_ORDER_SUCCESS_STATE,
} from '../../features/order/successState';
import { getWallets, type WalletCurrency } from '../../features/wallet/api';
import {
  getWalletAvailableAmount,
  getWalletBalanceAmount,
  getWalletReservedAmount,
} from '../../features/wallet/mapper';
import {
  getOrderQuoteDisplay,
  getOrderQuoteExpiresInSeconds,
  isOrderIdempotencyConflictCode,
  isOrderQuoteExpired,
  isOrderRequoteRequiredCode,
  isOrderSuccess,
} from '../../features/order/mapper';
import { LIMIT_ORDER_ENABLED } from '../../constants/env';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { OrderFlowState } from '../../models/enums/viewState';
import {
  BLOCKED_REASON_MESSAGE,
  getApiErrorCode,
  getErrorMessageFromCode,
  mapOrderErrorCodeToBlockedReason,
} from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import {
  formatCurrency,
  formatMoney,
  getAssetNameDisplay,
} from '../../utils/format';

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
const BUY_FEE_BUFFER = 0.002;
const RATIO_BUTTONS = [0.25, 0.5, 0.75, 1] as const;

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
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

function validateLimitPrice(limitPrice: string) {
  const trimmed = limitPrice.trim();

  if (!trimmed) return '지정가 가격을 입력해주세요.';
  if (!/^(?:\d+|\d*\.\d{1,8})$/.test(trimmed)) {
    return '지정가는 숫자와 소수점 이하 최대 8자리까지 입력할 수 있습니다.';
  }
  if (!Number.isFinite(Number(trimmed))) return '숫자 형식을 확인해주세요.';
  if (Number(trimmed) <= 0) return '0보다 큰 지정가를 입력해주세요.';

  return null;
}

function parsePositiveDecimal(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatQuantityInput(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const roundedDown = Math.floor(value * 1_000_000) / 1_000_000;
  if (roundedDown <= 0) return null;

  return roundedDown.toFixed(6).replace(/\.?0+$/, '');
}

function isWalletCurrency(value?: string | null): value is WalletCurrency {
  return value === 'KRW' || value === 'USD';
}

function getRatioLabel(ratio: (typeof RATIO_BUTTONS)[number]) {
  return `${Math.round(ratio * 100)}%`;
}

export default function OrderScreen({ route, navigation }: Props) {
  const { assetId, side = 'buy' } = route.params;
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();

  const [quantity, setQuantity] = useState('');
  // Limit orders are buy-only in phase 1; the toggle is hidden entirely
  // unless the feature flag is on AND this is a buy screen.
  const showLimitToggle = LIMIT_ORDER_ENABLED && side === 'buy';
  const [orderTypeState, setOrderTypeState] = useState<'market' | 'limit'>(
    'market',
  );
  const orderType = showLimitToggle ? orderTypeState : 'market';
  const [limitPrice, setLimitPrice] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [quoteData, setQuoteData] = useState<OrderQuoteDto | null>(null);
  const [executeIdempotencyKey, setExecuteIdempotencyKey] = useState<
    string | null
  >(null);
  const [orderDomainState, setOrderDomainState] =
    useState<OrderDomainState | null>(null);
  const [successState, setSuccessState] = useState(EMPTY_ORDER_SUCCESS_STATE);
  // Create clears the active quote so stale inputs cannot be re-submitted,
  // while this immutable snapshot remains available to the success sheet.
  const successData = successState.data;
  const successQuoteData = successState.quote;
  const [quoteNow, setQuoteNow] = useState(() => Date.now());
  const latestQuoteInputRef = useRef({
    assetId,
    side,
    quantity: '',
    orderType: 'market' as 'market' | 'limit',
    limitPrice: '',
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

  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.wallet.balances,
    queryFn: getWallets,
    enabled: side === 'buy',
  });

  useEffect(() => {
    latestQuoteInputRef.current = {
      assetId,
      side,
      quantity: quantity.trim(),
      orderType,
      limitPrice: limitPrice.trim(),
    };
  }, [assetId, side, quantity, orderType, limitPrice]);

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
        variables.quantity !== latestInput.quantity ||
        (variables.orderType ?? 'market') !== latestInput.orderType ||
        (variables.limitPrice ?? '') !== latestInput.limitPrice
      ) {
        return;
      }

      setQuoteData(result);
      setExecuteIdempotencyKey(createIdempotencyKey('order'));
      setOrderDomainState(null);
      setFieldError(null);
      setDomainError(null);
      setSuccessState(clearOrderSuccess());
    },
    onError: (error, variables) => {
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.assetId !== latestInput.assetId ||
        variables.side !== latestInput.side ||
        variables.quantity !== latestInput.quantity ||
        (variables.orderType ?? 'market') !== latestInput.orderType ||
        (variables.limitPrice ?? '') !== latestInput.limitPrice
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
        setDomainError(
          '주문 결과를 확인할 수 없습니다. 잠시 후 다시 확인해주세요.',
        );
        return;
      }

      setSuccessState(captureOrderSuccess(result, quoteData));
      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setOrderDomainState(null);
      setFieldError(null);
      setDomainError(null);

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.asset.detail(assetId),
        }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.position.list({ assetId, limit: 20, offset: 0 }),
        }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.position.all }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.wallet.transactionsAll,
        }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ranking.all }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.portfolio.all }),
        // Order history lists must show the new submitted limit order.
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.record.all }),
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
    setSuccessState(clearOrderSuccess());
    quoteMutation.reset();
    createMutation.reset();
  };

  const limitPriceInvalidReason = useMemo(
    () => (orderType === 'limit' ? validateLimitPrice(limitPrice) : null),
    [orderType, limitPrice],
  );

  const inputInvalidReason = useMemo(
    () => validateQuantity(quantity) ?? limitPriceInvalidReason,
    [quantity, limitPriceInvalidReason],
  );

  const quoteExpired = useMemo(
    () => (quoteData ? isOrderQuoteExpired(quoteData, quoteNow) : false),
    [quoteData, quoteNow],
  );

  const quoteExpiresInSeconds = useMemo(
    () => (quoteData ? getOrderQuoteExpiresInSeconds(quoteData, quoteNow) : 0),
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

  const seasonBlockedReason = seasonQuery.isLoading
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

  const assetHardBlockedReason =
    asset && !asset.isActive ? '비활성 자산입니다.' : null;

  const assetWarningReason =
    asset && !asset.tradable
      ? (asset.tradeBlockedReason ??
        '거래 제한 가능성이 있습니다. 서버 견적에서 최종 확인됩니다.')
      : asset && !isTradableMarketStatus(asset.marketStatus)
        ? '장 상태는 서버 견적에서 최종 확인됩니다.'
        : asset && !isPriceAvailable(price)
          ? '현재 화면 시세가 없어 비율 수량 계산은 제한됩니다. 견적은 서버가 최종 판정합니다.'
          : asset && price?.priceKrwState && price.priceKrwState !== 'available'
            ? 'KRW 환산 시세를 사용할 수 없습니다. 견적은 서버가 최종 판정합니다.'
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
    seasonBlockedReason ?? assetHardBlockedReason ?? sellBlockedReason;

  const settlementCurrency = isWalletCurrency(asset?.settlementCurrency)
    ? asset.settlementCurrency
    : null;
  const buyBalance =
    side === 'buy' && settlementCurrency
      ? getWalletBalanceAmount(walletsQuery.data, settlementCurrency)
      : null;
  const buyReserved =
    side === 'buy' && settlementCurrency
      ? getWalletReservedAmount(walletsQuery.data, settlementCurrency)
      : null;
  // Ratio buttons and spendable-cash checks use the AVAILABLE balance
  // (balance - reserved): cash locked by open limit orders is not spendable.
  const buyAvailable =
    side === 'buy' && settlementCurrency
      ? getWalletAvailableAmount(walletsQuery.data, settlementCurrency)
      : null;
  const buyAvailableValue = parsePositiveDecimal(buyAvailable);
  const priceValue = parsePositiveDecimal(price?.currentPrice);
  const limitPriceValue = parsePositiveDecimal(limitPrice);
  const ratioPriceValue = orderType === 'limit' ? limitPriceValue : priceValue;
  const positionQuantityValue = parsePositiveDecimal(positionQuantity);

  const ratioDisabledReason = useMemo(() => {
    if (preOrderBlockedReason) return preOrderBlockedReason;

    if (side === 'sell') {
      if (positionQuery.isLoading) return '보유 수량을 확인하는 중입니다.';
      if (positionQuery.isError) return '보유 수량을 확인할 수 없습니다.';
      if (!positionQuantityValue) return '보유 수량이 없습니다.';
      return null;
    }

    if (!settlementCurrency) return '결제 통화를 확인할 수 없습니다.';
    if (walletsQuery.isLoading) return '지갑 잔액을 확인하는 중입니다.';
    if (walletsQuery.isError || !walletsQuery.data) {
      return '지갑 잔액을 확인할 수 없습니다.';
    }
    if (!buyAvailableValue) {
      return `${settlementCurrency} 사용 가능 잔액이 없습니다.`;
    }
    if (!ratioPriceValue) {
      return orderType === 'limit'
        ? '지정가를 입력하면 비율 수량을 계산할 수 있습니다.'
        : '현재가가 없어 비율 수량을 계산할 수 없습니다.';
    }

    return null;
  }, [
    buyAvailableValue,
    orderType,
    preOrderBlockedReason,
    positionQuery.isError,
    positionQuery.isLoading,
    positionQuantityValue,
    ratioPriceValue,
    settlementCurrency,
    side,
    walletsQuery.data,
    walletsQuery.isError,
    walletsQuery.isLoading,
  ]);

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
    setSuccessState(clearOrderSuccess());
    createMutation.reset();

    quoteMutation.mutate({
      assetId,
      side,
      quantity: quantity.trim(),
      ...(orderType === 'limit'
        ? { orderType: 'limit' as const, limitPrice: limitPrice.trim() }
        : {}),
    });
  };

  const applyQuantityRatio = (ratio: (typeof RATIO_BUTTONS)[number]) => {
    if (ratioDisabledReason) {
      setFieldError(ratioDisabledReason);
      return;
    }

    const nextQuantity =
      side === 'sell'
        ? formatQuantityInput((positionQuantityValue ?? 0) * ratio)
        : formatQuantityInput(
            ((buyAvailableValue ?? 0) * ratio) /
              ((ratioPriceValue ?? 0) * (1 + BUY_FEE_BUFFER)),
          );

    if (!nextQuantity) {
      setFieldError('계산된 수량이 너무 작습니다.');
      return;
    }

    setQuantity(nextQuantity);
    resetOrderActionState();
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
      ...(orderType === 'limit'
        ? {
            orderType: 'limit' as const,
            // Server-quoted canonical limit price wins over the raw input.
            limitPrice: quoteData.limitPrice ?? limitPrice.trim(),
          }
        : {}),
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
  const assetNameDisplay = getAssetNameDisplay(asset);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.order.screen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{assetNameDisplay.primary}</Text>
          {assetNameDisplay.secondary ? (
            <Text style={styles.helper}>{assetNameDisplay.secondary}</Text>
          ) : null}
          <Text style={styles.helper}>
            주문 방향 {side === 'buy' ? '매수' : '매도'}
          </Text>
          <Text style={styles.helper}>
            현재가 {formatMoney(price?.currentPrice, asset.priceCurrency)}
          </Text>
          <Text style={styles.helper}>보유 수량 {positionQuantity}</Text>
          <Text style={styles.helper}>
            가격 통화 {asset.priceCurrency} · 결제 통화{' '}
            {asset.settlementCurrency}
          </Text>
          {isUsdSettlement ? (
            <Text style={styles.helper}>
              이 주문은 USD Wallet 잔액을 사용합니다.
            </Text>
          ) : null}
          <Text style={styles.helper}>시장 상태 {asset.marketStatus}</Text>
          <Text style={styles.helper}>
            거래 상태 {asset.tradable ? '거래 가능' : '거래 제한'}
          </Text>
          {preOrderBlockedReason ? (
            <Text style={styles.errorText}>{preOrderBlockedReason}</Text>
          ) : null}
          {assetWarningReason ? (
            <Text style={styles.warningText}>{assetWarningReason}</Text>
          ) : null}
          {side === 'buy' && settlementCurrency ? (
            <>
              <Text style={styles.helper}>
                전체 현금 {settlementCurrency}{' '}
                {formatCurrency(buyBalance, settlementCurrency)}
              </Text>
              <Text style={styles.helper}>
                기존 예약금 {settlementCurrency}{' '}
                {formatCurrency(buyReserved, settlementCurrency)}
              </Text>
              <Text style={styles.helper}>
                사용 가능 현금 {settlementCurrency}{' '}
                {formatCurrency(buyAvailable, settlementCurrency)}
              </Text>
            </>
          ) : null}
        </View>

        {showLimitToggle ? (
          <View style={styles.card}>
            <Text style={styles.label}>주문 방식</Text>
            <View style={styles.ratioRow}>
              <Pressable
                testID={TEST_IDS.order.typeToggleMarket}
                style={[
                  styles.ratioButton,
                  orderType === 'market' && styles.typeButtonActive,
                ]}
                onPress={() => {
                  if (orderType === 'market') return;
                  setOrderTypeState('market');
                  resetOrderActionState();
                }}
              >
                <Text
                  style={[
                    styles.ratioButtonText,
                    orderType === 'market' && styles.typeButtonTextActive,
                  ]}
                >
                  시장가
                </Text>
              </Pressable>
              <Pressable
                testID={TEST_IDS.order.typeToggleLimit}
                style={[
                  styles.ratioButton,
                  orderType === 'limit' && styles.typeButtonActive,
                ]}
                onPress={() => {
                  if (orderType === 'limit') return;
                  setOrderTypeState('limit');
                  resetOrderActionState();
                }}
              >
                <Text
                  style={[
                    styles.ratioButtonText,
                    orderType === 'limit' && styles.typeButtonTextActive,
                  ]}
                >
                  지정가
                </Text>
              </Pressable>
            </View>
            {orderType === 'limit' ? (
              <>
                <Text style={styles.label}>지정가 가격</Text>
                <TextInput
                  testID={TEST_IDS.order.limitPriceInput}
                  style={styles.input}
                  value={limitPrice}
                  onChangeText={(value) => {
                    setLimitPrice(value);
                    resetOrderActionState();
                  }}
                  keyboardType="decimal-pad"
                  placeholder="지정가 가격 입력"
                />
                <Text style={styles.helper}>
                  지정가 매수 주문은 제출 시 미체결 상태로 등록되며, 주문 금액과
                  수수료만큼 현금이 예약됩니다.
                </Text>
              </>
            ) : null}
          </View>
        ) : null}

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

          <View style={styles.ratioRow}>
            {RATIO_BUTTONS.map((ratio) => {
              const disabled = !!ratioDisabledReason;

              return (
                <Pressable
                  key={ratio}
                  style={[
                    styles.ratioButton,
                    disabled && styles.ratioButtonDisabled,
                  ]}
                  disabled={disabled}
                  onPress={() => applyQuantityRatio(ratio)}
                >
                  <Text
                    style={[
                      styles.ratioButtonText,
                      disabled && styles.ratioButtonTextDisabled,
                    ]}
                  >
                    {getRatioLabel(ratio)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.helper}>
            {ratioDisabledReason
              ? `비율 입력 제한: ${ratioDisabledReason}`
              : '비율 버튼은 수량 입력 보조이며 서버 견적이 최종 판정합니다.'}
          </Text>

          {inputErrorMessage ? (
            <Text style={styles.errorText}>{inputErrorMessage}</Text>
          ) : null}

          {domainError ? (
            <Text style={styles.errorText}>{domainError}</Text>
          ) : null}

          {isUsdSettlement &&
          domainError &&
          domainError ===
            getOrderDomainErrorMessage(ERROR_CODE.INSUFFICIENT_BALANCE) ? (
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
              {quoteData?.orderType === 'limit' ? (
                <>
                  <Text style={styles.helper}>
                    지정가{' '}
                    {formatCurrency(
                      quoteData.limitPrice,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    수량 {quoteDisplay.quantity}
                  </Text>
                  <Text style={styles.helper}>
                    예상 주문금액{' '}
                    {formatCurrency(
                      quoteData.quotedGrossAmount ?? quoteData.grossAmount,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    예상 수수료{' '}
                    {formatCurrency(
                      quoteData.quotedFeeAmount ?? quoteData.feeAmount,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    예약 예정 금액{' '}
                    {formatCurrency(
                      quoteData.quotedReservedAmount ??
                        quoteData.reservedAmount,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    기존 예약금{' '}
                    {formatCurrency(
                      quoteData.walletReservedBefore,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    사용 가능 현금{' '}
                    {formatCurrency(
                      quoteData.walletAvailableBefore,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    주문 후 예상 사용 가능 현금{' '}
                    {formatCurrency(
                      quoteData.estimatedAvailableAfter,
                      quoteData.currencyCode,
                    )}
                  </Text>
                  <Text style={styles.helper}>
                    {quoteData.executionPolicy?.autoExecutionEnabled
                      ? '유효한 실시간 체결가격이 지정가 이하로 처리되면 전량 자동 체결됩니다. 주문장 유동성과 거래량은 반영하지 않습니다.'
                      : '현재 단계에서는 미체결 상태로 등록됩니다.'}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.helper}>
                    예상 체결가 {quoteDisplay.price}
                  </Text>
                  <Text style={styles.helper}>
                    수량 {quoteDisplay.quantity}
                  </Text>
                  <Text style={styles.helper}>
                    총 주문 금액 {quoteDisplay.grossAmount}
                  </Text>
                  <Text style={styles.helper}>
                    수수료율 {quoteDisplay.feeRate}
                  </Text>
                  <Text style={styles.helper}>
                    수수료 {quoteDisplay.feeAmount}
                  </Text>
                  <Text style={styles.helper}>
                    예상 순금액 {quoteDisplay.netAmount}
                  </Text>
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
                    주문 후 예상 포지션{' '}
                    {quoteDisplay.estimatedPositionQuantityAfter}
                  </Text>
                  <Text style={styles.helper}>
                    KRW 순금액 {quoteDisplay.krwNetAmount}
                  </Text>
                  <Text style={styles.helper}>
                    허용 변동 {quoteDisplay.maxChangeBps}bps
                  </Text>
                  <Text style={styles.helper}>
                    자산 가격 소스 {quoteDisplay.assetPriceSource}
                  </Text>
                </>
              )}
              <Text style={styles.helper}>
                만료 시각 {quoteDisplay.expiresAt}
              </Text>
              <Text style={styles.helper}>
                남은 시간 {quoteExpiresInSeconds}초
              </Text>
              <Text style={styles.helper}>
                환율 소스 {quoteDisplay.fxRateSource}
              </Text>
              {quoteExpired ? (
                <Text style={styles.errorText}>{QUOTE_EXPIRED_MESSAGE}</Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.helper}>
              견적 확인 후 주문을 실행할 수 있습니다.
            </Text>
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
        // Supplies the quote-time estimates for an unfilled limit buy; the
        // order row itself carries no gross/fee/net until it fills.
        quote={successQuoteData}
        onClose={() => {
          setSuccessState(clearOrderSuccess());
        }}
        onGoAssetDetail={() => {
          setSuccessState(clearOrderSuccess());
          navigation.goBack();
        }}
        onGoOrderHistory={() => {
          setSuccessState(clearOrderSuccess());
          rootNavigation.navigate('MainTabs', {
            screen: 'RecordTab',
            params: { screen: 'RecordSeasonList' },
          });
        }}
        onGoHome={() => {
          setSuccessState(clearOrderSuccess());
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
  warningText: { fontSize: 14, color: '#7a4b00' },
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
  ratioRow: {
    flexDirection: 'row',
    gap: 8,
  },
  ratioButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  ratioButtonDisabled: {
    borderColor: '#ddd',
    backgroundColor: '#f4f4f4',
  },
  ratioButtonText: {
    color: '#111',
    fontWeight: '700',
  },
  ratioButtonTextDisabled: {
    color: '#999',
  },
  typeButtonActive: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  typeButtonTextActive: {
    color: '#fff',
  },
});
