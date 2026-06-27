import type {
  CompositeScreenProps,
  NavigatorScreenParams,
  ParamListBase,
} from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

export type HomeStackParamList = {
  Home: undefined;
  Portfolio: undefined;
  WalletFx: undefined;
  WalletTransactions: { currencyCode?: 'KRW' | 'USD' } | undefined;
};

export type MarketStackParamList = {
  Market: undefined;
  MarketSearch: undefined;
  AssetDetail: { assetId: string };
  Order: { assetId: string; side?: 'buy' | 'sell' };
};

export type RankingStackParamList = {
  Ranking: undefined;
  UserSeasonSummary: { userId: string };
};

export type RecordStackParamList = {
  RecordSeasonList: undefined;
  RecordSeasonDetail: { seasonId: string };
  RecordProfitAnalysis: { seasonId: string };
  RecordOrderList: { seasonId: string };
  RecordExchangeList: { seasonId: string };
};

export type MyStackParamList = {
  My: undefined;
  Reward: undefined;
  Settings: undefined;
};

export type MainTabParamList = {
  HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined;
  MarketTab: NavigatorScreenParams<MarketStackParamList> | undefined;
  RankingTab: NavigatorScreenParams<RankingStackParamList> | undefined;
  RecordTab: NavigatorScreenParams<RecordStackParamList> | undefined;
  MyTab: NavigatorScreenParams<MyStackParamList> | undefined;
};

export type RootStackParamList = {
  Splash: undefined;
  AuthStack: NavigatorScreenParams<AuthStackParamList> | undefined;
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  SeasonJoin: undefined;
};

type RootScreenProps<RouteName extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, RouteName>;

type TabScreenProps<RouteName extends keyof MainTabParamList> =
  BottomTabScreenProps<MainTabParamList, RouteName>;

type StackScreenProps<
  StackParamList extends ParamListBase,
  RouteName extends keyof StackParamList,
> = NativeStackScreenProps<StackParamList, RouteName>;

export type RootNavigationProp =
  NativeStackNavigationProp<RootStackParamList>;

export type SplashScreenProps = RootScreenProps<'Splash'>;

export type LoginScreenProps = NativeStackScreenProps<
  AuthStackParamList,
  'Login'
>;

export type SignupScreenProps = NativeStackScreenProps<
  AuthStackParamList,
  'Signup'
>;

export type SeasonJoinScreenProps = RootScreenProps<'SeasonJoin'>;

export type HomeScreenProps = CompositeScreenProps<
  StackScreenProps<HomeStackParamList, 'Home'>,
  CompositeScreenProps<TabScreenProps<'HomeTab'>, RootScreenProps<'MainTabs'>>
>;

export type PortfolioScreenProps = CompositeScreenProps<
  StackScreenProps<HomeStackParamList, 'Portfolio'>,
  CompositeScreenProps<TabScreenProps<'HomeTab'>, RootScreenProps<'MainTabs'>>
>;

export type WalletFxScreenProps = CompositeScreenProps<
  StackScreenProps<HomeStackParamList, 'WalletFx'>,
  CompositeScreenProps<TabScreenProps<'HomeTab'>, RootScreenProps<'MainTabs'>>
>;

export type WalletTransactionsScreenProps = CompositeScreenProps<
  StackScreenProps<HomeStackParamList, 'WalletTransactions'>,
  CompositeScreenProps<TabScreenProps<'HomeTab'>, RootScreenProps<'MainTabs'>>
>;

export type MarketScreenProps = CompositeScreenProps<
  StackScreenProps<MarketStackParamList, 'Market'>,
  CompositeScreenProps<TabScreenProps<'MarketTab'>, RootScreenProps<'MainTabs'>>
>;

export type AssetDetailScreenProps = CompositeScreenProps<
  StackScreenProps<MarketStackParamList, 'AssetDetail'>,
  CompositeScreenProps<TabScreenProps<'MarketTab'>, RootScreenProps<'MainTabs'>>
>;

export type OrderScreenProps = CompositeScreenProps<
  StackScreenProps<MarketStackParamList, 'Order'>,
  CompositeScreenProps<TabScreenProps<'MarketTab'>, RootScreenProps<'MainTabs'>>
>;

export type RankingScreenProps = CompositeScreenProps<
  StackScreenProps<RankingStackParamList, 'Ranking'>,
  CompositeScreenProps<TabScreenProps<'RankingTab'>, RootScreenProps<'MainTabs'>>
>;

export type UserSeasonSummaryScreenProps = CompositeScreenProps<
  StackScreenProps<RankingStackParamList, 'UserSeasonSummary'>,
  CompositeScreenProps<TabScreenProps<'RankingTab'>, RootScreenProps<'MainTabs'>>
>;

export type RecordSeasonListScreenProps = CompositeScreenProps<
  StackScreenProps<RecordStackParamList, 'RecordSeasonList'>,
  CompositeScreenProps<TabScreenProps<'RecordTab'>, RootScreenProps<'MainTabs'>>
>;

export type MyScreenProps = CompositeScreenProps<
  StackScreenProps<MyStackParamList, 'My'>,
  CompositeScreenProps<TabScreenProps<'MyTab'>, RootScreenProps<'MainTabs'>>
>;
