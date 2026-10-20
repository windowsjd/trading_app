import type { GuideChapter } from '../../screens/guide/guideTopics';
import type { RecordOrderAccountScope } from '../../features/record/seasonAccountLookup';
import type { OrderFailureKind } from '../../features/notifications/orderFailure';
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
  PasswordReset: { email?: string } | undefined;
  /** After a confirmed 회원탈퇴: the server receipt (no key, no user data). */
  MembershipDeletionResult: {
    status: 'cleanup_pending' | 'completed';
    deletedAt: string;
    completedAt: string | null;
  };
};

export type HomeStackParamList = {
  Home: undefined;
  Portfolio: undefined;
};

export type WalletStackParamList = {
  // 이체 and 환전 are bottom sheets (WalletFundingSheet) over Wallet or an order
  // screen, not routes; a quest guard names them WalletTransfer / WalletFx.
  Wallet: undefined;
  WalletTransactions: { currencyCode?: 'KRW' | 'USD' } | undefined;
};

export type MarketStackParamList = {
  /** `direction`: the new entry the detail's 매수하기 (long) / 매도하기 (short) asked for. */
  Futures: { accountId: string; instrumentId?: string; direction?: 'long' | 'short' };
  FuturesDetail: { accountId: string; instrumentId: string };
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
  EtfIndex: undefined;
  GuideChapter: { chapter: GuideChapter };
};

export type RecordStackParamList = {
  RecordSeasonList: undefined;
  RecordSeasonDetail: { seasonId: string };
  RecordProfitAnalysis: { seasonId: string };
};

export type MyStackParamList = {
  Overall: undefined;
  Record: NavigatorScreenParams<RecordStackParamList> | undefined;
  /** `tab: 'requests'` opens 받은 요청 (friend-request push); `pushAt`
   * changes per tap so a repeated tap selects it again. */
  Friends: { tab?: 'requests'; pushAt?: number } | undefined;
  /** `noticeId` opens and scrolls to that notice (links from guides, pushes). */
  Notices: { noticeId?: string; pushAt?: number } | undefined;
  Inquiry: undefined;
  /** 문의 관리 (operator/admin): one inquiry and its official answer. */
  InquiryAnswer: { inquiryId: string };
  UserSeasonSummary: { userId: string };
  My: undefined;
  /** 내 뱃지: my settled seasons' final tier, rank and return. */
  Badges: undefined;
  Reward: undefined;
  Settings: undefined;
  /** 회원탈퇴 (안내 → 본인 확인 → 최종 확인). */
  MembershipDeletion: undefined;
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
  /** `market`/`futuresView` preselect the 현물|선물 and 체결|강제청산 views
   * (push taps); the account stays the route's own subject. */
  TradeHistory: RecordOrderAccountScope & {
    market?: 'spot' | 'futures';
    futuresView?: 'executions' | 'liquidations';
    /** Changes per push tap, so a repeated tap selects its view again. */
    pushAt?: number;
  };
  /** 주문 실패·만료: the one failure row an order_failure push names. */
  OrderFailure: {
    accountId: string;
    kind: OrderFailureKind;
    failureId: string;
    /** Changes per push tap, so a repeated tap reads the row again. */
    pushAt?: number;
  };
  AssetChart: { assetId: string };
  /** Full-screen 4h chart of one futures contract (the futures screen's chart
   * button). `accountId` only reads that account's contract list for the
   * current Futures Last line; the candles are account-free market data. */
  FuturesChart: {
    accountId: string;
    instrumentId: string;
    symbol: string;
    displayPriceDecimals: number | null;
  };
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
  /**
   * 시즌최종결과 of one season: settlement's stored result for me (never a
   * current-price read). Showing a result records my first view of it.
   */
  SeasonFinalResult: { seasonId: string };
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

export type PasswordResetScreenProps = NativeStackScreenProps<AuthStackParamList, 'PasswordReset'>;
export type MembershipDeletionResultScreenProps = NativeStackScreenProps<AuthStackParamList, 'MembershipDeletionResult'>;

export type SignupScreenProps = NativeStackScreenProps<
  AuthStackParamList,
  'Signup'
>;

export type SeasonJoinScreenProps = RootScreenProps<'SeasonJoin'>;

export type SeasonFinalResultScreenProps = RootScreenProps<'SeasonFinalResult'>;

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

export type MyBadgesScreenProps = CompositeScreenProps<
  StackScreenProps<MyStackParamList, 'Badges'>,
  CompositeScreenProps<TabScreenProps<'MyTab'>, RootScreenProps<'MainTabs'>>
>;

export type FuturesScreenProps = CompositeScreenProps<
  StackScreenProps<MarketStackParamList, 'Futures'>,
  CompositeScreenProps<TabScreenProps<'MarketTab'>, RootScreenProps<'MainTabs'>>
>;

export type FuturesDetailScreenProps = CompositeScreenProps<
  StackScreenProps<MarketStackParamList, 'FuturesDetail'>,
  CompositeScreenProps<TabScreenProps<'MarketTab'>, RootScreenProps<'MainTabs'>>
>;

export type FuturesChartScreenProps = RootScreenProps<'FuturesChart'>;
