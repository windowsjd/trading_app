import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getCapabilityBlockMessage, type TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { getTradingAccountWallets, transferTradingAccountWallets, quoteTradingAccountWalletTransfer, executeTradingAccountWalletTransfer, type TradingAccountDto, type WalletTransferDto, type WalletTransferRequestDto, type WalletFxTransferQuoteDto, type WalletFxTransferDto } from '../../features/tradingAccount/api';
import { ACCOUNT_INTEGRITY_TITLE, findAccountIntegrityFailure } from '../../features/tradingAccount/accountIntegrityGate';
import { invalidateAfterWalletTransfer, invalidateAfterWalletFxTransfer } from '../../features/tradingAccount/invalidation';
import { getWalletByIdentity } from '../../features/wallet/mapper';
import { TRANSFER_WALLETS, WALLET_SCOPE_LABELS, transferRouteKind, type TransferWalletIdentity } from '../../features/wallet/walletIdentity';
import { parseTransferAmount, transferAmountFits, transferAvailableAmount, transferErrorMessage } from '../../features/wallet/walletTransfer';
import { isFxResponseInScope as isTransferResponseInScope, type FxRequestScope as TransferScope } from '../../features/wallet/fxAccountScope';
import type { WalletCurrency } from '../../features/wallet/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatDisplayDecimal } from '../../utils/format';
import { getApiErrorCode } from '../../services/api/errorMapper';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';

export default function WalletTransferScreen() {
  const { selectedAccount, capabilities, isLoading, isError, refetchAccounts } = useTradingAccount();
  const accountId = selectedAccount?.id ?? '';
  const scopeRef = useRef<TransferScope>({ accountId, scopeEpoch: 0 });
  if (scopeRef.current.accountId !== accountId) scopeRef.current = { accountId, scopeEpoch: scopeRef.current.scopeEpoch + 1 };
  if (isLoading) return <FullPageLoading message="계정 정보를 불러오는 중입니다." />;
  if (isError || !selectedAccount) return <ErrorState title="계정 정보를 불러오지 못했습니다." onRetry={() => void refetchAccounts()} />;
  return <TransferForm key={`${accountId}:${scopeRef.current.scopeEpoch}`} account={selectedAccount} capabilities={capabilities} scope={scopeRef.current} readScope={() => scopeRef.current} />;
}

type TransferCommand = TransferScope & {
  body: WalletTransferRequestDto;
  currency: WalletCurrency;
  crossCurrency: boolean;
  seasonUi: boolean;
  quote?: WalletFxTransferQuoteDto;
  running?: boolean;
  attempted?: boolean;
  completed?: boolean;
};
function TransferForm({ account, capabilities, scope, readScope }: {
  account: TradingAccountDto;
  capabilities: TradingAccountCapabilities | null;
  scope: TransferScope;
  readScope: () => TransferScope;
}) {
  const queryClient = useQueryClient();
  const wallets = useQuery({ queryKey: QUERY_KEYS.tradingAccount.wallets(account.id), queryFn: () => getTradingAccountWallets(account.id) });
  const [sourceKey, setSourceKey] = useState<TransferWalletIdentity['key']>('securities');
  const [destinationKey, setDestinationKey] = useState<TransferWalletIdentity['key']>('crypto_spot');
  const sourceIdentity = TRANSFER_WALLETS.find(wallet => wallet.key === sourceKey);
  const destinationIdentity = TRANSFER_WALLETS.find(wallet => wallet.key === destinationKey);
  const routeKind = transferRouteKind(sourceIdentity, destinationIdentity);
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<TransferCommand | null>(null);
  const [result, setResult] = useState<WalletTransferDto | WalletFxTransferDto | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [requote, setRequote] = useState(false);
  const [now, setNow] = useState(Date.now());
  const attempt = useRef<TransferCommand | null>(null);
  const quoteLock = useRef(false);
  useEffect(() => {
    if (!review?.quote) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [review]);
  const expired = !!review?.quote && now > Date.parse(review.quote.expiresAt);
  // Uncertain execute retries keep the quote/key beyond local expiry: server
  // replay precedes expiry. Only an authoritative rejection permits requoting.
  const needsRequote = requote || (expired && !review?.attempted);
  const quoteMutation = useMutation({
    retry: false,
    mutationFn: (command: TransferCommand) => quoteTradingAccountWalletTransfer(command.accountId, {
      sourceWalletId: command.body.sourceWalletId, destinationWalletId: command.body.destinationWalletId,
      amount: command.body.amount,
    }, command.currency),
    onSuccess: (quote, command) => {
      if (!isTransferResponseInScope(command, readScope())) return;
      const ready = { ...command, quote };
      attempt.current = ready; setReview(ready); setNow(Date.now()); setFailure(null); setRequote(false);
    },
    onError: (error, command) => {
      if (isTransferResponseInScope(command, readScope())) setFailure(error);
    },
    onSettled: () => { quoteLock.current = false; },
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (command: TransferCommand) => {
      command.attempted = true;
      try {
        const data = command.crossCurrency
          ? await executeTradingAccountWalletTransfer(command.accountId, command.quote, command.body.idempotencyKey)
          : await transferTradingAccountWallets(command.accountId, command.body);
        command.completed = true;
        return data;
      } finally { command.running = false; }
    },
    onSuccess: (data, command) => {
      if (!data) return;
      // Money may have moved in A even after A→B→A. Refresh only request A.
      void (command.crossCurrency
        ? invalidateAfterWalletFxTransfer(queryClient, command.accountId, { seasonUi: command.seasonUi })
        : invalidateAfterWalletTransfer(queryClient, command.accountId));
      if (!isTransferResponseInScope(command, readScope())) return;
      setResult(data); setFailure(null); setReview(null);
    },
    onError: (error, command) => {
      // A transport/response error may follow a committed FX command.
      void (command.crossCurrency
        ? invalidateAfterWalletFxTransfer(queryClient, command.accountId, { seasonUi: command.seasonUi })
        : queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.wallets(command.accountId) }));
      if (!isTransferResponseInScope(command, readScope())) return;
      setFailure(error);
      const code = getApiErrorCode(error);
      setRequote(command.crossCurrency && ['QUOTE_EXPIRED', 'QUOTE_NOT_ACTIVE', 'RATE_CHANGED_REQUOTE_REQUIRED'].includes(code ?? ''));
    },
  });
  const integrity = findAccountIntegrityFailure([
    { section: '지갑', isError: wallets.isError, error: wallets.error, retry: () => void wallets.refetch() },
    { section: '이체', isError: !!failure, error: failure, retry: () => { setFailure(null); void wallets.refetch(); } },
  ]);
  const source = getWalletByIdentity(wallets.data, sourceIdentity.scope, sourceIdentity.currency);
  const destination = getWalletByIdentity(wallets.data, destinationIdentity.scope, destinationIdentity.currency);
  const available = transferAvailableAmount(source);
  const canonicalAmount = parseTransferAmount(amount);
  const block = capabilities?.canExchange ? null : getCapabilityBlockMessage(capabilities, capabilities?.exchangeBlockReason) ?? '현재 계정에서는 이체할 수 없습니다.';
  const hasAllWallets = TRANSFER_WALLETS.every(wallet => !!getWalletByIdentity(wallets.data, wallet.scope, wallet.currency)?.id);
  const canReview = !block && !wallets.isError && hasAllWallets && ['same_currency', 'cross_currency'].includes(routeKind) && !!source?.id && !!destination?.id && transferAmountFits(canonicalAmount, available);
  const executeCommand = (command: TransferCommand) => {
    // Fence before React Query creates a mutation: a duplicate tap must not
    // replace the pending observer and re-enable editing while money is moving.
    if (command.running || command.completed || !isTransferResponseInScope(command, readScope())) return;
    command.running = true;
    mutation.mutate(command);
  };
  const beginReview = (forceQuote = false) => {
    if (!canReview || !source?.id || !destination?.id || !canonicalAmount || quoteLock.current) return;
    const previous = forceQuote ? null : attempt.current;
    const same = previous?.body.sourceWalletId === source.id && previous.body.destinationWalletId === destination.id && previous.body.amount === canonicalAmount;
    const command: TransferCommand = same ? previous : { ...scope, currency: sourceIdentity.currency, crossCurrency: routeKind === 'cross_currency', seasonUi: capabilities?.isSeason ?? false, body: {
      sourceWalletId: source.id, destinationWalletId: destination.id, amount: canonicalAmount, idempotencyKey: createIdempotencyKey('wallet-transfer'),
    } };
    attempt.current = command; setFailure(null); setRequote(false);
    if (command.crossCurrency && (!command.quote || forceQuote)) {
      quoteLock.current = true; setReview(null); quoteMutation.mutate(command);
    } else setReview(command);
  };
  const changeSource = (wallet: TransferWalletIdentity) => {
    setSourceKey(wallet.key);
    if (!['same_currency', 'cross_currency'].includes(transferRouteKind(wallet, destinationIdentity))) {
      setDestinationKey(TRANSFER_WALLETS.find(value => ['same_currency', 'cross_currency'].includes(transferRouteKind(wallet, value))).key);
    }
    setFailure(null);
  };
  const locked = !!review || quoteMutation.isPending;
  const label = (wallet: TransferWalletIdentity) => `${WALLET_SCOPE_LABELS[wallet.scope]} ${wallet.currency}`;

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView testID="wallet-transfer-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <AccountSwitcher />
          <Text style={styles.account}>{getAccountDisplay(account).title}</Text>
          <Text style={styles.notice}>USD 지갑 간 이체는 수수료가 없습니다. 원화와 암호화폐 USD 사이의 이체에는 환전 수수료가 적용됩니다.</Text>
          {integrity ? <ErrorState title={ACCOUNT_INTEGRITY_TITLE} message={integrity.message} onRetry={integrity.retry} />
            : wallets.isLoading ? <FullPageLoading message="지갑 잔액을 불러오는 중입니다." />
              : wallets.isError || !wallets.data ? <ErrorState title="지갑 잔액을 불러오지 못했습니다." onRetry={() => void wallets.refetch()} />
                : !hasAllWallets || available === null ? <ErrorState title={ACCOUNT_INTEGRITY_TITLE} message="지갑 정보를 확인할 수 없어 이체를 중단했습니다." onRetry={() => void wallets.refetch()} />
                  : result ? (
                    <View testID="wallet-transfer-success" style={styles.card} accessibilityLiveRegion="polite">
                      <Text style={styles.heading}>이체가 완료되었습니다.</Text>
                      <Text style={styles.body}>{WALLET_SCOPE_LABELS[result.source.walletScope]} {'fx' in result ? result.source.currencyCode : 'USD'} → {WALLET_SCOPE_LABELS[result.destination.walletScope]} {'fx' in result ? result.destination.currencyCode : 'USD'}</Text>
                      <Text style={styles.money}>보낸 금액: {'fx' in result ? `${result.source.currencyCode} ${formatDisplayDecimal(result.sourceAmount)}` : `USD ${formatDisplayDecimal(result.amount)}`}</Text>
                      {'fx' in result ? <>
                        <Text style={styles.body}>실제 적용 환율: 1 USD = {formatDisplayDecimal(result.fx.appliedRate)} KRW</Text>
                        <Text style={styles.body}>실제 환전 수수료: {result.fx.feeCurrency} {formatDisplayDecimal(result.fx.feeAmount)}</Text>
                        <Text testID="wallet-transfer-actual-received" style={styles.money}>실제 수령액: {result.destination.currencyCode} {formatDisplayDecimal(result.receivedAmount)}</Text>
                      </> : null}
                      <Text style={styles.body}>보내는 지갑 잔액: {'fx' in result ? result.source.currencyCode : 'USD'} {formatDisplayDecimal(result.source.balanceAfter)}</Text>
                      <Text style={styles.body}>받는 지갑 잔액: {'fx' in result ? result.destination.currencyCode : 'USD'} {formatDisplayDecimal(result.destination.balanceAfter)}</Text>
                      <CTAButton label="다른 이체하기" onPress={() => { setResult(null); setAmount(''); attempt.current = null; }} />
                    </View>
                  ) : (
                    <>
                      {block ? <Text testID="wallet-transfer-blocked" style={styles.error}>{block}</Text> : null}
                      <View style={styles.card}>
                        <Text style={styles.heading}>보내는 지갑</Text>
                        {TRANSFER_WALLETS.map(wallet => (
                          <WalletOption key={wallet.key} wallet={wallet} selected={sourceKey === wallet.key} disabled={locked} kind="source" onPress={() => changeSource(wallet)} />
                        ))}
                        <Text testID="wallet-transfer-available" style={styles.money}>이체 가능 잔액: {sourceIdentity.currency} {formatDisplayDecimal(available)}</Text>
                        <Text style={styles.notice}>지정가 주문에 예약된 금액은 이체할 수 없습니다.</Text>
                      </View>
                      <View style={styles.card}>
                        <Text style={styles.heading}>받는 지갑</Text>
                        {TRANSFER_WALLETS.map(wallet => (
                          <WalletOption key={wallet.key} wallet={wallet} selected={destinationKey === wallet.key} disabled={locked || ['invalid', 'fx'].includes(transferRouteKind(sourceIdentity, wallet))} kind="destination" onPress={() => { setDestinationKey(wallet.key); setFailure(null); }} />
                        ))}
                      </View>
                      <Text style={styles.notice}>증권 KRW ↔ USD 사이의 이동은 환전하기를 이용해주세요.</Text>
                      <View style={styles.card}>
                        <Text style={styles.heading}>보낼 금액 ({sourceIdentity.currency})</Text>
                        <TextInput testID="wallet-transfer-amount" accessibilityLabel={`보낼 금액 ${sourceIdentity.currency}`} value={amount} onChangeText={value => { setAmount(value); setFailure(null); }} editable={!locked} keyboardType="decimal-pad" placeholder="0" style={styles.input} />
                        {amount && !canonicalAmount ? <Text style={styles.error}>0보다 큰 금액을 소수점 8자리까지 입력해주세요.</Text> : canonicalAmount && !transferAmountFits(canonicalAmount, available) ? <Text style={styles.error}>이체 가능 잔액을 초과했습니다.</Text> : null}
                      </View>
                      {review ? (
                        <View testID="wallet-transfer-summary" style={styles.card}>
                          <Text style={styles.heading}>이체 내용을 확인해주세요.</Text>
                          <Text style={styles.body}>{label(sourceIdentity)} → {label(destinationIdentity)}</Text>
                          <Text style={styles.money}>{sourceIdentity.currency} {formatDisplayDecimal(review.body.amount)}</Text>
                          {review.quote ? <>
                            <Text style={styles.body}>적용 예정 환율: 1 USD = {formatDisplayDecimal(review.quote.appliedRate)} KRW</Text>
                            <Text style={styles.body}>환전 수수료: {review.quote.feeCurrency} {formatDisplayDecimal(review.quote.feeAmount)}</Text>
                            <Text testID="wallet-transfer-expected-received" style={styles.money}>예상 수령액: {review.quote.toCurrency} {formatDisplayDecimal(review.quote.netTargetAmount)}</Text>
                            <Text style={styles.notice}>실행 직전 최신 환율로 계산합니다. 환전 수수료는 수령 통화에서 차감됩니다.</Text>
                            <Text style={styles.notice}>{needsRequote ? '견적이 만료되었거나 새 견적이 필요합니다.' : `견적 유효 시간: ${Math.max(0, Math.ceil((Date.parse(review.quote.expiresAt) - now) / 1000))}초`}</Text>
                          </> : <Text style={styles.notice}>수수료 0 · 총자산과 수익률은 변하지 않습니다.</Text>}
                          {failure ? <Text testID="wallet-transfer-error" style={styles.error} accessibilityLiveRegion="polite">{transferErrorMessage(getApiErrorCode(failure))}</Text> : null}
                          {needsRequote ? <CTAButton testID="wallet-transfer-requote" label="다시 견적 받기" state={block ? 'blocked' : 'enabled'} onPress={() => beginReview(true)} /> : <CTAButton testID="wallet-transfer-confirm" label={failure ? '같은 요청으로 다시 이체' : '이체하기'} state={mutation.isPending ? 'loading' : block ? 'blocked' : 'enabled'} onPress={() => executeCommand(review)} />}
                          <CTAButton label="수정하기" variant="neutral" state={mutation.isPending ? 'disabled' : 'enabled'} onPress={() => { setReview(null); setFailure(null); }} />
                        </View>
                      ) : <>
                        {failure ? <Text testID="wallet-transfer-error" style={styles.error} accessibilityLiveRegion="polite">{transferErrorMessage(getApiErrorCode(failure))}</Text> : null}
                        <CTAButton testID="wallet-transfer-review" label="이체 내용 확인" state={quoteMutation.isPending ? 'loading' : canReview ? 'enabled' : 'disabled'} onPress={() => beginReview()} />
                      </>}
                      <Text style={styles.notice}>암호화폐 선물 지갑은 현재 자금 보관과 이체만 지원합니다.</Text>
                    </>
                  )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function WalletOption({ wallet, selected, disabled, kind, onPress }: { wallet: TransferWalletIdentity; selected: boolean; disabled: boolean; kind: string; onPress: () => void }) {
  return <ActionPressable testID={`wallet-transfer-${kind}-${wallet.key}`} accessibilityRole="radio" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.option, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.body}>{WALLET_SCOPE_LABELS[wallet.scope]} {wallet.currency}{selected ? ' · 선택됨' : ''}</Text>
  </ActionPressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  account: { fontSize: 17, lineHeight: 26, fontWeight: '600' },
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 12 },
  heading: { fontSize: 16, lineHeight: 25, fontWeight: '600' },
  body: { fontSize: 14, lineHeight: 22, flexShrink: 1 },
  money: { fontSize: 16, lineHeight: 25, fontVariant: ['tabular-nums'], flexShrink: 1 },
  notice: { color: semantic.secondary, fontSize: 13, lineHeight: 21 },
  error: { color: semantic.warning, fontSize: 14, lineHeight: 23 },
  option: { padding: 12, borderWidth: 1, borderColor: semantic.border, borderRadius: 10 },
  selected: { borderColor: semantic.selected, backgroundColor: semantic.raised },
  disabled: { opacity: 0.5 },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 10, padding: 12, fontSize: 18, minHeight: 48 },
});
