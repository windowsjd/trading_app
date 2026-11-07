/**
 * Community photos (contract §10): the app sends JPEGs whose long edge is at
 * most 1280px (quality 0.8, orientation applied to the pixels, no EXIF); the
 * server re-validates every byte (2 MiB, 1–1600px, metadata stripped).
 * React-free so `node --test` covers the rules the picker applies.
 */
export const COMMUNITY_PHOTO_MAX_LONG_EDGE = 1280;
export const COMMUNITY_PHOTO_QUALITY = 0.8;
/** The server's per-file limit. */
export const COMMUNITY_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** Sources the app refuses before decoding (the profile photo's limits). */
export const COMMUNITY_PHOTO_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const COMMUNITY_PHOTO_MAX_SOURCE_PIXELS = 40_000_000;

export type CommunityPhotoUpload = { uri: string; name: string; type: 'image/jpeg'; width: number; height: number };

export class CommunityPhotoSelectionError extends Error {
  readonly reason: 'permission' | 'too_large' | 'processing';

  constructor(reason: 'permission' | 'too_large' | 'processing') {
    super(reason);
    this.reason = reason;
    this.name = 'CommunityPhotoSelectionError';
  }
}

/** A decodable source size, or the reason it is refused. */
export function sourcePhotoProblem(width: number, height: number, bytes: number | null | undefined): 'too_large' | 'processing' | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return 'processing';
  if ((bytes ?? 0) > COMMUNITY_PHOTO_MAX_SOURCE_BYTES || width * height > COMMUNITY_PHOTO_MAX_SOURCE_PIXELS) return 'too_large';
  return null;
}

/** The size to render (aspect kept, long edge 1280), or null when it already fits. */
export function photoResizeTarget(width: number, height: number): { width: number; height: number } | null {
  const long = Math.max(width, height);
  if (long <= COMMUNITY_PHOTO_MAX_LONG_EDGE) return null;
  const scale = COMMUNITY_PHOTO_MAX_LONG_EDGE / long;
  return width >= height
    ? { width: COMMUNITY_PHOTO_MAX_LONG_EDGE, height: Math.max(1, Math.round(height * scale)) }
    : { width: Math.max(1, Math.round(width * scale)), height: COMMUNITY_PHOTO_MAX_LONG_EDGE };
}

/** The normalized output the app may send (the server checks it again). */
export function isSendablePhoto(photo: { uri?: string | null; width: number; height: number }): boolean {
  return !!photo.uri && Number.isSafeInteger(photo.width) && Number.isSafeInteger(photo.height)
    && photo.width >= 1 && photo.height >= 1
    && Math.max(photo.width, photo.height) <= COMMUNITY_PHOTO_MAX_LONG_EDGE;
}

/** How many more photos a draft may take. */
export function remainingPhotoSlots(current: number, max: number): number {
  return Math.max(0, max - current);
}
