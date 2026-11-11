import type { RefObject } from 'react';
import type { View } from 'react-native';
import type { ShareOutcome } from './shareTargets';

/**
 * Web/Node host: no image capture, native share sheet or photo library. The
 * 수익 공유 sheet still previews the card; every action reports `unsupported`.
 * The device implementation is shareImage.native.ts (same exports).
 */
export type CapturedShareImage = { uri: string };

export const SHARE_CAPTURE_SUPPORTED = false;
export const captureShareCard = (_view: RefObject<View | null>): Promise<CapturedShareImage> =>
  Promise.reject(new Error('Image capture needs the app.'));
export const openShareSheet = (_image: CapturedShareImage): Promise<ShareOutcome> => Promise.resolve('unsupported');
export const saveToPhotos = (_image: CapturedShareImage): Promise<ShareOutcome> => Promise.resolve('unsupported');
