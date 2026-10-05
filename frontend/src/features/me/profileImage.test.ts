import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ProfileImageSelectionError } from './profileImageTypes.ts';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');

function harness(platform = 'ios') {
  const h = {
    permission: { granted: true, accessPrivileges: 'all' }, permissionRequests: 0,
    canceled: false, width: 4000, height: 3000, decodedWidth: 4000, decodedHeight: 3000,
    size: 5_000_000, pickerOptions: null as any, pickerRequests: 0,
    crops: [] as unknown[], resizes: [] as unknown[], saveOptions: null as any,
    fail: false, releases: [] as string[], finalSide: 512,
  };
  let renders = 0;
  const context = {
    crop: (rect: unknown) => { h.crops.push(rect); return context; },
    resize: (rect: unknown) => { h.resizes.push(rect); return context; },
    renderAsync: async () => {
      if (h.fail) throw new Error('decode failure');
      const initial = ++renders === 1;
      return {
        width: initial ? h.decodedWidth : h.finalSide, height: initial ? h.decodedHeight : h.finalSide,
        saveAsync: async (options: unknown) => { h.saveOptions = options; return { uri: 'file:///output.jpg', width: h.finalSide, height: h.finalSide }; },
        release: () => h.releases.push(initial ? 'decoded' : 'normalized'),
      };
    },
    release: () => h.releases.push('context'),
  };
  const { selectProfileImage } = load(resolve('src/features/me/profileImage.ts'), {
    'react-native': { Platform: { OS: platform } },
    './profileImageTypes': { ProfileImageSelectionError },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => { h.permissionRequests++; return h.permission; },
      launchImageLibraryAsync: async (options: unknown) => {
        h.pickerRequests++; h.pickerOptions = options;
        return h.canceled ? { canceled: true } : { canceled: false, assets: [{ uri: 'file:///source.heic', type: 'image', width: h.width, height: h.height, fileSize: h.size }] };
      },
    },
    'expo-image-manipulator': { ImageManipulator: { manipulate: () => context }, SaveFormat: { JPEG: 'jpeg' } },
  });
  return { h, selectProfileImage: selectProfileImage as () => Promise<unknown> };
}

describe('gallery profile image pipeline', () => {
  it('requests iOS photo access, uses one square edit, normalizes JPEG and releases decoded memory', async () => {
    const { h, selectProfileImage } = harness();
    assert.deepEqual(await selectProfileImage(), { uri: 'file:///output.jpg', name: 'profile.jpg', type: 'image/jpeg' });
    assert.equal(h.permissionRequests, 1);
    assert.deepEqual(h.pickerOptions, { mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: true, aspect: [1, 1], quality: 1, exif: false, base64: false });
    assert.deepEqual(h.crops, [{ originX: 500, originY: 0, width: 3000, height: 3000 }]);
    assert.deepEqual(h.resizes, [{ width: 512, height: 512 }]);
    assert.deepEqual(h.saveOptions, { format: 'jpeg', compress: 0.85, base64: false });
    assert.deepEqual(h.releases.sort(), ['context', 'decoded', 'normalized']);
  });

  it('supports limited access, while denial avoids opening the picker', async () => {
    const limited = harness(); limited.h.permission = { granted: false, accessPrivileges: 'limited' };
    await limited.selectProfileImage(); assert.equal(limited.h.pickerRequests, 1);
    const denied = harness(); denied.h.permission = { granted: false, accessPrivileges: 'none' };
    await assert.rejects(denied.selectProfileImage, { reason: 'permission' });
    assert.equal(denied.h.pickerRequests, 0);
  });

  it('uses Android/Web pickers without a broad native permission request', async () => {
    for (const platform of ['android', 'web']) {
      const { h, selectProfileImage } = harness(platform); const pending = selectProfileImage();
      // Web launch happens synchronously inside the button gesture.
      assert.equal(h.pickerRequests, 1); await pending; assert.equal(h.permissionRequests, 0);
      assert.equal(h.pickerOptions.allowsEditing, platform !== 'web');
    }
  });

  it('cancels without decoding or changing an image', async () => {
    const { h, selectProfileImage } = harness(); h.canceled = true;
    assert.equal(await selectProfileImage(), null); assert.deepEqual(h.releases, []); assert.equal(h.saveOptions, null);
  });

  it('uses oriented decoded dimensions rather than incorrect picker dimensions', async () => {
    const { h, selectProfileImage } = harness(); h.decodedWidth = 3000; h.decodedHeight = 4000;
    await selectProfileImage(); assert.deepEqual(h.crops, [{ originX: 0, originY: 500, width: 3000, height: 3000 }]);
  });

  it('re-encodes small square inputs without upscaling', async () => {
    const { h, selectProfileImage } = harness(); h.width = h.height = h.decodedWidth = h.decodedHeight = h.finalSide = 128;
    await selectProfileImage(); assert.deepEqual(h.crops, []); assert.deepEqual(h.resizes, []); assert.equal(h.saveOptions.format, 'jpeg');
  });

  it('rejects huge files/dimensions before decoding and bounds decoded output too', async () => {
    for (const field of ['size', 'width', 'decodedWidth'] as const) {
      const { h, selectProfileImage } = harness(); h[field] = field === 'size' ? 33 * 1024 * 1024 : 100000;
      await assert.rejects(selectProfileImage, { reason: 'too_large' }); assert.equal(h.saveOptions, null);
    }
  });

  it('turns manipulation failure into a safe error and releases context', async () => {
    const { h, selectProfileImage } = harness(); h.fail = true;
    await assert.rejects(selectProfileImage, { reason: 'processing' }); assert.deepEqual(h.releases, ['context']);
  });
});
