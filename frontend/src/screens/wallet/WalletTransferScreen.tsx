import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import Svg, { Path } from 'react-native-svg';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getCapabilityBlockMessage, type TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getTradingAccountWallets, getTradingAccountFuturesCollateral, transferTradingAccountWallets, type TradingAccountDto, type WalletTransferDto, type WalletTransferRequestDto } from '../../features/tradingAccount/api';
import { ACCOUNT_INTEGRITY_TITLE, findAccountIntegrityFailure } from '../../features/tradingAccount/accountIntegrityGate';
import { invalidateAfterWalletTransfer } from '../../features/tradingAccount/invalidation';
import { getWalletByIdentity } from '../../features/wallet/mapper';
import { TRANSFER_WALLETS, WALLET_SCOPE_LABELS, type TransferWalletIdentity } from '../../features/wallet/walletIdentity';
import { parseTransferAmount, transferAmountFits, transferAvailableAmount, futuresTransferAvailableAmount, transferErrorMessage, WalletTransferContractError } from '../../features/wallet/walletTransfer';
import { isFxResponseInScope as isTransferResponseInScope, type FxRequestScope as TransferScope } from '../../features/wallet/fxAccountScope';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatDisplayDecimal } from '../../utils/format';
import { getApiErrorCode, getApiErrorInfo, getApiErrorStatus, requestFailureFacts } from '../../services/api/errorMapper';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import ErrorNotice from '../../components/states/ErrorNotice';
import { isTradingAccountScopeMismatchError } from '../../features/tradingAccount/accountScope';
import {
  claimQuestGuideCommand,
  publishQuestGuideFacts,
  questGuideTarget,
  registerQuestGuideReveal,
} from '../../features/quest/questGuideBridge';

type UsdWalletIdentity = Extract<TransferWalletIdentity, { currency: 'USD' }>;
const USD_TRANSFER_WALLETS = TRANSFER_WALLETS.filter((wallet): wallet is UsdWalletIdentity => wallet.currency === 'USD');
const walletLabel = (wallet: UsdWalletIdentity) => WALLET_SCOPE_LABELS[wallet.scope] + ' USD';

export default function WalletTransferScreen() {
  const { selectedAccount, capabilities, isLoading, isError, error, refetchAccounts } = useTradingAccount();
  const accountId = selectedAccount?.id ?? '';
  const scopeRef = useRef<TransferScope>({ accountId, scopeEpoch: 0 });
  if (scopeRef.current.accountId !== accountId) scopeRef.current = { accountId, scopeEpoch: scopeRef.current.scopeEpoch + 1 };
  if (isLoading) return <FullPageLoading message="계정 정보를 불러오는 중입니다." />;
  if (isError || !selectedAccount) return <ErrorState error={isError ? error : undefined} title="계정 정보를 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void refetchAccounts()} />;
  return <TransferForm key={accountId + ':' + scopeRef.current.scopeEpoch} account={selectedAccount} capabilities={capabilities} scope={scopeRef.current} readScope={() => scopeRef.current} />;
}

type TransferCommand = TransferScope & {
  body: WalletTransferRequestDto;
  futuresCollateral: boolean;
  running?: boolean;
  completed?: boolean;
  uncertain?: boolean;
};
function TransferForm({ account, capabilities, scope, readScope }: {
  account: TradingAccountDto;
  capabilities: TradingAccountCapabilities | null;
  scope: TransferScope;
  readScope: () => TransferScope;
}) {
  const queryClient = useQueryClient();
  const headerHeight = useHeaderHeight();
  const inputScroll = useFocusedInputScroll();
  const amountRef = useRef<View>(null);
  const amountInputRef = useRef<TextInput>(null);
  const wallets = useQuery({ queryKey: QUERY_KEYS.tradingAccount.wallets(account.id), queryFn: () => getTradingAccountWallets(account.id) });
  const [sourceKey, setSourceKey] = useState<UsdWalletIdentity['key']>('securities');
  const [destinationKey, setDestinationKey] = useState<UsdWalletIdentity['key']>('crypto_spot');
  const [openDropdown, setOpenDropdown] = useState<'source' | 'destination' | null>(null);
  const sourceIdentity = USD_TRANSFER_WALLETS.find(wallet => wallet.key === sourceKey);
  const destinationIdentity = USD_TRANSFER_WALLETS.find(wallet => wallet.key === destinationKey);
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<WalletTransferDto | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const attempt = useRef<TransferCommand | null>(null);
  const sourceIsFutures = sourceIdentity.scope === 'crypto_futures';
  const futures = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futuresCollateral(account.id),
    queryFn: () => getTradingAccountFuturesCollateral(account.id),
    enabled: sourceIsFutures && !result,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: sourceIsFutures && !result ? 5000 : false,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (command: TransferCommand) => {
      try {
        const data = await transferTradingAccountWallets(command.accountId, command.body);
        command.completed = true;
        return data;
      } finally { command.running = false; }
    },
    onSuccess: (data, command) => {
      // Money may have moved in A even after A→B→A. Refresh only request A.
      void invalidateAfterWalletTransfer(queryClient, command.accountId, { futuresCollateral: command.futuresCollateral });
      if (!isTransferResponseInScope(command, readScope())) return;
      setResult(data); setFailure(null);
      // QUEST 02 re-reads server progress itself; the receipt stays on screen.
      claimQuestGuideCommand({
        kind: 'transfer',
        accountId: command.accountId,
        source: data.source.walletScope,
        destination: data.destination.walletScope,
        currency: data.currencyCode,
        summary: `보낸 금액 USD ${formatDisplayDecimal(data.amount)}`,
      });
    },
    onError: (error, command) => {
      // A transport/response error may follow a committed command.
      command.uncertain = error instanceof WalletTransferContractError || !getApiErrorInfo(error).hasResponse || (getApiErrorStatus(error) ?? 0) >= 500;
      void invalidateAfterWalletTransfer(queryClient, command.accountId, { futuresCollateral: command.futuresCollateral });
      if (isTransferResponseInScope(command, readScope())) setFailure(error);
    },
  });
  const integrity = findAccountIntegrityFailure([
    { section: '지갑', isError: wallets.isError, error: wallets.error, retry: () => void wallets.refetch() },
    { section: '선물 담보', isError: sourceIsFutures && futures.isError, error: futures.error, retry: () => void futures.refetch() },
    { section: '이체', isError: !!failure, error: failure, retry: () => { setFailure(null); void wallets.refetch(); } },
  ]);
  const failureRuntime = failure ? requestFailureFacts(failure, {
    endpoint: 'POST /api/v1/trading-accounts/:accountId/wallet-transfers',
    operation: 'wallet_transfer',
    contractFailure: failure instanceof WalletTransferContractError || isTradingAccountScopeMismatchError(failure),
    contractInvestigation: failure instanceof WalletTransferContractError ? 'frontend/src/features/wallet/walletTransfer.ts' : undefined,
    outcome: attempt.current?.uncertain ? 'unknown' : undefined,
  }) : undefined;
  const scopedWallets = wallets.data?.tradingAccountId === account.id ? wallets.data : undefined;
  const source = getWalletByIdentity(scopedWallets, sourceIdentity.scope, 'USD');
  const destination = getWalletByIdentity(scopedWallets, destinationIdentity.scope, 'USD');
  const usdWallets = USD_TRANSFER_WALLETS.map(wallet => getWalletByIdentity(scopedWallets, wallet.scope, 'USD'));
  const hasAllWallets = usdWallets.every(wallet => typeof wallet?.id === 'string' && !!wallet.id && wallet.currencyCode === 'USD') &&
    new Set(usdWallets.map(wallet => wallet?.id)).size === USD_TRANSFER_WALLETS.length;
  // Background refresh keeps validated collateral; missing data and query errors fail closed.
  const available = sourceIsFutures
    ? futures.isError ? null : futuresTransferAvailableAmount(futures.data, account.id, source)
    : transferAvailableAmount(source);
  const canonicalAmount = parseTransferAmount(amount);
  const block = capabilities?.canExchange ? null : getCapabilityBlockMessage(capabilities, capabilities?.exchangeBlockReason) ?? '현재 계정에서는 이체할 수 없습니다.';
  const locked = mutation.isPending || !!attempt.current?.running;
  const sameIntent = (command: TransferCommand | null): command is TransferCommand => !!command &&
    isTransferResponseInScope(command, readScope()) && command.body.sourceWalletId === source?.id &&
    command.body.destinationWalletId === destination?.id && command.body.amount === canonicalAmount;
  // Reconcile an uncertain commit with the pinned key even if refreshed cash
  // already reflects that debit. Unknown Futures collateral still fails closed.
  const uncertainRetry = sameIntent(attempt.current) && !!attempt.current.uncertain;
  const canExecute = !block && !wallets.isError && hasAllWallets && !!source?.id && !!destination?.id &&
    source.id !== destination.id && !!canonicalAmount && available !== null &&
    (transferAmountFits(canonicalAmount, available) || uncertainRetry);
  const dismissAmount = () => {
    amountInputRef.current?.blur();
    inputScroll.onInputBlur();
    Keyboard.dismiss();
  };
  const execute = () => {
    if (!canExecute || !source?.id || !destination?.id || !canonicalAmount || mutation.isPending ||
        attempt.current?.running || attempt.current?.completed || !isTransferResponseInScope(scope, readScope())) return;
    const previous = attempt.current;
    const command: TransferCommand = sameIntent(previous) ? previous : { ...scope,
      futuresCollateral: sourceIsFutures || destinationIdentity.scope === 'crypto_futures',
      body: { sourceWalletId: source.id, destinationWalletId: destination.id, amount: canonicalAmount, idempotencyKey: createIdempotencyKey('wallet-transfer') },
    };
    // Fence synchronously, before React Query updates the pending observer.
    command.running = true; attempt.current = command;
    dismissAmount(); setOpenDropdown(null); setFailure(null);
    mutation.mutate(command);
  };
  // What the beginner quest guide may point at next; it reads, never drives.
  useEffect(() => {
    publishQuestGuideFacts('transfer', {
      screen: 'transfer',
      accountId: account.id,
      blocked: !!block,
      source: sourceIdentity.scope,
      destination: destinationIdentity.scope,
      amountValid: !!canonicalAmount,
      amountFits: transferAmountFits(canonicalAmount, available),
      nothingToSend: available !== null && !/[1-9]/.test(available),
      canExecute,
      pending: locked,
      failed: !!failure,
      succeeded: !!result,
    });
  });
  const { revealView } = inputScroll;
  useEffect(() => {
    registerQuestGuideReveal('transfer', node => revealView(node, 'start'));
    return () => {
      registerQuestGuideReveal('transfer', null);
      publishQuestGuideFacts('transfer', null);
    };
  }, [revealView]);

  const toggleDropdown = (kind: 'source' | 'destination') => {
    if (locked || attempt.current?.running) return;
    dismissAmount();
    setOpenDropdown(current => current === kind ? null : kind);
  };
  const chooseWallet = (kind: 'source' | 'destination', wallet: UsdWalletIdentity) => {
    if (locked || attempt.current?.running || wallet.key === (kind === 'source' ? destinationKey : sourceKey)) return;
    if (wallet.key !== (kind === 'source' ? sourceKey : destinationKey)) attempt.current = null;
    if (kind === 'source') setSourceKey(wallet.key); else setDestinationKey(wallet.key);
    setOpenDropdown(null); setFailure(null);
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View ref={questGuideTarget('transfer-viewport')} collapsable={false} style={styles.screen}>
        <ScrollView testID="wallet-transfer-screen" ref={inputScroll.scrollRef} onLayout={inputScroll.revealFocusedInput}
          onContentSizeChange={inputScroll.revealFocusedInput} onScroll={inputScroll.onScroll} scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="none" contentContainerStyle={styles.content}>
          {result ? (
            <View testID="wallet-transfer-success" style={styles.card} accessibilityLiveRegion="polite">
              <Text style={styles.heading}>이체가 완료되었습니다.</Text>
              <Text style={styles.body}>{WALLET_SCOPE_LABELS[result.source.walletScope]} USD → {WALLET_SCOPE_LABELS[result.destination.walletScope]} USD</Text>
              <Text style={styles.money}>보낸 금액: USD {formatDisplayDecimal(result.amount)}</Text>
              <Text style={styles.body}>보내는 지갑 잔액: USD {formatDisplayDecimal(result.source.balanceAfter)}</Text>
              <Text style={styles.body}>받는 지갑 잔액: USD {formatDisplayDecimal(result.destination.balanceAfter)}</Text>
              <CTAButton label="다른 이체하기" onPress={() => { setResult(null); setAmount(''); attempt.current = null; }} />
            </View>
          ) : integrity ? <ErrorState error={integrity.error} diagnosticRuntime={integrity.error === failure ? failureRuntime : undefined} title={ACCOUNT_INTEGRITY_TITLE} message={integrity.message} onRetry={integrity.retry} />
            : wallets.isLoading ? <FullPageLoading message="지갑 잔액을 불러오는 중입니다." />
              : wallets.isError || !wallets.data ? <ErrorState error={wallets.error} title="지갑 잔액을 불러오지 못했습니다." onRetry={() => void wallets.refetch()} />
                : !hasAllWallets || (!sourceIsFutures && available === null) ? <ErrorState title={ACCOUNT_INTEGRITY_TITLE} message="지갑 정보를 확인할 수 없어 이체를 중단했습니다." onRetry={() => void wallets.refetch()} />
                  : <>
                    {block ? <Text testID="wallet-transfer-blocked" style={styles.error}>{block}</Text> : null}
                    <WalletSelector kind="source" selected={sourceIdentity} excludedKey={destinationKey} expanded={openDropdown === 'source'} disabled={locked} onToggle={() => toggleDropdown('source')} onSelect={wallet => chooseWallet('source', wallet)} />
                    <WalletSelector kind="destination" selected={destinationIdentity} excludedKey={sourceKey} expanded={openDropdown === 'destination'} disabled={locked} onToggle={() => toggleDropdown('destination')} onSelect={wallet => chooseWallet('destination', wallet)} />
                    <View style={styles.card}>
                      <Text style={styles.heading}>이체 금액 (USD)</Text>
                      <View ref={questGuideTarget('transfer-amount')} collapsable={false} testID="wallet-transfer-amount-field">
                      <View ref={amountRef} collapsable={false}>
                        <TextInput ref={amountInputRef} testID="wallet-transfer-amount" accessibilityLabel="이체 금액 USD" value={amount}
                          onFocus={() => { setOpenDropdown(null); inputScroll.onInputFocus(amountRef.current); }} onBlur={inputScroll.onInputBlur}
                          onChangeText={value => {
                            if (locked || attempt.current?.running) return;
                            if (parseTransferAmount(value) !== canonicalAmount) attempt.current = null;
                            setAmount(value); setFailure(null);
                          }}
                          editable={!locked} keyboardType="decimal-pad" placeholder="0" style={styles.input} />
                      </View>
                      </View>
                      {sourceIsFutures && futures.isError && !futures.isFetching ? <ErrorNotice error={futures.error}
                        message="현재 선물 지갑의 이체 가능 금액을 확인할 수 없습니다." testID="wallet-transfer-available" style={styles.money} /> : <Text ref={questGuideTarget('transfer-available')} testID="wallet-transfer-available" style={styles.money}>
                        {available !== null ? '이체 가능 금액: USD ' + formatDisplayDecimal(available)
                          : futures.isFetching ? '이체 가능 금액을 확인하고 있습니다.' : '현재 선물 지갑의 이체 가능 금액을 확인할 수 없습니다.'}
                      </Text>}
                      {sourceIsFutures && available === null && !futures.isFetching ? <CTAButton label="이체 가능 금액 다시 확인" variant="neutral" state={locked ? 'disabled' : 'enabled'} onPress={() => void futures.refetch()} /> : null}
                      {amount && !canonicalAmount ? <Text style={styles.error}>0보다 큰 금액을 소수점 8자리까지 입력해주세요.</Text>
                        : canonicalAmount && available !== null && !transferAmountFits(canonicalAmount, available) && !uncertainRetry ? <Text style={styles.error}>이체 가능 금액을 초과했습니다.</Text> : null}
                    </View>
                    {failure ? <ErrorNotice error={failure} message={attempt.current?.uncertain ? '이체 결과를 확인하지 못했습니다. 원장을 확인하거나 같은 요청으로 다시 확인해주세요.' : transferErrorMessage(getApiErrorCode(failure))} runtime={failureRuntime} testID="wallet-transfer-error" style={styles.error} /> : null}
                    <View ref={inputScroll.submitRef} collapsable={false}>
                      <View ref={questGuideTarget('transfer-submit')} collapsable={false}>
                        <CTAButton testID="wallet-transfer-submit" label="이체하기" state={locked ? 'loading' : canExecute ? 'enabled' : 'disabled'} onPress={execute} />
                      </View>
                    </View>
                  </>}
        </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function WalletSelector({ kind, selected, excludedKey, expanded, disabled, onToggle, onSelect }: {
  kind: 'source' | 'destination';
  selected: UsdWalletIdentity;
  excludedKey: UsdWalletIdentity['key'];
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onSelect: (wallet: UsdWalletIdentity) => void;
}) {
  const { colors } = useAppearance();
  const title = kind === 'source' ? '보내는 지갑' : '받는 지갑';
  return <View ref={questGuideTarget(kind === 'source' ? 'transfer-source' : 'transfer-destination')} testID={'wallet-transfer-' + kind + '-card'} style={styles.card}>
    <Text style={styles.heading}>{title}</Text>
    <ActionPressable testID={'wallet-transfer-' + kind + '-selector'} accessibilityRole="button" accessibilityLabel={title + ': ' + walletLabel(selected)}
      accessibilityState={{ expanded, disabled }} aria-expanded={expanded} disabled={disabled} onPress={onToggle} style={[styles.selector, disabled && styles.disabled]}>
      <Text style={styles.selection}>{walletLabel(selected)}</Text>
      <View accessible={false} style={[styles.indicator, expanded && styles.expandedIndicator]}>
        <Svg width={16} height={16} viewBox="0 0 16 16"><Path d="M3 6h10l-5 5z" fill={colors.secondary} /></Svg>
      </View>
    </ActionPressable>
    {expanded ? <View testID={'wallet-transfer-' + kind + '-options'} style={styles.options}>
      {USD_TRANSFER_WALLETS.filter(wallet => wallet.key !== excludedKey).map(wallet => (
        <ActionPressable key={wallet.key} testID={'wallet-transfer-' + kind + '-' + wallet.key} accessibilityRole="button"
          accessibilityLabel={walletLabel(wallet) + ' 선택'} accessibilityState={{ selected: selected.key === wallet.key, disabled }}
          disabled={disabled} onPress={() => onSelect(wallet)} style={[styles.option, selected.key === wallet.key && styles.selected]}>
          <Text style={styles.body}>{walletLabel(wallet)}</Text>
        </ActionPressable>
      ))}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 12 },
  heading: { fontSize: 16, lineHeight: 25, fontWeight: '600' },
  body: { fontSize: 14, lineHeight: 22, flexShrink: 1 },
  money: { fontSize: 16, lineHeight: 25, fontVariant: ['tabular-nums'], flexShrink: 1 },
  error: { color: semantic.warning, fontSize: 14, lineHeight: 23 },
  selector: { minHeight: 52, padding: 12, borderWidth: 1, borderColor: semantic.border, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  selection: { fontSize: 16, lineHeight: 25, flex: 1, minWidth: 0, flexShrink: 1 },
  indicator: { width: 20, alignItems: 'center', flexShrink: 0 },
  expandedIndicator: { transform: [{ rotate: '180deg' }] },
  options: { gap: 8 },
  option: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: semantic.border, borderRadius: 10, justifyContent: 'center' },
  selected: { borderColor: semantic.selected, backgroundColor: semantic.raised },
  disabled: { opacity: 0.5 },
  input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 10, padding: 12, fontSize: 18, minHeight: 52 },
});
