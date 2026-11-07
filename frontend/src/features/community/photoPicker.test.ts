import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');

function harness({ platform = 'ios', permission = { granted: true }, assets = [{ width: 4032, height: 3024, fileSize: 3_000_000 }], canceled = false } = {}) {
  const h = { pickerOptions: null as any, resizes: [] as unknown[], saves: [] as any[], releases: 0, permissionRequests: 0 };
  let decoded = 0;
  const manipulate = (uri: string) => {
    const index = Number(uri.replace('file:///source-', '').replace('.heic', ''));
    const asset = assets[index];
    let target: { width: number; height: number } | null = null;
    const context = {
      resize: (size: { width: number; height: number }) => { h.resizes.push(size); target = size; return context; },
      renderAsync: async () => {
        decoded++;
        const size = target ?? { width: asset.width, height: asset.height };
        return { ...size, release: () => { h.releases++; }, saveAsync: async (options: unknown) => { h.saves.push(options); return { uri: `file:///out-${index}.jpg`, ...size }; } };
      },
      release: () => { h.releases++; },
    };
    return context;
  };
  const { pickCommunityPhotos } = load(resolve('src/features/community/photoPicker.ts'), {
    'react-native': { Platform: { OS: platform } },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => { h.permissionRequests++; return permission; },
      launchImageLibraryAsync: async (options: unknown) => {
        h.pickerOptions = options;
        return canceled ? { canceled: true } : { canceled: false, assets: assets.map((asset, index) => ({ uri: `file:///source-${index}.heic`, type: 'image', ...asset })) };
      },
    },
    'expo-image-manipulator': { ImageManipulator: { manipulate }, SaveFormat: { JPEG: 'jpeg' } },
  });
  return { h, pick: pickCommunityPhotos as (remaining: number) => Promise<any[]>, decoded: () => decoded };
}

describe('community photo picker (prompt ② 사진 처리)', () => {
  it('selects up to the remaining slots in order, resizes to a 1280px long edge, saves JPEG 0.8 without EXIF', async () => {
    const { h, pick } = harness({ assets: [{ width: 4032, height: 3024, fileSize: 3_000_000 }, { width: 800, height: 1200, fileSize: 400_000 }] });
    const photos = await pick(2);
    assert.equal(h.permissionRequests, 1);
    const options = h.pickerOptions;
    assert.equal([options.allowsMultipleSelection, options.selectionLimit, options.orderedSelection, options.exif, options.allowsEditing].join('|'), 'true|2|true|false|false');
    assert.equal(JSON.stringify(h.resizes), JSON.stringify([{ width: 1280, height: 960 }]));
    assert.equal(h.saves.every((save) => save.format === 'jpeg' && save.compress === 0.8 && save.base64 === false), true);
    assert.equal(photos.map((photo) => `${photo.name}:${photo.width}x${photo.height}:${photo.type}`).join(','), 'photo-1.jpg:1280x960:image/jpeg,photo-2.jpg:800x1200:image/jpeg');
    assert.equal(h.releases > 0, true);
  });

  it('opens nothing without a slot, returns nothing when canceled, and names each refusal', async () => {
    const none = harness();
    assert.equal((await none.pick(0)).length, 0);
    assert.equal(none.h.pickerOptions === null, true);
    assert.equal((await harness({ canceled: true }).pick(4)).length, 0);
    const denied = harness({ permission: { granted: false } as never });
    await assert.rejects(denied.pick(4), (error: any) => error.name === 'CommunityPhotoSelectionError' && error.reason === 'permission');
    assert.equal(denied.h.pickerOptions === null, true, 'the picker never opens without access');
    const huge = harness({ assets: [{ width: 9000, height: 9000, fileSize: 1 }] });
    await assert.rejects(huge.pick(4), (error: any) => error.reason === 'too_large');
    // Android uses the system picker: no library permission request.
    const android = harness({ platform: 'android' });
    await android.pick(1);
    assert.equal(android.h.permissionRequests, 0);
  });
});
