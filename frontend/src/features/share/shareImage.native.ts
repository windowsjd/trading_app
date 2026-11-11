import type { RefObject } from 'react';
import { Image, PixelRatio, Platform, type View } from 'react-native';
import type { ShareOutcome } from './shareTargets';

/**
 * Device side of 수익 공유: capture the card view to a 1080 × 1920 PNG and hand
 * it to the system share sheet or the photo library. Native modules are
 * imported on use, so a build without them fails only the action, never the
 * screen (same idiom as features/ads/adsRuntime.native.ts).
 */
export type CapturedShareImage = { uri: string };

export const SHARE_CAPTURE_SUPPORTED = true;

/** 9:16 at 1080 × 1920: a full-screen story or chat image in every app. */
const IMAGE = { width: 1080, height: 1920 } as const;

const fileUri = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);

function imageSize(uri: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) =>
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject),
  );
}

/**
 * The card as a PNG file. Android sizes the snapshot in pixels; iOS in points
 * drawn at the screen scale — so both come out 1080 × 1920. A capture that is
 * empty or not 9:16 is an error: an incomplete image is never shared.
 */
export async function captureShareCard(view: RefObject<View | null>): Promise<CapturedShareImage> {
  if (!view.current) throw new Error('The card is not on screen.');
  const { captureRef } = await import('react-native-view-shot');
  const scale = Platform.OS === 'ios' ? PixelRatio.get() : 1;
  const path = await captureRef(view, {
    format: 'png',
    quality: 1,
    result: 'tmpfile',
    width: IMAGE.width / scale,
    height: IMAGE.height / scale,
  });
  const uri = fileUri(path);
  const size = await imageSize(uri);
  if (!(size.width > 0 && size.height > 0) || Math.abs(size.width / size.height - IMAGE.width / IMAGE.height) > 0.01)
    throw new Error('The card capture is incomplete.');
  return { uri };
}

/**
 * The system share sheet with the image (KakaoTalk, Instagram, Telegram and
 * every other app the device offers); dismissing it is a cancel, not an error.
 * The title names Android's chooser; iOS shows none.
 */
export async function openShareSheet(image: CapturedShareImage): Promise<ShareOutcome> {
  try {
    const { default: Share } = await import('react-native-share');
    const result = await Share.open({ url: image.uri, type: 'image/png', title: '수익 공유', failOnCancel: false });
    return result.dismissedAction ? 'cancelled' : 'shared';
  } catch {
    return 'failed';
  }
}

/**
 * Saves into the photo library with add-only access: iOS asks for 사진 추가
 * (NSPhotoLibraryAddUsageDescription), Android 12 and below for storage write;
 * Android 13+ needs no permission to add an image.
 */
export async function saveToPhotos(image: CapturedShareImage): Promise<ShareOutcome> {
  try {
    const MediaLibrary = await import('expo-media-library');
    if (Platform.OS === 'ios' || Number(Platform.Version) < 33) {
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (!permission.granted) return 'permission_denied';
    }
    await MediaLibrary.saveToLibraryAsync(image.uri);
    return 'saved';
  } catch {
    return 'failed';
  }
}
