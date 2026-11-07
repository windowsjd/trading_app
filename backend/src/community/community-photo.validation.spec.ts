import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { validateCommunityPhotos } from './community-photo.validation';

const fixture = readFileSync(
  join(__dirname, '../../test/fixtures/profile-image.jpg'),
);

/** The fixture with its SOF frame header declaring other dimensions (the
 * validator checks structure, not pixels). */
function withSize(width: number, height: number): Buffer {
  const bytes = Buffer.from(fixture);
  for (let offset = 2; offset < bytes.length - 9; offset++) {
    if (
      bytes[offset] === 0xff &&
      (bytes[offset + 1] === 0xc0 || bytes[offset + 1] === 0xc2)
    ) {
      bytes.writeUInt16BE(height, offset + 5);
      bytes.writeUInt16BE(width, offset + 7);
      return bytes;
    }
  }
  throw new Error('fixture has no SOF segment');
}

const file = (
  buffer: Buffer,
  mimetype = 'image/jpeg',
  fieldname = 'photos',
) => ({
  fieldname,
  buffer,
  size: buffer.length,
  mimetype,
});

function errorCode(run: () => unknown): { code: string; status: number } {
  try {
    run();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse() as { error: { code: string } };
    return { code: response.error.code, status: error.getStatus() };
  }
  return { code: 'NONE', status: 0 };
}

describe('community photo validation', () => {
  it('accepts no photos', () => {
    expect(validateCommunityPhotos(undefined)).toHaveLength(0);
    expect(validateCommunityPhotos([])).toHaveLength(0);
  });

  it('accepts a non-square JPEG up to 1600 px and strips EXIF metadata', () => {
    const metadata = Buffer.from('GPS 37.5665,126.9780 phone-serial-123');
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(metadata.length + 2, 2);
    const base = withSize(1600, 1200);
    const withExif = Buffer.concat([
      base.subarray(0, 2),
      header,
      metadata,
      base.subarray(2),
    ]);
    const [photo] = validateCommunityPhotos([file(withExif)]);
    expect(photo.width).toBe(1600);
    expect(photo.height).toBe(1200);
    expect(photo.bytes.includes(metadata)).toBe(false);
    expect(photo.byteSize).toBe(photo.bytes.length);
    expect(photo.sha256).toBe(
      createHash('sha256').update(photo.bytes).digest('hex'),
    );
  });

  it('keeps the order of up to four photos', () => {
    const photos = validateCommunityPhotos([
      file(withSize(10, 20)),
      file(withSize(30, 40)),
      file(withSize(50, 60)),
      file(withSize(70, 80)),
    ]);
    expect(photos.map((photo) => photo.width).join(',')).toBe('10,30,50,70');
  });

  it('refuses a fifth photo', () => {
    const five = Array.from({ length: 5 }, () => file(withSize(100, 100)));
    expect(errorCode(() => validateCommunityPhotos(five))).toEqual({
      code: 'COMMUNITY_TOO_MANY_PHOTOS',
      status: 400,
    });
  });

  it('refuses more than 2 MiB per photo', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    expect(errorCode(() => validateCommunityPhotos([file(big)]))).toEqual({
      code: 'COMMUNITY_PHOTO_TOO_LARGE',
      status: 413,
    });
  });

  it.each([
    ['a side above 1600 px', () => file(withSize(1601, 900))],
    ['a zero side', () => file(withSize(0, 900))],
    [
      'a PNG',
      () => file(Buffer.from('89504e470d0a1a0a0000', 'hex'), 'image/png'),
    ],
    [
      'non-JPEG bytes labelled JPEG',
      () => file(Buffer.from('not a jpeg at all')),
    ],
    ['a truncated JPEG', () => file(fixture.subarray(0, fixture.length - 10))],
    [
      'another multipart field',
      () => file(withSize(100, 100), 'image/jpeg', 'file'),
    ],
    [
      'a size that disagrees with the bytes',
      () => ({ ...file(withSize(100, 100)), size: 3 }),
    ],
  ])('refuses %s', (_label, build) => {
    expect(errorCode(() => validateCommunityPhotos([build()]))).toEqual({
      code: 'INVALID_COMMUNITY_PHOTO',
      status: 400,
    });
  });
});
