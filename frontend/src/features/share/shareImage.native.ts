import type { RefObject } from 'react';
import { AppState, Image, Linking, PixelRatio, Platform, type View } from 'react-native';
import type { InstalledAppCheck, ShareOutcome } from './shareTargets';

/**
 * Device side of 수익 공유: capture the card view to a 1080 × 1920 PNG and hand
 * it to Instagram Stories, a messenger, the system share sheet or the photo
 * library. Native modules are imported on use, so a build without them fails
 * only the action, never the screen (same idiom as features/ads/adsRuntime.native.ts).
 */
export type CapturedShareImage = { uri: string };

export const SHARE_CAPTURE_SUPPORTED = true;

/** Instagram Stories' recommended background: 9:16, at least 720 × 1280. */
const IMAGE = { width: 1080, height: 1920 } as const;
/** The card's own navy, for Instagram's layer behind the image. */
const STORY_TOP = '#011c42';
const STORY_BOTTOM = '#011632';

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

/** An Android package (package visibility <queries>) or an iOS scheme (LSApplicationQueriesSchemes). */
export async function isShareAppInstalled(app: InstalledAppCheck): Promise<boolean> {
  try {
    if ('packageName' in app) {
      if (Platform.OS !== 'android') return false;
      const { default: Share } = await import('react-native-share');
      return (await Share.isPackageInstalled(app.packageName)).isInstalled;
    }
    return await Linking.canOpenURL(app.scheme);
  } catch {
    return false;
  }
}

/**
 * Resolves true once this app leaves the foreground: the only evidence on
 * either platform that the target app really opened (the share calls resolve
 * as soon as the request is sent).
 */
function watchAppLeave(timeoutMs = 3000) {
  let stop = () => {};
  const left = new Promise<boolean>((resolve) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(value: boolean) {
      clearTimeout(timer);
      subscription.remove();
      resolve(value);
    }
    stop = () => finish(false);
  });
  return { left, stop };
}

/** Sends with react-native-share; a missing module (an older build) is a failure like any other. */
async function sendToApp(
  send: (share: typeof import('react-native-share')) => Promise<unknown>,
): Promise<ShareOutcome> {
  let share: typeof import('react-native-share');
  try {
    share = await import('react-native-share');
  } catch {
    return 'failed';
  }
  const watch = watchAppLeave();
  try {
    await send(share);
  } catch {
    watch.stop();
    return 'failed';
  }
  return (await watch.left) ? 'opened' : 'failed';
}

/** Meta's Sharing to Stories: the card as the story background, opened in Instagram's editor. */
export function shareToInstagramStory(image: CapturedShareImage, appId: string): Promise<ShareOutcome> {
  return sendToApp(({ default: Share, Social }) =>
    Share.shareSingle({
      social: Social.InstagramStories,
      appId,
      backgroundImage: image.uri,
      backgroundTopColor: STORY_TOP,
      backgroundBottomColor: STORY_BOTTOM,
    }),
  );
}

/** Android only: the image straight into the installed Telegram app's chat picker. */
export function shareToTelegram(image: CapturedShareImage): Promise<ShareOutcome> {
  return sendToApp(({ default: Share, Social }) =>
    Share.shareSingle({ social: Social.Telegram, url: image.uri, type: 'image/png' }));
}

/**
 * The system share sheet with the image; dismissing it is a cancel, not an
 * error. `hint` (pick an app) titles Android's chooser; iOS shows no title.
 */
export async function openShareSheet(image: CapturedShareImage, hint: string | null = null): Promise<ShareOutcome> {
  try {
    const { default: Share } = await import('react-native-share');
    const result = await Share.open({ url: image.uri, type: 'image/png', title: hint ?? '수익 공유', failOnCancel: false });
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
