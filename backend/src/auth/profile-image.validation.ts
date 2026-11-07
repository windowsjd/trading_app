import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export const PROFILE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PROFILE_IMAGE_MAX_DIMENSION = 512;

export type ProfileImageFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
};

export const profileImageError = (code: string, message: string) => ({
  success: false as const,
  error: { code, message },
});

export function validateProfileImage(file?: ProfileImageFile): Buffer {
  if (!file) {
    throw new BadRequestException(
      profileImageError(
        'PROFILE_IMAGE_REQUIRED',
        'A profile image file is required.',
      ),
    );
  }
  if (
    file.size > PROFILE_IMAGE_MAX_BYTES ||
    file.buffer?.length > PROFILE_IMAGE_MAX_BYTES
  ) {
    throw new PayloadTooLargeException(
      profileImageError(
        'PROFILE_IMAGE_TOO_LARGE',
        'Profile image must be at most 2 MiB.',
      ),
    );
  }
  if (
    file.mimetype !== 'image/jpeg' ||
    !Buffer.isBuffer(file.buffer) ||
    file.size !== file.buffer.length ||
    file.size < 4
  )
    invalidImage();
  const parsed = parseJpegStripMetadata(file.buffer, PROFILE_JPEG_RULES);
  if (!parsed) invalidImage();
  return parsed.bytes;
}

function invalidImage(): never {
  throw new BadRequestException(
    profileImageError(
      'INVALID_PROFILE_IMAGE',
      'A valid square JPEG image of at most 512 pixels is required.',
    ),
  );
}

export type JpegRules = {
  maxDimension: number;
  /** Width must equal height (profile photos). */
  square: boolean;
  /** Allowed SOF component counts. */
  components: readonly number[];
};

export type ParsedJpeg = { bytes: Buffer; width: number; height: number };

const PROFILE_JPEG_RULES: JpegRules = {
  maxDimension: PROFILE_IMAGE_MAX_DIMENSION,
  square: true,
  components: [1, 2, 3, 4],
};

/** Bounded JPEG structure validation, not a pixel decoder. Strip APP/COM
 * metadata. Returns null for anything that is not a valid JPEG under `rules`;
 * callers own their error (profile and community photos differ). */
export function parseJpegStripMetadata(
  bytes: Buffer,
  rules: JpegRules,
): ParsedJpeg | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const chunks: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let frame: { width: number; height: number } | null = null;
  let scan = false;
  let quantization = false;
  let huffman = false;

  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (
        !frame ||
        !scan ||
        !quantization ||
        !huffman ||
        offset !== bytes.length
      )
        return null;
      chunks.push(bytes.subarray(start, offset));
      return { bytes: Buffer.concat(chunks), ...frame };
    }
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;

    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 11 || bytes[offset + 2] !== 8) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (
        !width ||
        !height ||
        (rules.square && width !== height) ||
        width > rules.maxDimension ||
        height > rules.maxDimension ||
        !rules.components.includes(components) ||
        length !== 8 + components * 3
      )
        return null;
      frame = { width, height };
    } else if (marker === 0xdb) {
      if (length < 67) return null;
      quantization = true;
    } else if (marker === 0xc4) {
      if (length < 20) return null;
      huffman = true;
    } else if (marker === 0xdd) {
      if (length !== 4) return null;
    } else if (marker === 0xda) {
      if (!frame || length < 8 || length !== 6 + bytes[offset + 2] * 2)
        return null;
      scan = true;
    } else if (!metadata) {
      return null;
    }

    if (!metadata) chunks.push(bytes.subarray(start, end));
    offset = end;
    if (marker !== 0xda) continue;

    // Entropy data: FF00 is a stuffed byte; FFD0–FFD7 are restart markers.
    const scanStart = offset;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const next = bytes[offset + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (next === 0xff) {
        offset++;
        continue;
      }
      break;
    }
    if (offset === scanStart || offset >= bytes.length) return null;
    chunks.push(bytes.subarray(scanStart, offset));
  }
  return null;
}
