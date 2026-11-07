import { createHash } from 'node:crypto';
import { parseJpegStripMetadata } from '../auth/profile-image.validation';
import { communityError } from './community-errors';
import {
  COMMUNITY_MAX_PHOTOS,
  COMMUNITY_PHOTO_MAX_BYTES,
  COMMUNITY_PHOTO_MAX_DIMENSION,
} from './community.policy';

export type CommunityUploadedFile = {
  fieldname?: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
};

export type CommunityPhoto = {
  /** The stored bytes: validated, APPn/COM metadata (EXIF, ICC…) removed. */
  bytes: Buffer;
  width: number;
  height: number;
  byteSize: number;
  /** Hex SHA-256 of `bytes`: an idempotent replay recognises its photos. */
  sha256: string;
};

const COMMUNITY_JPEG_RULES = {
  maxDimension: COMMUNITY_PHOTO_MAX_DIMENSION,
  square: false,
  // Grayscale or YCbCr only: a CMYK/YCCK JPEG without its stripped Adobe
  // segment would render with wrong colours. The app always sends YCbCr.
  components: [1, 3],
} as const;

/**
 * Server-side photo checks (docs/community-api-contract.md §10.1); the client
 * is never trusted. Structure is checked by the shared bounded JPEG parser,
 * not decoded. Order is kept: photos[i] becomes position i.
 */
export function validateCommunityPhotos(
  files: readonly CommunityUploadedFile[] | undefined,
): CommunityPhoto[] {
  const list = files ?? [];
  if (list.length > COMMUNITY_MAX_PHOTOS)
    throw communityError('COMMUNITY_TOO_MANY_PHOTOS');
  return list.map((file) => {
    if (
      file.size > COMMUNITY_PHOTO_MAX_BYTES ||
      (Buffer.isBuffer(file.buffer) &&
        file.buffer.length > COMMUNITY_PHOTO_MAX_BYTES)
    )
      throw communityError('COMMUNITY_PHOTO_TOO_LARGE');
    if (
      (file.fieldname !== undefined && file.fieldname !== 'photos') ||
      file.mimetype !== 'image/jpeg' ||
      !Buffer.isBuffer(file.buffer) ||
      file.size !== file.buffer.length
    )
      throw communityError('INVALID_COMMUNITY_PHOTO');
    const parsed = parseJpegStripMetadata(file.buffer, COMMUNITY_JPEG_RULES);
    if (!parsed) throw communityError('INVALID_COMMUNITY_PHOTO');
    return {
      bytes: parsed.bytes,
      width: parsed.width,
      height: parsed.height,
      byteSize: parsed.bytes.length,
      sha256: createHash('sha256').update(parsed.bytes).digest('hex'),
    };
  });
}
