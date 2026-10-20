import React from 'react';
import ModeEntryCard from './ModeEntryCard';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { useOpenBeginnerAccount } from '../../features/tradingAccount/useOpenGeneralAccount';

/** Explicit beginner creation or selection for every authenticated user. */
export default function BeginnerAccountEntry({ onEntered }: { onEntered: () => void }) {
  const { accounts, selectAccount } = useTradingAccount();
  const existing = accounts.find(account => account.mode === 'beginner');
  const open = useOpenBeginnerAccount({ onOpened: onEntered });
  return (
    <ModeEntryCard
      testID="beginner-account-entry"
      title="초보모드"
      description="퀘스트를 따라 투자의 기초부터 다양한 거래 방법까지 단계별로 연습합니다."
      descriptionTestID="beginner-account-description"
      actionTestID="beginner-account-start"
      actionLabel={existing ? '초보모드 계속하기' : '초보모드 계정만들기'}
      pending={open.isPending}
      onPress={existing ? () => { selectAccount(existing.id); onEntered(); } : open.start}
      error={open.error}
      errorTestID="beginner-account-error"
    />
  );
}
