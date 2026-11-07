import type { CommunityModerationReason } from '../generated/prisma/client';

/**
 * Community limits and rules in one place (docs/community-api-contract.md).
 * Changing a number here changes the behaviour; nothing else repeats them.
 */

/** Raise when the rule text changes: every member must accept it again. */
export const COMMUNITY_RULES_VERSION = '2026-11-07';

export const COMMUNITY_POST_BODY_MAX = 500;
export const COMMUNITY_COMMENT_BODY_MAX = 300;
export const COMMUNITY_NOTE_MAX = 200;
export const COMMUNITY_MAX_PHOTOS = 4;
export const COMMUNITY_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const COMMUNITY_PHOTO_MAX_DIMENSION = 1600;
/** The app's createIdempotencyKey output fits this. */
export const COMMUNITY_CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/u;
export const COMMUNITY_ID_MAX_LENGTH = 100;

export const COMMUNITY_FEED_PAGE = { defaultLimit: 20, maxLimit: 50 } as const;
export const COMMUNITY_COMMENT_PAGE = {
  defaultLimit: 50,
  maxLimit: 100,
} as const;
export const COMMUNITY_MAX_OFFSET = 10_000;

/** DB-count rate limits (best effort under concurrency, like inquiries). */
export const COMMUNITY_RATE_LIMITS = {
  post: { count: 5, windowMs: 10 * 60_000 },
  comment: { count: 20, windowMs: 10 * 60_000 },
  report: { count: 10, windowMs: 60 * 60_000 },
} as const;
/** The same text by the same member within this window is refused. */
export const COMMUNITY_DUPLICATE_WINDOW_MS = 10 * 60_000;

/** Upload lease: far longer than one storage write (10 s abort). */
export const COMMUNITY_PHOTO_UPLOAD_LEASE_MS = 10 * 60_000;
/** Shorter than profile photos: a removal stops being served within this. */
export const COMMUNITY_PHOTO_CACHE_CONTROL = 'public, max-age=3600';
export const COMMUNITY_PHOTO_KEY_PREFIX = 'community-images/';

export const COMMUNITY_SANCTION_DURATIONS = {
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
  permanent: null,
} as const;
export type CommunitySanctionDuration =
  keyof typeof COMMUNITY_SANCTION_DURATIONS;

/** Retention (2026-11-07 decision, contract §13). */
export const COMMUNITY_RETENTION = {
  authorDeletedDays: 30,
  operatorRemovedDays: 365,
  reportDays: 365,
  /** A permanent sanction's carryover lives this long after the deletion. */
  permanentCarryoverYears: 3,
} as const;

/** Messenger/open-chat invitation hosts refused in bodies (with any URL). */
export const COMMUNITY_BLOCKED_LINK_DOMAINS = [
  'open.kakao.com',
  'pf.kakao.com',
  't.me',
  'telegram.me',
  'discord.gg',
  'discord.com/invite',
  'line.me',
  'band.us',
] as const;

export type CommunityReasonDefinition = {
  code: CommunityModerationReason;
  label: string;
  description: string;
  /** Operator removal and sanctions need a note for this reason. */
  noteRequired: boolean;
};

/** The single list shared by removal, sanctions, reports and the app. */
export const COMMUNITY_MODERATION_REASONS: readonly CommunityReasonDefinition[] =
  [
    {
      code: 'AD_SPAM',
      label: '광고·리딩방',
      description:
        '상품·서비스 광고, 유료 리딩방, 카카오 오픈채팅·텔레그램 등 외부 유도, 외부 링크',
      noteRequired: false,
    },
    {
      code: 'ABUSE',
      label: '욕설·비방',
      description: '욕설, 특정인·집단에 대한 비방·조롱·혐오, 인신공격',
      noteRequired: false,
    },
    {
      code: 'FLOOD',
      label: '도배',
      description: '같은 내용 반복, 의미 없는 글 연속 게시',
      noteRequired: false,
    },
    {
      code: 'PERSONAL_INFO',
      label: '개인정보',
      description:
        '연락처·실명·계좌·SNS 계정 등 본인 또는 타인을 식별하는 정보(사진 속 포함)',
      noteRequired: false,
    },
    {
      code: 'ILLEGAL_OR_SOLICITATION',
      label: '불법·종목 선동',
      description:
        '불법 정보, 특정 종목 매수·매도 선동, 시세 조작 유도, 사행성',
      noteRequired: false,
    },
    {
      code: 'INAPPROPRIATE_MEDIA',
      label: '부적절한 사진',
      description: '선정적·폭력적·혐오 이미지, 타인 저작물 무단 사용',
      noteRequired: false,
    },
    {
      code: 'OTHER',
      label: '기타',
      description: '그 밖의 이용약관·운영정책 위반',
      noteRequired: true,
    },
  ];

export const COMMUNITY_REASON_CODES = COMMUNITY_MODERATION_REASONS.map(
  (reason) => reason.code,
);

export function isCommunityReason(
  value: unknown,
): value is CommunityModerationReason {
  return (
    typeof value === 'string' &&
    (COMMUNITY_REASON_CODES as readonly string[]).includes(value)
  );
}

export const ANONYMOUS_LABEL = '익명';
export const DELETED_MEMBER_LABEL = '탈퇴계정';
