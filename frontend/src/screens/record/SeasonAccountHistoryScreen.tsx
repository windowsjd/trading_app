import React from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../app/navigation/types';
import WalletStack from '../../app/navigation/WalletStack';
import { HistoricalAccountProvider } from '../../features/tradingAccount/TradingAccountContext';

/** Reuse wallet, holdings and ledger reads without changing the operating selection. */
export default function SeasonAccountHistoryScreen({ route }: NativeStackScreenProps<RootStackParamList, 'SeasonAccountHistory'>) {
  return (
    <HistoricalAccountProvider accountId={route.params.accountId}>
      <WalletStack />
    </HistoricalAccountProvider>
  );
}
