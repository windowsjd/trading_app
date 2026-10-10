import type { GuideChapter } from '../../screens/guide/guideTopics';
import type { BeginnerQuestId } from '../../features/quest/questProgress';
import type { RecordOrderAccountScope } from '../../features/record/seasonAccountLookup';
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
};

export type WalletStackParamList = {
  WalletTransfer: undefined;
  Wallet: undefined;
  WalletFx: undefined;
  WalletTransactions: { currencyCode?: 'KRW' | 'USD' } | undefined;
};

export type MarketStackParamList = {
  Futures: { accountId: string; instrumentId?: string };
  Market: { assetType?: import('../../features/market/api').AssetType } | undefined;
  MarketSearch: { returnToAsset?: boolean; sort?: import('../../features/market/marketSort').MarketSort } | undefined;
  AssetDetail: { assetId: string };
  /**
   * `accountId` is REQUIRED, not optional (작업 10 §A-2).
   *
   * An order flow is about exactly one account, decided when the user opened
   * the screen. If the screen instead read "whichever account is selected right
   * now", a switch made while a quote was on screen would silently retarget the
   * next create — the user would press 주문 on numbers quoted for their season
   * account and move money in their general one. Carrying the id in the route
   * makes the target immutable for the life of the screen, and makes a
   * mismatch with the current selection detectable rather than invisible.
   */
  Order: { assetId: string; accountId: string; side?: 'buy' | 'sell' };
};

export type RankingStackParamList = {
  Ranking: undefined;
  UserSeasonSummary: { userId: string };
};

export type GuideStackParamList = {
  Guide: undefined;
  MarketBasics: undefined;
  OrderBookLesson: undefined;
  Liquidity: undefined;
  Candles: undefined;
  OrderTypes: undefined;
  StockCharacteristics: undefined;
  CorporateActions: undefined;
  EtfIndex: undefined;
  GuideChapter: { chapter: GuideChapter };
  /** Registered only in the beginner QuestStack. */
  QuestDetail: { questId: BeginnerQuestId };
};

export type RecordStackParamList = {
  RecordSeasonList: undefined;
  RecordSeasonDetail: { seasonId: string };
  RecordProfitAnalysis: { seasonId: string };
};

export type MyStackParamList = {
  Overall: undefined;
  Record: NavigatorScreenParams<RecordStackParamList> | undefined;
  Friends: undefined;
  Notices: undefined;
  UserSeasonSummary: { userId: string };
  My: undefined;
  Reward: undefined;
  Settings: undefined;
};

export type MainTabParamList = {
  QuestTab: NavigatorScreenParams<GuideStackParamList>;
  HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined;
  MarketTab: NavigatorScreenParams<MarketStackParamList> | undefined;
  GuideTab: NavigatorScreenParams<GuideStackParamList> | undefined;
  RankingTab: NavigatorScreenParams<RankingStackParamList> | undefined;
  WalletTab: NavigatorScreenParams<WalletStackParamList> | undefined;
  MyTab: NavigatorScreenParams<MyStackParamList> | undefined;
};

export type RootStackParamList = {
  TradeHistory: RecordOrderAccountScope;
  AssetChart: { assetId: string };
  Splash: undefined;
  AuthStack: NavigatorScreenParams<AuthStackParamList> | undefined;
  /**
   * Every fresh authentication lands here to choose 일반 투자 vs 시즌 투자
   * (작업 13 §2). Also serves the "owns no account yet" state, so there is no
   * separate account-setup route.
   */
  ModeSelection: undefined;
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

export type ModeSelectionScreenProps = RootScreenProps<'ModeSelection'>;

export type HomeScreenProps = CompositeScreenProps<
  StackScreenProps<HomeStackParamList, 'Home'>,
  CompositeScreenProps<TabScreenProps<'HomeTab'>, RootScreenProps<'MainTabs'>>
>;

export type PortfolioScreenProps = CompositeScreenProps<
  StackScreenProps<HomeStackParamList, 'Portfolio'>,
  CompositeScreenProps<TabScreenProps<'HomeTab'>, RootScreenProps<'MainTabs'>>
>;

export type WalletScreenProps = CompositeScreenProps<
  StackScreenProps<WalletStackParamList, 'Wallet'>,
  CompositeScreenProps<TabScreenProps<'WalletTab'>, RootScreenProps<'MainTabs'>>
>;

export type WalletFxScreenProps = CompositeScreenProps<
  StackScreenProps<WalletStackParamList, 'WalletFx'>,
  CompositeScreenProps<TabScreenProps<'WalletTab'>, RootScreenProps<'MainTabs'>>
>;

export type WalletTransactionsScreenProps = CompositeScreenProps<
  StackScreenProps<WalletStackParamList, 'WalletTransactions'>,
  CompositeScreenProps<TabScreenProps<'WalletTab'>, RootScreenProps<'MainTabs'>>
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

export type GuideScreenProps = CompositeScreenProps<
  StackScreenProps<GuideStackParamList, 'Guide'>,
  CompositeScreenProps<TabScreenProps<'GuideTab'>, RootScreenProps<'MainTabs'>>
>;

export type QuestDetailScreenProps = CompositeScreenProps<
  StackScreenProps<GuideStackParamList, 'QuestDetail'>,
  CompositeScreenProps<TabScreenProps<'QuestTab'>, RootScreenProps<'MainTabs'>>
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
  CompositeScreenProps<
    StackScreenProps<MyStackParamList, 'Record'>,
    CompositeScreenProps<TabScreenProps<'MyTab'>, RootScreenProps<'MainTabs'>>
  >
>;

export type RecordSeasonDetailScreenProps = CompositeScreenProps<
  StackScreenProps<RecordStackParamList, 'RecordSeasonDetail'>,
  RootScreenProps<'MainTabs'>
>;

export type RecordProfitAnalysisScreenProps = CompositeScreenProps<
  StackScreenProps<RecordStackParamList, 'RecordProfitAnalysis'>,
  RootScreenProps<'MainTabs'>
>;

export type MyScreenProps = CompositeScreenProps<
  StackScreenProps<MyStackParamList, 'My'>,
  CompositeScreenProps<TabScreenProps<'MyTab'>, RootScreenProps<'MainTabs'>>
>;

export type FuturesScreenProps = NativeStackScreenProps<MarketStackParamList, 'Futures'>;
