import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TextInput,
  Pressable,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { WalletFxScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  executeFx,
  getCurrentFxRate,
  getWallets,
  quoteFx,
  type FxExecuteDto,
  type FxQuoteDto,
} from '../../features/wallet/api';
import {
  calculateUsdBalanceKrw,
  getFxQuoteDisplay,
  getFxQuoteExpiresInSeconds,
  getWalletBalanceAmount,
  getWalletViewState,
  isFxIdempotencyConflictCode,
  isFxQuoteExpired,
  isFxRequoteRequiredCode,
} from '../../features/wallet/mapper';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { WalletFxViewState } from '../../models/enums/viewState';
import {
  BLOCKED_REASON_MESSAGE,
  getApiErrorCode,
  getErrorMessageFromCode,
  mapFxErrorCodeToBlockedReason,
} from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import FxSuccessBottomSheet from './FxSuccessBottomSheet';

type Props = WalletFxScreenProps;
type Currency = 'KRW' | 'USD';
type FxDomainState = Extract<
  WalletFxViewState,
  | 'fx_quote_rejected'
  | 'fx_execute_requote_required'
  | 'fx_execute_rejected'
  | 'fx_idempotency_conflict'
>;

const FX_RATE_PARAMS = {
  baseCurrency: 'USD' as const,
  quoteCurrency: 'KRW' as const,
  refresh: false,
};

const QUOTE_EXPIRED_MESSAGE =
  '견적 유효 시간이 지났습니다. 다시 견적을 받아주세요.';
const REQUOTE_REQUIRED_MESSAGE = '환율이 변경되어 다시 견적이 필요합니다.';
const IDEMPOTENCY_CONFLICT_MESSAGE =
  '이미 다른 요청으로 처리 중입니다. 새 견적을 받아 다시 시도해주세요.';

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getFxDomainErrorMessage(code?: string | null) {
  const blockedReason = mapFxErrorCodeToBlockedReason(code);
  return blockedReason
    ? BLOCKED_REASON_MESSAGE[blockedReason]
    : getErrorMessageFromCode(code);
}

export default function WalletFxScreen({ navigation }: Props) {
  const queryClient = useQueryClient();
  const rootNavigation = useRootNavigation();

  const [fromCurrency, setFromCurrency] = useState<Currency>('KRW');
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [quoteData, setQuoteData] = useState<FxQuoteDto | null>(null);
  const [executeIdempotencyKey, setExecuteIdempotencyKey] = useState<
    string | null
  >(null);
  const [fxDomainState, setFxDomainState] = useState<FxDomainState | null>(
    null,
  );
  const [successData, setSuccessData] = useState<FxExecuteDto | null>(null);
  const [quoteNow, setQuoteNow] = useState(() => Date.now());
  const latestQuoteInputRef = useRef({
    fromCurrency: 'KRW' as Currency,
    toCurrency: 'USD' as Currency,
    sourceAmount: '',
  });

  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.wallet.balances,
    queryFn: getWallets,
  });

  const rateQuery = useQuery({
    queryKey: QUERY_KEYS.wallet.fxRate(FX_RATE_PARAMS),
    queryFn: () =>
      getCurrentFxRate(
        FX_RATE_PARAMS.baseCurrency,
        FX_RATE_PARAMS.quoteCurrency,
        FX_RATE_PARAMS.refresh,
      ),
  });

  const quoteMutation = useMutation({
    mutationFn: quoteFx,
    retry: false,
    onSuccess: (result, variables) => {
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.fromCurrency !== latestInput.fromCurrency ||
        variables.toCurrency !== latestInput.toCurrency ||
        variables.sourceAmount !== latestInput.sourceAmount
      ) {
        return;
      }

      setQuoteData(result);
      setExecuteIdempotencyKey(createIdempotencyKey('fx'));
      setFxDomainState(null);
      setFieldError(null);
      setDomainError(null);
      setSuccessData(null);
    },
    onError: (error, variables) => {
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.fromCurrency !== latestInput.fromCurrency ||
        variables.toCurrency !== latestInput.toCurrency ||
        variables.sourceAmount !== latestInput.sourceAmount
      ) {
        return;
      }

      const code = getApiErrorCode(error);

      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setFxDomainState('fx_quote_rejected');
      setDomainError(
        isFxRequoteRequiredCode(code)
          ? REQUOTE_REQUIRED_MESSAGE
          : getFxDomainErrorMessage(code),
      );
    },
  });

  const executeMutation = useMutation({
    mutationFn: executeFx,
    retry: false,
    onSuccess: async (result) => {
      setSuccessData(result);
      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setFxDomainState(null);
      setFieldError(null);
      setDomainError(null);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.wallet.fxRate(FX_RATE_PARAMS),
        }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ranking.all }),
      ]);
    },
    onError: (error) => {
      const code = getApiErrorCode(error);

      if (isFxRequoteRequiredCode(code)) {
        setQuoteData(null);
        setExecuteIdempotencyKey(null);
        setFxDomainState('fx_execute_requote_required');
        setDomainError(
          code === ERROR_CODE.QUOTE_EXPIRED
            ? QUOTE_EXPIRED_MESSAGE
            : REQUOTE_REQUIRED_MESSAGE,
        );
        return;
      }

      if (isFxIdempotencyConflictCode(code)) {
        setQuoteData(null);
        setExecuteIdempotencyKey(null);
        setFxDomainState('fx_idempotency_conflict');
        setDomainError(IDEMPOTENCY_CONFLICT_MESSAGE);
        return;
      }

      setFxDomainState('fx_execute_rejected');
      setDomainError(getFxDomainErrorMessage(code));
    },
  });

  const toCurrency: Currency = fromCurrency === 'KRW' ? 'USD' : 'KRW';

  useEffect(() => {
    latestQuoteInputRef.current = {
      fromCurrency,
      toCurrency,
      sourceAmount: amount.trim(),
    };
  }, [fromCurrency, toCurrency, amount]);

  const inputInvalidReason = useMemo(() => {
    if (!amount.trim()) return '금액을 입력해주세요.';
    if (Number.isNaN(Number(amount))) return '숫자 형식을 확인해주세요.';
    if (Number(amount) <= 0) return '0보다 큰 금액을 입력해주세요.';
    return null;
  }, [amount]);

  const walletLookupState = useMemo(
    () =>
      getWalletViewState(walletsQuery.data, rateQuery.data, {
        isLoading: walletsQuery.isLoading || rateQuery.isLoading,
        isError: walletsQuery.isError || rateQuery.isError,
        walletError: walletsQuery.error,
        rateError: rateQuery.error,
      }),
    [
      walletsQuery.data,
      walletsQuery.isLoading,
      walletsQuery.isError,
      walletsQuery.error,
      rateQuery.data,
      rateQuery.isLoading,
      rateQuery.isError,
      rateQuery.error,
    ],
  );

  useEffect(() => {
    if (!quoteData) return undefined;

    setQuoteNow(Date.now());
    const intervalId = setInterval(() => {
      setQuoteNow(Date.now());
    }, 1000);

    return () => clearInterval(intervalId);
  }, [quoteData]);

  const quoteExpired = useMemo(
    () => (quoteData ? isFxQuoteExpired(quoteData, quoteNow) : false),
    [quoteData, quoteNow],
  );

  const quoteExpiresInSeconds = useMemo(
    () =>
      quoteData ? getFxQuoteExpiresInSeconds(quoteData, quoteNow) : 0,
    [quoteData, quoteNow],
  );

  const quoteDisplay = useMemo(
    () => (quoteData ? getFxQuoteDisplay(quoteData) : null),
    [quoteData],
  );

  const viewState = useMemo<WalletFxViewState>(() => {
    if (walletLookupState !== 'wallet_ready') return walletLookupState;
    if (executeMutation.isPending) return 'fx_execute_submitting';
    if (quoteMutation.isPending) return 'fx_quote_loading';
    if (successData) return 'fx_execute_success';
    if (
      fxDomainState === 'fx_execute_requote_required' ||
      fxDomainState === 'fx_idempotency_conflict' ||
      fxDomainState === 'fx_quote_rejected'
    ) {
      return fxDomainState;
    }
    if (quoteData && quoteExpired) return 'fx_quote_expired';
    if (fxDomainState === 'fx_execute_rejected') return fxDomainState;
    if (quoteData) return 'fx_quote_ready';
    if (inputInvalidReason) {
      return amount.trim() || fieldError ? 'fx_input_invalid' : 'fx_input_idle';
    }
    return 'fx_input_idle';
  }, [
    walletLookupState,
    executeMutation.isPending,
    quoteMutation.isPending,
    successData,
    fxDomainState,
    quoteData,
    quoteExpired,
    inputInvalidReason,
    amount,
    fieldError,
  ]);

  const canExecute =
    walletLookupState === 'wallet_ready' &&
    !inputInvalidReason &&
    !!quoteData &&
    !quoteExpired &&
    !!executeIdempotencyKey &&
    fxDomainState !== 'fx_execute_requote_required' &&
    fxDomainState !== 'fx_idempotency_conflict';

  const inputErrorMessage =
    fieldError ??
    (viewState === 'fx_input_invalid' ? inputInvalidReason : null);

  const resetFxActionState = () => {
    setFieldError(null);
    setDomainError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setFxDomainState(null);
    setSuccessData(null);
    quoteMutation.reset();
    executeMutation.reset();
  };

  const retryWalletLookup = () => {
    walletsQuery.refetch();
    rateQuery.refetch();
  };

  const requestQuote = () => {
    if (inputInvalidReason) {
      setFieldError(inputInvalidReason);
      return;
    }

    setFieldError(null);
    setDomainError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setFxDomainState(null);
    setSuccessData(null);
    executeMutation.reset();

    quoteMutation.mutate({
      fromCurrency,
      toCurrency,
      sourceAmount: amount.trim(),
    });
  };

  const executeQuote = () => {
    if (inputInvalidReason) {
      setFieldError(inputInvalidReason);
      return;
    }

    if (!quoteData) {
      setDomainError('먼저 환전 미리보기를 확인해주세요.');
      return;
    }

    if (quoteExpired) {
      setDomainError(QUOTE_EXPIRED_MESSAGE);
      return;
    }

    if (!executeIdempotencyKey) {
      setFxDomainState('fx_execute_rejected');
      setDomainError(getErrorMessageFromCode(ERROR_CODE.IDEMPOTENCY_REQUIRED));
      return;
    }

    setFieldError(null);
    setDomainError(null);
    setFxDomainState(null);

    executeMutation.mutate({
      quoteId: quoteData.quoteId,
      fromCurrency: quoteData.fromCurrency,
      toCurrency: quoteData.toCurrency,
      sourceAmount: quoteData.sourceAmount,
      idempotencyKey: executeIdempotencyKey,
    });
  };

  if (viewState === 'wallet_loading') {
    return <FullPageLoading message="지갑 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'wallet_not_joined') {
    return (
      <BlockedState
        title="시즌 참가가 필요합니다."
        message="시즌에 참가해야 지갑과 환전 기능을 사용할 수 있습니다."
        actionLabel="시즌 참가하기"
        onAction={() => rootNavigation.navigate('SeasonJoin')}
      />
    );
  }

  if (viewState === 'wallet_unavailable') {
    return (
      <ErrorState
        title="지갑 정보를 사용할 수 없습니다."
        message={
          rateQuery.data?.state && rateQuery.data.state !== 'available'
            ? '현재 환율 정보를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.'
            : '지갑 또는 환율 정보가 아직 준비되지 않았습니다.'
        }
        onRetry={retryWalletLookup}
      />
    );
  }

  if (viewState === 'wallet_error' || !walletsQuery.data || !rateQuery.data) {
    return (
      <ErrorState
        title="지갑 정보를 불러오지 못했습니다."
        message="지갑 또는 환율 조회에 실패했습니다."
        onRetry={retryWalletLookup}
      />
    );
  }

  const krwWallet = getWalletBalanceAmount(walletsQuery.data, 'KRW');
  const usdWallet = getWalletBalanceAmount(walletsQuery.data, 'USD');
  const usdBalanceKrw = calculateUsdBalanceKrw(usdWallet, rateQuery.data);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.walletFx.screen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.label}>지갑 요약</Text>
          <Text style={styles.value}>KRW Wallet {krwWallet}</Text>
          <Text style={styles.value}>USD Wallet {usdWallet}</Text>
          <Text style={styles.helper}>USD 환산 KRW {usdBalanceKrw}</Text>
          <Text style={styles.helper}>환율 {rateQuery.data.rate}</Text>
          <Text style={styles.helper}>
            기준 시각 {displayValue(rateQuery.data.effectiveAt)}
          </Text>
          <Text style={styles.helper}>
            수집 시각 {displayValue(rateQuery.data.capturedAt)}
          </Text>
          <Text style={styles.helper}>
            최신성 {displayValue(rateQuery.data.freshnessAgeSeconds)}초
          </Text>
          {rateQuery.data.fallbackUsed ? (
            <Text style={styles.helper}>대체 환율 소스가 적용되었습니다.</Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>환전 방향</Text>

          <View style={styles.row}>
            <Pressable
              testID={TEST_IDS.walletFx.directionKrwUsd}
              style={[
                styles.directionChip,
                fromCurrency === 'KRW' && styles.directionChipActive,
              ]}
              onPress={() => {
                setFromCurrency('KRW');
                resetFxActionState();
              }}
            >
              <Text
                style={
                  fromCurrency === 'KRW'
                    ? styles.directionChipTextActive
                    : styles.directionChipText
                }
              >
                KRW → USD
              </Text>
            </Pressable>

            <Pressable
              testID={TEST_IDS.walletFx.directionUsdKrw}
              style={[
                styles.directionChip,
                fromCurrency === 'USD' && styles.directionChipActive,
              ]}
              onPress={() => {
                setFromCurrency('USD');
                resetFxActionState();
              }}
            >
              <Text
                style={
                  fromCurrency === 'USD'
                    ? styles.directionChipTextActive
                    : styles.directionChipText
                }
              >
                USD → KRW
              </Text>
            </Pressable>
          </View>

          <TextInput
            testID={TEST_IDS.walletFx.amountInput}
            style={styles.input}
            value={amount}
            onChangeText={(value) => {
              setAmount(value);
              resetFxActionState();
            }}
            keyboardType="decimal-pad"
            placeholder="환전 금액"
          />

          {inputErrorMessage ? (
            <Text style={styles.errorText}>{inputErrorMessage}</Text>
          ) : null}
          {domainError ? <Text style={styles.errorText}>{domainError}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>환전 견적</Text>

          {viewState === 'fx_quote_loading' ? (
            <SectionSkeleton lines={5} />
          ) : quoteDisplay ? (
            <>
              <Text style={styles.helper}>견적 ID {quoteDisplay.quoteId}</Text>
              <Text style={styles.helper}>환전 방향 {quoteDisplay.direction}</Text>
              <Text style={styles.helper}>
                환전 금액 {quoteDisplay.sourceAmount}
              </Text>
              <Text style={styles.helper}>
                적용 환율 {quoteDisplay.appliedRate}
              </Text>
              <Text style={styles.helper}>
                총 수령액 {quoteDisplay.grossTargetAmount}
              </Text>
              <Text style={styles.helper}>수수료율 {quoteDisplay.feeRate}</Text>
              <Text style={styles.helper}>수수료 {quoteDisplay.feeAmount}</Text>
              <Text style={styles.helper}>
                수령 예정 {quoteDisplay.netTargetAmount}
              </Text>
              <Text style={styles.helper}>만료 시각 {quoteDisplay.expiresAt}</Text>
              <Text style={styles.helper}>
                허용 변동 {quoteDisplay.maxChangeBps}bps
              </Text>
              <Text style={styles.helper}>
                남은 시간 {quoteExpiresInSeconds}초
              </Text>
              {quoteExpired ? (
                <Text style={styles.errorText}>{QUOTE_EXPIRED_MESSAGE}</Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.helper}>
              환전 미리보기를 눌러 예상 수령 금액을 확인하세요.
            </Text>
          )}

          {viewState === 'fx_execute_requote_required' ? (
            <Text style={styles.errorText}>{REQUOTE_REQUIRED_MESSAGE}</Text>
          ) : null}
          {viewState === 'fx_idempotency_conflict' ? (
            <Text style={styles.errorText}>{IDEMPOTENCY_CONFLICT_MESSAGE}</Text>
          ) : null}
        </View>

        <View style={styles.row}>
          <CTAButton
            label="환전 미리보기"
            state={
              viewState === 'fx_quote_loading'
                ? 'loading'
                : inputInvalidReason || viewState === 'fx_execute_submitting'
                ? 'disabled'
                : 'enabled'
            }
            onPress={requestQuote}
            style={styles.flex}
          />

          <CTAButton
            label="환전 실행"
            state={
              viewState === 'fx_execute_submitting'
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

      <FxSuccessBottomSheet
        visible={!!successData}
        payload={successData}
        onClose={() => setSuccessData(null)}
        onGoWallet={() => {
          setSuccessData(null);
          navigation.goBack();
        }}
        onGoHome={() => {
          setSuccessData(null);
          navigation.navigate('Home');
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
  label: { fontSize: 13, color: '#666' },
  value: { fontSize: 16, fontWeight: '700' },
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
  directionChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  directionChipActive: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  directionChipText: {
    color: '#111',
    fontWeight: '600',
  },
  directionChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
});
