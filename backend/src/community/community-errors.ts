import type { HttpException } from '@nestjs/common';
import { createApiError } from '../common/api-error';

/**
 * Every community error: fixed code, status and reviewed message (each
 * message is in common/public-error-message.ts). The app picks its copy by
 * code (docs/community-api-contract.md §14).
 */
const ERRORS = {
  UNAUTHORIZED: [401, 'Unauthorized'],
  INVALID_PAGINATION: [400, 'Invalid pagination.'],
  INVALID_COMMUNITY_CATEGORY: [
    400,
    'Category must be all, free, theory or hot.',
  ],
  INVALID_COMMUNITY_SORT: [400, 'Sort must be latest or likes.'],
  INVALID_COMMUNITY_POST: [
    400,
    'Check the post category, body, anonymity, asset and request id.',
  ],
  INVALID_COMMUNITY_COMMENT: [
    400,
    'Check the comment body, anonymity, parent and request id.',
  ],
  COMMUNITY_LINK_NOT_ALLOWED: [
    400,
    'Links and messenger invitations are not allowed.',
  ],
  INVALID_COMMUNITY_PHOTO: [
    400,
    'Photos must be JPEG images of at most 1600 pixels per side.',
  ],
  COMMUNITY_TOO_MANY_PHOTOS: [400, 'A post can have at most 4 photos.'],
  COMMUNITY_PHOTO_TOO_LARGE: [413, 'Each photo must be at most 2 MiB.'],
  INVALID_COMMUNITY_REPORT: [400, 'Check the report target and reason.'],
  INVALID_COMMUNITY_RULES_VERSION: [400, 'Accept the current community rules.'],
  INVALID_COMMUNITY_MODERATION: [
    400,
    'A known moderation reason is required; OTHER also needs a note.',
  ],
  COMMUNITY_RULES_NOT_ACCEPTED: [403, 'Accept the community rules first.'],
  COMMUNITY_RESTRICTED: [
    403,
    'Community activity is restricted for this account.',
  ],
  COMMUNITY_SANCTION_TARGET_FORBIDDEN: [
    403,
    'Operators, administrators and your own account cannot be restricted.',
  ],
  COMMUNITY_POST_NOT_FOUND: [404, 'Post not found.'],
  COMMUNITY_COMMENT_NOT_FOUND: [404, 'Comment not found.'],
  COMMUNITY_SANCTION_NOT_FOUND: [404, 'Restriction not found.'],
  TARGET_USER_NOT_FOUND: [404, 'Target user not found.'],
  COMMUNITY_SELF_REACTION: [409, 'You cannot like your own post or comment.'],
  COMMUNITY_SELF_REPORT: [409, 'You cannot report your own post or comment.'],
  COMMUNITY_IDEMPOTENCY_CONFLICT: [
    409,
    'This request id was already used for different content.',
  ],
  COMMUNITY_DUPLICATE_CONTENT: [
    409,
    'The same text was posted in the last 10 minutes.',
  ],
  COMMUNITY_SANCTION_ALREADY_ACTIVE: [
    409,
    'This account is already restricted.',
  ],
  COMMUNITY_RATE_LIMITED: [429, 'Too many community actions. Try again later.'],
  COMMUNITY_PHOTO_STORAGE_UNAVAILABLE: [503, 'Photo storage is unavailable.'],
  COMMUNITY_PHOTO_UPLOAD_FAILED: [503, 'Photo upload failed. Try again.'],
  COMMUNITY_INTEGRITY: [500, 'Community data could not be verified.'],
} as const satisfies Record<string, readonly [number, string]>;

export type CommunityErrorCode = keyof typeof ERRORS;

export const COMMUNITY_ERROR_MESSAGES: readonly string[] = Object.values(
  ERRORS,
).map(([, message]) => message);

export function communityError(
  code: CommunityErrorCode,
  details?: Record<string, unknown>,
): HttpException {
  const [status, message] = ERRORS[code];
  return createApiError(code, message, status, details);
}
