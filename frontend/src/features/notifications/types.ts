/**
 * Push notification switches (backend docs/push-notifications-contract.md).
 * The server stores them per user; the device's OS permission is a separate
 * state the app reads from the system.
 */
export const NOTIFICATION_PREFERENCE_KEYS = [
  'tradeFill',
  'futuresLiquidation',
  'orderFailure',
  'friendRequest',
  'importantNotice',
  'seasonFinalResult',
  'seasonEndingSoon',
] as const;

export type NotificationPreferenceKey = (typeof NOTIFICATION_PREFERENCE_KEYS)[number];
export type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;

/** Settings order and copy. */
export const NOTIFICATION_PREFERENCE_ITEMS: ReadonlyArray<{
  key: NotificationPreferenceKey;
  label: string;
  description: string;
}> = [
  { key: 'tradeFill', label: '거래 체결', description: '현물·선물 주문이 실제로 체결되면 알려드려요.' },
  { key: 'futuresLiquidation', label: '선물 강제청산', description: '선물 포지션이 강제청산되면 알려드려요.' },
  { key: 'orderFailure', label: '주문 실패·만료', description: '조건주문·손절가/익절가·LOC가 최종 실패하거나 만료되면 알려드려요.' },
  { key: 'friendRequest', label: '친구 요청', description: '새 친구 요청을 받으면 알려드려요.' },
  { key: 'importantNotice', label: '주요 공지사항', description: '운영팀이 중요 공지로 발행한 소식을 알려드려요.' },
  { key: 'seasonFinalResult', label: '최종 순위·등급 확정', description: '참가한 시즌의 최종 순위와 등급이 확정되면 알려드려요.' },
  { key: 'seasonEndingSoon', label: '시즌 종료 임박', description: '참가 중인 시즌이 끝나기 24시간 전에 알려드려요.' },
];

export type PushNotificationType =
  | 'trade_fill'
  | 'futures_liquidation'
  | 'order_failure'
  | 'friend_request'
  | 'important_notice'
  | 'season_final_result'
  | 'season_ending_soon';

/** The device's notification permission as the app uses it. */
export type DevicePushPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported';
