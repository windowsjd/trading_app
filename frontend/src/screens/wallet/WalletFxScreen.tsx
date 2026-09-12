import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { WalletFxScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getCurrentFxRate,
  type FxExecuteDto,
  type FxQuoteDto,
} from '../../features/wallet/api';
import {
  executeTradingAccountFx,
  getTradingAccountWallets,
  getTradingAccount,
  quoteTradingAccountFx,
} from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import {
  getCapabilityBlockMessage,
  isSeasonNotActiveReason,
} from '../../features/tradingAccount/capabilities';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';
import { invalidateAfterFx } from '../../features/tradingAccount/invalidation';
import {
  isFxResponseInScope,
  type FxRequestScope,
} from '../../features/wallet/fxAccountScope';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import {
  calculateUsdBalanceKrw,
  getWalletBalanceAmount,
  getWalletViewState,
  isFxIdempotencyConflictCode,
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
import {
  formatDisplayDecimal,
  formatKrw,
  formatKstDateTime,
  formatUsd,
} from '../../utils/format';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import { formatPreviewMoney, fxPreview, isPositiveInput, isPreviewFxAvailable } from '../../features/tradingAccount/indicativePreview';
import { runQuotedAction, type QuotedAction } from '../../features/tradingAccount/quotedAction';
import { useStaleRecheck } from '../../features/asset/useStaleRecheck';
import PreviewAmounts from '../../components/tradingAccount/PreviewAmounts';
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
  refresh: true,
};

const QUOTE_EXPIRED_MESSAGE =
  '환전 견적이 만료되었습니다. 환전하기를 다시 눌러주세요.';
const REQUOTE_REQUIRED_MESSAGE = '환율이 변경되어 환전하지 못했습니다. 환전하기를 다시 눌러주세요.';
const IDEMPOTENCY_CONFLICT_MESSAGE =
  '이미 처리 중인 요청입니다. 환전 내역을 확인해주세요.';

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getFxDomainErrorMessage(
  code?: string | null,
  isGeneralAccount = false,
) {
  if (isGeneralAccount && isSeasonNotActiveReason(code)) {
    return '환전을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
  }
  const blockedReason = mapFxErrorCodeToBlockedReason(code);
  return blockedReason
    ? BLOCKED_REASON_MESSAGE[blockedReason]
    : getErrorMessageFromCode(code);
}

export default function WalletFxScreen({ navigation }: Props) {
  const queryClient = useQueryClient();
  const rootNavigation = useRootNavigation();
  const {
    selectedAccountId,
    selectedAccount,
    capabilities,
    isLoading: accountsLoading,
    isEmpty: noAccounts,
  } = useTradingAccount();

  /**
   * FX is bound to the account being viewed (작업 10 §A-4).
   *
   * `fxAccountId` is captured per render from the selection, but every quote
   * and execute closes over the id that produced THEM — and, more importantly,
   * an account change wipes the quote, its idempotency key, the amount, and the
   * success result before any of them can be replayed against a different
   * account. A quote issued for one account is refused by the server for
   * another (`QUOTE_MISMATCH`); this makes sure the client never even tries.
   */
  const accountId = selectedAccountId ?? '';
  const hasAccount = !!selectedAccountId;
  const accountDisplay = selectedAccount
    ? getAccountDisplay(selectedAccount)
    : null;

  /**
   * The scope every FX request is stamped with (작업 12 §2).
   *
   * Adjusted during render rather than in an effect so it is ALREADY correct
   * for the account being rendered — a mutation callback that fires between a
   * render and its effects must not read the previous account's scope. The
   * guard makes the write idempotent, so a double-invoked render is harmless.
   *
   * The epoch is what distinguishes A→B→A from "never left A": the ids match
   * again, but the screen was wiped in between and the in-flight request
   * describes a quote the user can no longer see.
   */
  const scopeRef = useRef<{ accountId: string; epoch: number }>({
    accountId,
    epoch: 0,
  });
  if (scopeRef.current.accountId !== accountId) {
    scopeRef.current = { accountId, epoch: scopeRef.current.epoch + 1 };
  }
  // Read through the ref (never through a render closure) so a late callback
  // compares against the scope the screen is in NOW.
  const readScope = (): FxRequestScope => ({
    accountId: scopeRef.current.accountId,
    scopeEpoch: scopeRef.current.epoch,
  });

  const [fromCurrency, setFromCurrency] = useState<Currency>('KRW');
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [fxDomainState, setFxDomainState] = useState<FxDomainState | null>(null);
  const [successData, setSuccessData] = useState<FxExecuteDto | null>(null);
  const [, setPreviewClock] = useState(0);
  useStaleRecheck(true, () => setPreviewClock((value) => value + 1));
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  type FxRequest = {
    scope: FxRequestScope;
    seasonUi: boolean;
    isGeneral: boolean;
    payload: Parameters<typeof quoteTradingAccountFx>[1];
  };
  const actionRef = useRef<QuotedAction<FxRequest, FxQuoteDto> | null>(null);
  const submitLockRef = useRef(false);
  const isCurrent = (request: FxRequest) => mountedRef.current &&
    isFxResponseInScope(request.scope, readScope());
  const feeQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.detail(accountId),
    queryFn: () => getTradingAccount(accountId),
    enabled: hasAccount,
  });

  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.wallets(accountId),
    queryFn: () => getTradingAccountWallets(accountId),
    enabled: hasAccount,
  });

  const rateQuery = useQuery({
    queryKey: QUERY_KEYS.wallet.fxRate(FX_RATE_PARAMS),
    refetchInterval: 60_000,
    queryFn: () =>
      getCurrentFxRate(
        FX_RATE_PARAMS.baseCurrency,
        FX_RATE_PARAMS.quoteCurrency,
        FX_RATE_PARAMS.refresh,
      ),
  });
  const availableRate = !rateQuery.isError && isPreviewFxAvailable(rateQuery.data, Date.now())
    ? rateQuery.data : null;

  const executeMutation = useMutation({
    mutationFn: (action: QuotedAction<FxRequest, FxQuoteDto>) => runQuotedAction(action, {
      quote: (request) => quoteTradingAccountFx(request.scope.accountId, request.payload),
      execute: (request, quote, key) => executeTradingAccountFx(request.scope.accountId, {
        quoteId: quote.quoteId,
        fromCurrency: quote.fromCurrency,
        toCurrency: quote.toCurrency,
        sourceAmount: quote.sourceAmount,
        idempotencyKey: key,
      }),
      isCurrent: () => isCurrent(action.request),
    }),
    retry: false,
    onSettled: () => { submitLockRef.current = false; },
    onSuccess: async (data, action) => {
      if (!data) return;
      const request = action.request;
      if (isCurrent(request)) {
        setSuccessData(data.result);
        setAmount('');
        setFxDomainState(null);
        setFieldError(null);
        setDomainError(null);
      }
      // Invalidate the acting account even after a switch/unmount.
      await Promise.all([
        invalidateAfterFx(queryClient, request.scope.accountId, { seasonUi: request.seasonUi }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.fxRate(FX_RATE_PARAMS) }),
      ]);
    },
    onError: (error, action) => {
      if (!isCurrent(action.request)) return;
      const code = getApiErrorCode(error);
      if (isFxRequoteRequiredCode(code)) {
        actionRef.current = null;
        setFxDomainState('fx_execute_requote_required');
        setDomainError(code === ERROR_CODE.QUOTE_EXPIRED ? QUOTE_EXPIRED_MESSAGE : REQUOTE_REQUIRED_MESSAGE);
      } else if (isFxIdempotencyConflictCode(code)) {
        actionRef.current = null;
        setFxDomainState('fx_idempotency_conflict');
        setDomainError(IDEMPOTENCY_CONFLICT_MESSAGE);
      } else {
        setFxDomainState('fx_execute_rejected');
        setDomainError(getFxDomainErrorMessage(code, action.request.isGeneral));
      }
    },
  });

  const toCurrency: Currency = fromCurrency === 'KRW' ? 'USD' : 'KRW';

  const inputInvalidReason = !amount.trim() ? '금액을 입력해주세요.'
    : !isPositiveInput(amount, 8) ? '0보다 큰 금액을 소수점 이하 8자리까지 입력해주세요.' : null;
  const preview = fxPreview({ amount: amount.trim(), fromCurrency, rate: availableRate,
    feeRate: !feeQuery.isError ? feeQuery.data?.feePolicy?.fxFeeRate : null, now: Date.now() });

  const walletLookupState = useMemo(
    () =>
      getWalletViewState(walletsQuery.data, rateQuery.data, {
        walletIsLoading: walletsQuery.isLoading,
        walletIsError: walletsQuery.isError,
        rateIsLoading: rateQuery.isLoading,
        rateIsError: rateQuery.isError,
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
    setAmount('');
    setFieldError(null);
    setDomainError(null);
    setFxDomainState(null);
    setSuccessData(null);
    actionRef.current = null;
  }, [accountId]);

  const pending = executeMutation.isPending;
  const viewState: WalletFxViewState = walletLookupState !== 'wallet_ready'
    ? walletLookupState : pending ? 'fx_execute_submitting'
      : fxDomainState ?? (amount.trim() && inputInvalidReason ? 'fx_input_invalid' : 'fx_input_idle');
  const canExecute = walletLookupState === 'wallet_ready' && !!availableRate &&
    !!preview && !inputInvalidReason && capabilities?.canExchange && !pending && !successData && !actionRef.current?.completed;
  const inputErrorMessage = fieldError ?? (amount.trim() ? inputInvalidReason : null);

  const resetFxActionState = () => {
    if (submitLockRef.current) return;
    actionRef.current = null;
    setFieldError(null);
    setDomainError(null);
    setFxDomainState(null);
    setSuccessData(null);
  };
  const retryWalletLookup = () => {
    void walletsQuery.refetch();
    void rateQuery.refetch();
  };
  const executeQuote = () => {
    if (submitLockRef.current || !canExecute) return;
    setFieldError(null);
    setDomainError(null);
    setFxDomainState(null);
    actionRef.current ??= {
      request: {
        scope: readScope(), seasonUi: capabilities?.isSeason ?? false,
        isGeneral: capabilities?.isGeneral === true,
        payload: { fromCurrency, toCurrency, sourceAmount: amount.trim() },
      },
      idempotencyKey: createIdempotencyKey('fx'),
    };
    submitLockRef.current = true;
    executeMutation.mutate(actionRef.current);
  };

  if (accountsLoading || (hasAccount && viewState === 'wallet_loading')) {
    return <FullPageLoading message="지갑 정보를 불러오는 중입니다." />;
  }

  if (noAccounts || !hasAccount) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <AccountSwitcher />
        </View>
      </SafeAreaView>
    );
  }

  /**
   * Suspended/closed accounts cannot exchange. The request is never sent, so
   * the user does not collect a 409 per press; the server remains authoritative.
   */
  const exchangeBlockMessage = capabilities?.canExchange
    ? null
    : getCapabilityBlockMessage(
        capabilities,
        capabilities?.exchangeBlockReason,
      );

  if (exchangeBlockMessage) {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <AccountSwitcher />
          <View
            testID={TEST_IDS.tradingAccount.capabilityNotice}
            style={styles.card}
          >
            <Text style={styles.label}>환전</Text>
            <Text style={styles.blockedTitle}>환전이 제한된 계정입니다.</Text>
            <Text style={styles.blockedMessage}>{exchangeBlockMessage}</Text>
            <CTAButton
              label="원장 보기"
              onPress={() =>
                navigation.navigate('WalletTransactions', {
                  currencyCode: fromCurrency,
                })
              }
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Server-detected damage never renders as an empty or zero wallet — and an
  // account whose wallet the server will not vouch for must not offer 환전
  // either, so this returns before the exchange form (작업 12 §3).
  const integrityFailure = findAccountIntegrityFailure([
    {
      section: '지갑',
      isError: walletsQuery.isError,
      error: walletsQuery.error,
      retry: () => void walletsQuery.refetch(),
    },
  ]);

  if (integrityFailure) {
    return (
      <SafeAreaView style={styles.container} testID={TEST_IDS.tradingAccount.integrityError}>
        <View style={styles.content}>
          <AccountSwitcher />
          <ErrorState
            title={ACCOUNT_INTEGRITY_TITLE}
            message={integrityFailure.message}
            onRetry={integrityFailure.retry}
          />
        </View>
      </SafeAreaView>
    );
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
        message="지갑 정보가 아직 준비되지 않았습니다."
        onRetry={retryWalletLookup}
      />
    );
  }

  if (viewState === 'wallet_error' || !walletsQuery.data) {
    return (
      <ErrorState
        title="지갑 정보를 불러오지 못했습니다."
        message="지갑 조회에 실패했습니다."
        onRetry={retryWalletLookup}
      />
    );
  }

  const krwWallet = getWalletBalanceAmount(walletsQuery.data, 'KRW');
  const usdWallet = getWalletBalanceAmount(walletsQuery.data, 'USD');
  const usdBalanceKrw = availableRate
    ? calculateUsdBalanceKrw(usdWallet, availableRate)
    : null;

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        testID={TEST_IDS.walletFx.screen}
        contentContainerStyle={styles.content}
      >
        <AccountSwitcher />

        <View style={styles.card}>
          <Text style={styles.label}>
            지갑 요약{accountDisplay ? ` · ${accountDisplay.title}` : ''}
          </Text>
          <Text style={styles.value}>KRW Wallet {formatKrw(krwWallet)}</Text>
          <Text style={styles.value}>USD Wallet {formatUsd(usdWallet)}</Text>
          <Text style={styles.helper}>
            USD 환산 KRW {usdBalanceKrw === null ? '-' : formatKrw(usdBalanceKrw)}
          </Text>
          {availableRate ? (
            <>
              <Text style={styles.helper}>
                환율 {formatDisplayDecimal(availableRate.rate)}
              </Text>
              <Text style={styles.helper}>
                기준 시각 {formatKstDateTime(availableRate.effectiveAt)}
              </Text>
              <Text style={styles.helper}>
                수집 시각 {formatKstDateTime(availableRate.capturedAt)}
              </Text>
              <Text style={styles.helper}>
                최신성 {displayValue(availableRate.freshnessAgeSeconds)}초
              </Text>
              {availableRate.fallbackUsed ? (
                <Text style={styles.helper}>
                  대체 환율 소스가 적용되었습니다.
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <Text style={styles.errorText}>
                현재 환율을 사용할 수 없어 환전 기능이 잠시 중단되었습니다.
              </Text>
              <CTAButton
                label={rateQuery.isLoading ? '환율 불러오는 중' : '환율 다시 불러오기'}
                state={rateQuery.isLoading ? 'loading' : 'enabled'}
                onPress={() => void rateQuery.refetch()}
              />
            </>
          )}
          <CTAButton
            label="원장 보기"
            onPress={() =>
              navigation.navigate('WalletTransactions', {
                currencyCode: fromCurrency,
              })
            }
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>환전 방향</Text>

          <View style={styles.row}>
            <Pressable
              testID={TEST_IDS.walletFx.directionKrwUsd}
              disabled={pending}
              style={[
                styles.directionChip,
                fromCurrency === 'KRW' && styles.directionChipActive,
              ]}
              onPress={() => {
                if (submitLockRef.current) return;
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
              disabled={pending}
              style={[
                styles.directionChip,
                fromCurrency === 'USD' && styles.directionChipActive,
              ]}
              onPress={() => {
                if (submitLockRef.current) return;
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
            editable={!pending}
            style={styles.input}
            value={amount}
            onChangeText={(value) => {
              if (submitLockRef.current) return;
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

        {!inputInvalidReason ? (
          <View style={styles.card} testID="fx-indicative-preview">
            <Text style={styles.label}>예상 환전 견적</Text>
            {preview && availableRate ? <>
              <PreviewAmounts rows={[
                { label: '적용 환율 (USD/KRW)', value: formatDisplayDecimal(availableRate.rate) },
                { label: '예상 수수료', value: formatPreviewMoney(preview.feeAmount, preview.feeCurrency) },
                { label: '예상 수령액', value: formatPreviewMoney(preview.netTargetAmount, toCurrency) },
              ]} />
              <Text style={styles.helper}>최신 환율 기준 · {formatKstDateTime(availableRate.effectiveAt)}</Text>
              <Text style={styles.helper}>받는 통화에서 수수료가 차감됩니다. 실제 환전 금액은 실행 시 확정됩니다.</Text>
            </> : <>
              <Text style={styles.errorText}>{!availableRate ? '현재 환율이 없거나 오래되어 예상 수령액을 표시할 수 없습니다.' : feeQuery.isPending ? '수수료 정보를 확인하는 중입니다.' : '수수료 정보를 불러오지 못해 예상 수령액을 표시할 수 없습니다.'}</Text>
              {feeQuery.isError ? <CTAButton label="수수료 다시 불러오기" onPress={() => void feeQuery.refetch()} /> : null}
            </>}
          </View>
        ) : null}
        <CTAButton testID={TEST_IDS.walletFx.executeSubmit} label="환전하기"
          state={pending ? 'loading' : canExecute ? 'enabled' : 'disabled'}
          onPress={executeQuote} />
      </ScrollView>
      </KeyboardAvoidingView>

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
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
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
  value: { fontSize: 16, fontWeight: '700', lineHeight: 24, flexShrink: 1 },
  helper: { fontSize: 14, color: '#444', lineHeight: 21, flexShrink: 1 },
  // Full text, wrapped: a capability notice that is cut to one ellipsised line
  // stops explaining why the button is gone.
  blockedTitle: { fontSize: 17, fontWeight: '700', lineHeight: 24 },
  blockedMessage: { fontSize: 14, color: '#444', lineHeight: 21 },
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
    minWidth: 130,
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
    lineHeight: 21,
    textAlign: 'center',
    flexShrink: 1,
  },
  directionChipTextActive: {
    color: '#fff',
    fontWeight: '600',
    lineHeight: 21,
    textAlign: 'center',
    flexShrink: 1,
  },
});
