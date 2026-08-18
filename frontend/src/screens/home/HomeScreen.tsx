import React from 'react';
import { StyleSheet, SafeAreaView, View } from 'react-native';

import type { HomeScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';

import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import AccountSetupPanel from '../../components/tradingAccount/AccountSetupPanel';
import GeneralAccountHome from './GeneralAccountHome';
import SeasonAccountHome from './SeasonAccountHome';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';

type Props = HomeScreenProps;

/**
 * Home is ABOUT THE SELECTED ACCOUNT — and nothing else (작업 11 §10).
 *
 * This screen used to be the season dashboard with an account switcher bolted
 * on top: it called `/home`, which resolves the CURRENT season's participant on
 * the server, and then displayed the answer under whichever account name the
 * switcher happened to show. The two agree only while the selected account is
 * the current season's. Select a settled season's account — which the selection
 * policy itself can do — and the screen showed one season's name over another
 * season's money.
 *
 * So the screen no longer asks "what is the current season?" at all. It asks
 * "which account is selected?" and hands off:
 *
 *   - no accounts  → the setup panel, which can open a general account;
 *   - general      → `GeneralAccountHome` (TWR, funding breakdown, no season UI);
 *   - season       → `SeasonAccountHome` (that season's rank, tier and return).
 *
 * Both branches read account-scoped endpoints only. The season branch names its
 * `seasonId` explicitly when it asks for a rank.
 */
export default function HomeScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const {
    selectedAccount,
    capabilities,
    isLoading: accountsLoading,
    isError: accountsError,
    isEmpty: noAccounts,
    refetchAccounts,
  } = useTradingAccount();

  if (accountsLoading) {
    return <FullPageLoading message="홈 정보를 불러오는 중입니다." />;
  }

  if (accountsError) {
    // "We could not read your accounts" is not "you have none": offering the
    // setup panel here would invite a second account on a network blip.
    return (
      <ErrorState
        title="계정 정보를 불러오지 못했습니다."
        message="네트워크 상태를 확인한 뒤 다시 시도해주세요."
        onRetry={() => void refetchAccounts()}
      />
    );
  }

  if (noAccounts || !selectedAccount) {
    return (
      <AccountSetupPanel
        message="투자 계정을 열면 잔고와 수익률을 확인할 수 있습니다. 일반 투자 계정은 시즌과 무관하게 유지되고, 시즌이 열리면 별도로 참가할 수 있습니다."
        onOpened={() => navigation.navigate('Home')}
        seasonAction={{
          label: '시즌 참가 화면으로 이동',
          onPress: () => rootNavigation.navigate('SeasonJoin'),
        }}
      />
    );
  }

  const openAsset = (assetId: string) =>
    rootNavigation.navigate('MainTabs', {
      screen: 'MarketTab',
      params: { screen: 'AssetDetail', params: { assetId } },
    });

  return (
    <SafeAreaView style={styles.container}>
      {/* Which account every number below belongs to — always on screen, and
          on every state, so no blocked view is a dead end. */}
      <View style={styles.switcherHeader}>
        <AccountSwitcher />
      </View>

      {selectedAccount.mode === 'general' ? (
        <GeneralAccountHome
          account={selectedAccount}
          capabilities={capabilities}
          onOpenLedger={() => navigation.navigate('WalletTransactions')}
          onOpenOrders={() =>
            rootNavigation.navigate('MainTabs', {
              screen: 'RecordTab',
              params: {
                screen: 'RecordOrderList',
                params: { accountId: selectedAccount.id },
              },
            })
          }
        />
      ) : (
        <SeasonAccountHome
          account={selectedAccount}
          capabilities={capabilities}
          onOpenLedger={() => navigation.navigate('WalletTransactions')}
          onOpenFx={() => navigation.navigate('WalletFx')}
          onOpenPortfolio={() => navigation.navigate('Portfolio')}
          onOpenMarket={() =>
            rootNavigation.navigate('MainTabs', {
              screen: 'MarketTab',
              params: { screen: 'Market' },
            })
          }
          onOpenRanking={() =>
            rootNavigation.navigate('MainTabs', {
              screen: 'RankingTab',
              params: { screen: 'Ranking' },
            })
          }
          onOpenReward={() =>
            rootNavigation.navigate('MainTabs', {
              screen: 'MyTab',
              params: { screen: 'Reward' },
            })
          }
          onOpenAsset={openAsset}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  switcherHeader: { paddingHorizontal: 16, paddingTop: 12 },
});
