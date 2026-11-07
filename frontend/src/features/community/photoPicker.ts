import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import {
  COMMUNITY_PHOTO_QUALITY,
  CommunityPhotoSelectionError,
  isSendablePhoto,
  photoResizeTarget,
  sourcePhotoProblem,
  type CommunityPhotoUpload,
} from './photoRules';

/**
 * Picks up to `remaining` photos and normalizes each like the profile photo
 * pipeline: decoded by Expo's loader (orientation applied to the pixels),
 * long edge resized to 1280px when larger, saved as JPEG 0.8 without EXIF.
 * Only iOS needs library access; Android uses the system photo picker.
 */
export async function pickCommunityPhotos(remaining: number): Promise<CommunityPhotoUpload[]> {
  if (remaining < 1) return [];
  if (Platform.OS === 'ios') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted && permission.accessPrivileges !== 'limited') {
      throw new CommunityPhotoSelectionError('permission');
    }
  }
  // On Web this call precedes any await, retaining the button's user activation.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: remaining, orderedSelection: true,
    allowsEditing: false, quality: 1, exif: false, base64: false,
  });
  if (result.canceled) return [];
  const photos: CommunityPhotoUpload[] = [];
  for (const asset of result.assets.slice(0, remaining)) photos.push(await normalize(asset, photos.length));
  return photos;
}

async function normalize(asset: ImagePicker.ImagePickerAsset, index: number): Promise<CommunityPhotoUpload> {
  if (!asset?.uri || (asset.type && asset.type !== 'image')) throw new CommunityPhotoSelectionError('processing');
  let context: ReturnType<typeof ImageManipulator.manipulate> | undefined;
  let decoded: ImageRef | undefined;
  let normalized: ImageRef | undefined;
  try {
    const sourceProblem = sourcePhotoProblem(asset.width, asset.height, asset.fileSize);
    if (sourceProblem) throw new CommunityPhotoSelectionError(sourceProblem);
    context = ImageManipulator.manipulate(asset.uri);
    // Decoded dimensions, not the picker's (EXIF orientation may swap them).
    decoded = await context.renderAsync();
    const decodedProblem = sourcePhotoProblem(decoded.width, decoded.height, 0);
    if (decodedProblem) throw new CommunityPhotoSelectionError(decodedProblem);
    const target = photoResizeTarget(decoded.width, decoded.height);
    if (target) context.resize(target);
    normalized = target ? await context.renderAsync() : decoded;
    const image = await normalized.saveAsync({ format: SaveFormat.JPEG, compress: COMMUNITY_PHOTO_QUALITY, base64: false });
    const photo = { uri: image.uri, width: image.width, height: image.height };
    if (!isSendablePhoto(photo)) throw new CommunityPhotoSelectionError('processing');
    return { ...photo, name: `photo-${index + 1}.jpg`, type: 'image/jpeg' };
  } catch (error) {
    if (error instanceof CommunityPhotoSelectionError) throw error;
    throw new CommunityPhotoSelectionError('processing');
  } finally {
    normalized?.release();
    if (decoded !== normalized) decoded?.release();
    context?.release();
    if (Platform.OS === 'web' && asset?.uri?.startsWith('blob:')) URL.revokeObjectURL(asset.uri);
  }
}
