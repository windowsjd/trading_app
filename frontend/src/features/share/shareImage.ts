import type { RefObject } from 'react';
import type { View } from 'react-native';
import type { InstalledAppCheck, ShareOutcome } from './shareTargets';

/**
 * Web/Node host: no image capture, native share sheet or photo library. The
 * 수익 공유 sheet still previews the card; every action reports `unsupported`.
 * The device implementation is shareImage.native.ts (same exports).
 */
export type CapturedShareImage = { uri: string };

export const SHARE_CAPTURE_SUPPORTED = false;
export const captureShareCard = (_view: RefObject<View | null>): Promise<CapturedShareImage> =>
  Promise.reject(new Error('Image capture needs the app.'));
export const isShareAppInstalled = (_app: InstalledAppCheck): Promise<boolean> => Promise.resolve(false);
export const shareToInstagramStory = (_image: CapturedShareImage, _appId: string): Promise<ShareOutcome> =>
  Promise.resolve('unsupported');
export const shareToTelegram = (_image: CapturedShareImage): Promise<ShareOutcome> => Promise.resolve('unsupported');
export const openShareSheet = (_image: CapturedShareImage, _hint: string | null = null): Promise<ShareOutcome> =>
  Promise.resolve('unsupported');
export const saveToPhotos = (_image: CapturedShareImage): Promise<ShareOutcome> => Promise.resolve('unsupported');
