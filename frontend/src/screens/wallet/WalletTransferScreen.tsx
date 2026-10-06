import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getCapabilityBlockMessage, type TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { getTradingAccountWallets, transferTradingAccountWallets, type TradingAccountDto, type WalletTransferDto, type WalletTransferRequestDto } from '../../features/tradingAccount/api';
import { ACCOUNT_INTEGRITY_TITLE, findAccountIntegrityFailure } from '../../features/tradingAccount/accountIntegrityGate';
import { invalidateAfterWalletTransfer } from '../../features/tradingAccount/invalidation';
import { getWalletByIdentity } from '../../features/wallet/mapper';
import { USD_WALLET_SCOPES, WALLET_SCOPE_LABELS } from '../../features/wallet/walletIdentity';
import { parseTransferAmount, transferAmountFits, transferAvailableAmount, transferErrorMessage } from '../../features/wallet/walletTransfer';
import { isFxResponseInScope as isTransferResponseInScope, type FxRequestScope as TransferScope } from '../../features/wallet/fxAccountScope';
import type { WalletScope } from '../../features/wallet/api';
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

type TransferCommand = TransferScope & { body: WalletTransferRequestDto };
function TransferForm({ account, capabilities, scope, readScope }: {
  account: TradingAccountDto;
  capabilities: TradingAccountCapabilities | null;
  scope: TransferScope;
  readScope: () => TransferScope;
}) {
  const queryClient = useQueryClient();
  const wallets = useQuery({ queryKey: QUERY_KEYS.tradingAccount.wallets(account.id), queryFn: () => getTradingAccountWallets(account.id) });
  const [sourceScope, setSourceScope] = useState<WalletScope>('securities');
  const [destinationScope, setDestinationScope] = useState<WalletScope>('crypto_spot');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<TransferCommand | null>(null);
  const [result, setResult] = useState<WalletTransferDto | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const attempt = useRef<TransferCommand | null>(null);
  const mutation = useMutation({
    mutationFn: (command: TransferCommand) => transferTradingAccountWallets(command.accountId, command.body),
    onSuccess: (data, command) => {
      // Money may have moved in A even after A→B→A. Refresh only request A.
      void invalidateAfterWalletTransfer(queryClient, command.accountId);
      if (!isTransferResponseInScope(command, readScope())) return;
      setResult(data); setFailure(null); setReview(null);
    },
    onError: (error, command) => {
      if (!isTransferResponseInScope(command, readScope())) return;
      setFailure(error);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.wallets(command.accountId) });
    },
  });
  const integrity = findAccountIntegrityFailure([
    { section: '지갑', isError: wallets.isError, error: wallets.error, retry: () => void wallets.refetch() },
    { section: '이체', isError: !!failure, error: failure, retry: () => { setFailure(null); void wallets.refetch(); } },
  ]);
  const source = getWalletByIdentity(wallets.data, sourceScope, 'USD');
  const destination = getWalletByIdentity(wallets.data, destinationScope, 'USD');
  const available = transferAvailableAmount(source);
  const canonicalAmount = parseTransferAmount(amount);
  const block = capabilities?.canExchange ? null : getCapabilityBlockMessage(capabilities, capabilities?.exchangeBlockReason) ?? '현재 계정에서는 이체할 수 없습니다.';
  const hasAllUsdWallets = USD_WALLET_SCOPES.every(walletScope => !!getWalletByIdentity(wallets.data, walletScope, 'USD')?.id);
  const canReview = !block && !wallets.isError && hasAllUsdWallets && sourceScope !== destinationScope && !!source?.id && !!destination?.id && transferAmountFits(canonicalAmount, available);
  const beginReview = () => {
    if (!canReview || !source?.id || !destination?.id || !canonicalAmount) return;
    const previous = attempt.current;
    const same = previous?.body.sourceWalletId === source.id && previous.body.destinationWalletId === destination.id && previous.body.amount === canonicalAmount;
    const command: TransferCommand = same ? previous : { ...scope, body: {
      sourceWalletId: source.id, destinationWalletId: destination.id, amount: canonicalAmount, idempotencyKey: createIdempotencyKey('wallet-transfer'),
    } };
    attempt.current = command; setReview(command); setFailure(null);
  };
  const changeSource = (walletScope: WalletScope) => {
    setSourceScope(walletScope);
    if (destinationScope === walletScope) setDestinationScope(USD_WALLET_SCOPES.find(value => value !== walletScope));
    setFailure(null);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView testID="wallet-transfer-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <AccountSwitcher />
          <Text style={styles.account}>{getAccountDisplay(account).title}</Text>
          <Text style={styles.notice}>같은 계정의 USD 지갑 사이에서 수수료 없이 이체합니다. 원화는 환전하기에서 USD로 환전한 뒤 이체할 수 있습니다.</Text>
          {integrity ? <ErrorState title={ACCOUNT_INTEGRITY_TITLE} message={integrity.message} onRetry={integrity.retry} />
            : wallets.isLoading ? <FullPageLoading message="지갑 잔액을 불러오는 중입니다." />
              : wallets.isError || !wallets.data ? <ErrorState title="지갑 잔액을 불러오지 못했습니다." onRetry={() => void wallets.refetch()} />
                : !hasAllUsdWallets || available === null ? <ErrorState title={ACCOUNT_INTEGRITY_TITLE} message="지갑 정보를 확인할 수 없어 이체를 중단했습니다." onRetry={() => void wallets.refetch()} />
                  : result ? (
                    <View testID="wallet-transfer-success" style={styles.card} accessibilityLiveRegion="polite">
                      <Text style={styles.heading}>이체가 완료되었습니다.</Text>
                      <Text style={styles.body}>{WALLET_SCOPE_LABELS[result.source.walletScope]} USD → {WALLET_SCOPE_LABELS[result.destination.walletScope]} USD</Text>
                      <Text style={styles.money}>USD {formatDisplayDecimal(result.amount)}</Text>
                      <Text style={styles.body}>보내는 지갑 잔액: USD {formatDisplayDecimal(result.source.balanceAfter)}</Text>
                      <Text style={styles.body}>받는 지갑 잔액: USD {formatDisplayDecimal(result.destination.balanceAfter)}</Text>
                      <CTAButton label="다른 이체하기" onPress={() => { setResult(null); setAmount(''); attempt.current = null; }} />
                    </View>
                  ) : (
                    <>
                      {block ? <Text testID="wallet-transfer-blocked" style={styles.error}>{block}</Text> : null}
                      <View style={styles.card}>
                        <Text style={styles.heading}>보내는 지갑</Text>
                        {USD_WALLET_SCOPES.map(walletScope => (
                          <WalletOption key={walletScope} walletScope={walletScope} selected={sourceScope === walletScope} disabled={!!review} kind="source" onPress={() => changeSource(walletScope)} />
                        ))}
                        <Text testID="wallet-transfer-available" style={styles.money}>이체 가능 잔액: USD {formatDisplayDecimal(available)}</Text>
                        <Text style={styles.notice}>지정가 주문에 예약된 금액은 이체할 수 없습니다.</Text>
                      </View>
                      <View style={styles.card}>
                        <Text style={styles.heading}>받는 지갑</Text>
                        {USD_WALLET_SCOPES.map(walletScope => (
                          <WalletOption key={walletScope} walletScope={walletScope} selected={destinationScope === walletScope} disabled={!!review || sourceScope === walletScope} kind="destination" onPress={() => { setDestinationScope(walletScope); setFailure(null); }} />
                        ))}
                      </View>
                      <View style={styles.card}>
                        <Text style={styles.heading}>보낼 금액 (USD)</Text>
                        <TextInput testID="wallet-transfer-amount" accessibilityLabel="보낼 금액 USD" value={amount} onChangeText={value => { setAmount(value); setFailure(null); }} editable={!review} keyboardType="decimal-pad" placeholder="0" style={styles.input} />
                        {amount && !canonicalAmount ? <Text style={styles.error}>0보다 큰 금액을 소수점 8자리까지 입력해주세요.</Text> : canonicalAmount && !transferAmountFits(canonicalAmount, available) ? <Text style={styles.error}>이체 가능 잔액을 초과했습니다.</Text> : null}
                      </View>
                      {review ? (
                        <View testID="wallet-transfer-summary" style={styles.card}>
                          <Text style={styles.heading}>이체 내용을 확인해주세요.</Text>
                          <Text style={styles.body}>{WALLET_SCOPE_LABELS[sourceScope]} USD → {WALLET_SCOPE_LABELS[destinationScope]} USD</Text>
                          <Text style={styles.money}>USD {formatDisplayDecimal(review.body.amount)}</Text>
                          <Text style={styles.notice}>수수료 0 · 총자산과 수익률은 변하지 않습니다.</Text>
                          {failure ? <Text testID="wallet-transfer-error" style={styles.error} accessibilityLiveRegion="polite">{transferErrorMessage(getApiErrorCode(failure))}</Text> : null}
                          <CTAButton testID="wallet-transfer-confirm" label={failure ? '같은 요청으로 다시 이체' : '이체하기'} state={mutation.isPending ? 'loading' : block ? 'blocked' : 'enabled'} onPress={() => mutation.mutate(review)} />
                          <CTAButton label="수정하기" variant="neutral" state={mutation.isPending ? 'disabled' : 'enabled'} onPress={() => { setReview(null); setFailure(null); }} />
                        </View>
                      ) : <CTAButton testID="wallet-transfer-review" label="이체 내용 확인" state={canReview ? 'enabled' : 'disabled'} onPress={beginReview} />}
                      <Text style={styles.notice}>암호화폐 선물 지갑은 현재 자금 보관과 이체만 지원합니다.</Text>
                    </>
                  )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function WalletOption({ walletScope, selected, disabled, kind, onPress }: { walletScope: WalletScope; selected: boolean; disabled: boolean; kind: string; onPress: () => void }) {
  return <ActionPressable testID={`wallet-transfer-${kind}-${walletScope}`} accessibilityRole="radio" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.option, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.body}>{WALLET_SCOPE_LABELS[walletScope]} USD{selected ? ' · 선택됨' : ''}</Text>
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
