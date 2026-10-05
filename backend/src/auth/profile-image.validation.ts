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
  return validateJpegAndStripMetadata(file.buffer);
}

function invalidImage(): never {
  throw new BadRequestException(
    profileImageError(
      'INVALID_PROFILE_IMAGE',
      'A valid square JPEG image of at most 512 pixels is required.',
    ),
  );
}

/** Bounded JPEG structure validation, not a pixel decoder. Strip APP/COM metadata. */
function validateJpegAndStripMetadata(bytes: Buffer): Buffer {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();
  const chunks: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let frame = false;
  let scan = false;
  let quantization = false;
  let huffman = false;

  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) invalidImage();
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
        invalidImage();
      chunks.push(bytes.subarray(start, offset));
      return Buffer.concat(chunks);
    }
    if (offset + 2 > bytes.length) invalidImage();
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalidImage();
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;

    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 11 || bytes[offset + 2] !== 8) invalidImage();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (
        !width ||
        width !== height ||
        width > PROFILE_IMAGE_MAX_DIMENSION ||
        components < 1 ||
        components > 4 ||
        length !== 8 + components * 3
      )
        invalidImage();
      frame = true;
    } else if (marker === 0xdb) {
      if (length < 67) invalidImage();
      quantization = true;
    } else if (marker === 0xc4) {
      if (length < 20) invalidImage();
      huffman = true;
    } else if (marker === 0xdd) {
      if (length !== 4) invalidImage();
    } else if (marker === 0xda) {
      if (!frame || length < 8 || length !== 6 + bytes[offset + 2] * 2)
        invalidImage();
      scan = true;
    } else if (!metadata) {
      invalidImage();
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
    if (offset === scanStart || offset >= bytes.length) invalidImage();
    chunks.push(bytes.subarray(scanStart, offset));
  }
  invalidImage();
}
