import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import {
  PROFILE_IMAGE_MAX_BYTES,
  validateProfileImage,
} from './profile-image.validation';

const jpeg = readFileSync(
  join(__dirname, '../../test/fixtures/profile-image.jpg'),
);
const file = (buffer = jpeg, mimetype = 'image/jpeg') => ({
  buffer,
  size: buffer.length,
  mimetype,
});
const checkError = (run: () => unknown, code: string, status = 400) => {
  try {
    run();
    throw new Error('Expected validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).getResponse()).toMatchObject({
      success: false,
      error: { code },
    });
  }
};

describe('profile JPEG validation', () => {
  it('accepts a real JPEG, retaining scan data and stripping metadata', () => {
    const metadata = Buffer.from('private GPS original-filename');
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = 0xe1;
    header.writeUInt16BE(metadata.length + 2, 2);
    const withExif = Buffer.concat([
      jpeg.subarray(0, 2),
      header,
      metadata,
      jpeg.subarray(2),
    ]);
    const result = validateProfileImage(file(withExif));
    expect(result.includes(metadata)).toBe(false);
    expect(result.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(result.length).toBeLessThan(jpeg.length + metadata.length);
  });

  it('rejects missing, oversized and inconsistent file metadata', () => {
    checkError(() => validateProfileImage(), 'PROFILE_IMAGE_REQUIRED');
    checkError(
      () =>
        validateProfileImage(file(Buffer.alloc(PROFILE_IMAGE_MAX_BYTES + 1))),
      'PROFILE_IMAGE_TOO_LARGE',
      413,
    );
    checkError(
      () => validateProfileImage({ ...file(), size: 1 }),
      'INVALID_PROFILE_IMAGE',
    );
    checkError(
      () => validateProfileImage(file(jpeg, 'image/png')),
      'INVALID_PROFILE_IMAGE',
    );
  });

  it('rejects fake JPEG MIME, HTML/SVG, signatures without structure and truncation', () => {
    for (const bytes of [
      Buffer.from('<svg></svg>'),
      Buffer.from('<html>bad</html>'),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff]),
      jpeg.subarray(0, jpeg.length - 2),
      Buffer.concat([jpeg, Buffer.from('<script/>')]),
    ]) {
      checkError(
        () => validateProfileImage(file(bytes)),
        'INVALID_PROFILE_IMAGE',
      );
    }
    for (let size = 2; size < jpeg.length; size += 19) {
      checkError(
        () => validateProfileImage(file(jpeg.subarray(0, size))),
        'INVALID_PROFILE_IMAGE',
      );
    }
  });

  it('rejects nonsquare and oversized dimensions independently of file size', () => {
    const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(frame).toBeGreaterThan(0);
    const rectangular = Buffer.from(jpeg);
    rectangular.writeUInt16BE(15, frame + 5);
    checkError(
      () => validateProfileImage(file(rectangular)),
      'INVALID_PROFILE_IMAGE',
    );
    const huge = Buffer.from(jpeg);
    huge.writeUInt16BE(513, frame + 5);
    huge.writeUInt16BE(513, frame + 7);
    checkError(() => validateProfileImage(file(huge)), 'INVALID_PROFILE_IMAGE');
  });
});
