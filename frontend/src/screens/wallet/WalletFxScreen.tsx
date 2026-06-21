import React, { useMemo, useState } from 'react';
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
} from '../../features/wallet/api';
import {
  calculateUsdBalanceKrw,
  getWalletBalanceAmount,
  getWalletViewState,
} from '../../features/wallet/mapper';
import {
  getErrorMessageFromCode,
  mapFxErrorCodeToBlockedReason,
  BLOCKED_REASON_MESSAGE,
} from '../../services/api/errorMapper';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import FxSuccessBottomSheet from './FxSuccessBottomSheet';

type Props = WalletFxScreenProps;
type Currency = 'KRW' | 'USD';

const FX_RATE_PARAMS = {
  baseCurrency: 'USD' as const,
  quoteCurrency: 'KRW' as const,
  refresh: false,
};

function extractErrorCode(error: unknown): string | null {
  return (error as any)?.response?.data?.error?.code ?? null;
}

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export default function WalletFxScreen({ navigation }: Props) {
  const queryClient = useQueryClient();
  const rootNavigation = useRootNavigation();

  const [fromCurrency, setFromCurrency] = useState<Currency>('KRW');
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<null | {
    fromCurrency: Currency;
    toCurrency: Currency;
    sourceAmount: string;
    rate: string;
    feeAmount: string;
    netTargetAmount: string;
  }>(null);

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

  // TODO: FX quote/execute still use the v1 action contract; migrate in task 4.
  const quoteMutation = useMutation({
    mutationFn: quoteFx,
    onSuccess: () => {
      setFieldError(null);
      setDomainError(null);
    },
    onError: (error) => {
      const code = extractErrorCode(error);
      const blockedReason = mapFxErrorCodeToBlockedReason(code);
      setDomainError(
        blockedReason
          ? BLOCKED_REASON_MESSAGE[blockedReason]
          : getErrorMessageFromCode(code),
      );
    },
  });

  const executeMutation = useMutation({
    mutationFn: executeFx,
    onSuccess: async (result) => {
      setSuccessData({
        fromCurrency: result.fromCurrency,
        toCurrency: result.toCurrency,
        sourceAmount: result.sourceAmount,
        rate: result.rate,
        feeAmount: result.feeAmount,
        netTargetAmount: result.netTargetAmount,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.wallet.fxRate(FX_RATE_PARAMS),
        }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
      ]);
    },
    onError: (error) => {
      const code = extractErrorCode(error);
      const blockedReason = mapFxErrorCodeToBlockedReason(code);
      setDomainError(
        blockedReason
          ? BLOCKED_REASON_MESSAGE[blockedReason]
          : getErrorMessageFromCode(code),
      );
    },
  });

  const toCurrency: Currency = fromCurrency === 'KRW' ? 'USD' : 'KRW';

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

  const viewState = useMemo(() => {
    if (walletLookupState !== 'wallet_ready') return walletLookupState;
    if (executeMutation.isPending) return 'fx_execute_submitting';
    if (quoteMutation.isPending) return 'fx_quote_loading';
    if (successData) return 'fx_execute_success';
    if (inputInvalidReason) return 'fx_quote_invalid';
    if (quoteMutation.data) return 'fx_quote_ready';
    return 'wallet_ready';
  }, [
    walletLookupState,
    executeMutation.isPending,
    quoteMutation.isPending,
    quoteMutation.data,
    successData,
    inputInvalidReason,
  ]);

  const retryWalletLookup = () => {
    walletsQuery.refetch();
    rateQuery.refetch();
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
                setFieldError(null);
                setDomainError(null);
                setSuccessData(null);
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
                setFieldError(null);
                setDomainError(null);
                setSuccessData(null);
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
              setFieldError(null);
              setDomainError(null);
              setSuccessData(null);
            }}
            keyboardType="decimal-pad"
            placeholder="환전 금액"
          />

          {viewState === 'fx_quote_invalid' && inputInvalidReason ? (
            <Text style={styles.errorText}>{inputInvalidReason}</Text>
          ) : null}

          {fieldError ? <Text style={styles.errorText}>{fieldError}</Text> : null}
          {domainError ? <Text style={styles.errorText}>{domainError}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>환전 견적</Text>

          {viewState === 'fx_quote_loading' ? (
            <SectionSkeleton lines={5} />
          ) : quoteMutation.data ? (
            <>
              <Text style={styles.helper}>적용 환율 {quoteMutation.data.rate}</Text>
              <Text style={styles.helper}>수수료 {quoteMutation.data.feeAmount}</Text>
              <Text style={styles.helper}>
                수령 예정 {quoteMutation.data.netTargetAmount}
              </Text>
              <Text style={styles.helper}>만료 시각 {quoteMutation.data.expiresAt}</Text>
            </>
          ) : (
            <Text style={styles.helper}>
              환전 미리보기를 눌러 예상 수령 금액을 확인하세요.
            </Text>
          )}
        </View>

        <View style={styles.row}>
          <CTAButton
            label="환전 미리보기"
            state={
              viewState === 'fx_quote_loading'
                ? 'loading'
                : inputInvalidReason
                ? 'disabled'
                : 'enabled'
            }
            onPress={() => {
              if (inputInvalidReason) {
                setFieldError(inputInvalidReason);
                return;
              }

              setFieldError(null);
              setDomainError(null);

              quoteMutation.mutate({
                fromCurrency,
                toCurrency,
                amount,
              });
            }}
            style={styles.flex}
          />

          <CTAButton
            label="환전 실행"
            state={
              viewState === 'fx_execute_submitting'
                ? 'loading'
                : quoteMutation.data
                ? 'enabled'
                : 'disabled'
            }
            onPress={() => {
              if (inputInvalidReason) {
                setFieldError(inputInvalidReason);
                return;
              }

              if (!quoteMutation.data) {
                setDomainError('먼저 환전 미리보기를 확인해주세요.');
                return;
              }

              setFieldError(null);
              setDomainError(null);

              executeMutation.mutate({
                fromCurrency,
                toCurrency,
                amount,
              });
            }}
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
