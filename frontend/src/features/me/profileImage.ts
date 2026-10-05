import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import { type ProfileImageUpload, ProfileImageSelectionError } from './profileImageTypes';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_AVATAR_SIDE = 512;

function checkDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ProfileImageSelectionError('processing');
  }
  if (width * height > MAX_SOURCE_PIXELS) throw new ProfileImageSelectionError('too_large');
}

/** Only iOS editing needs library access. Android uses the system photo picker. */
export async function selectProfileImage(): Promise<ProfileImageUpload | null> {
  if (Platform.OS === 'ios') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted && permission.accessPrivileges !== 'limited') {
      throw new ProfileImageSelectionError('permission');
    }
  }
  // On Web this call precedes any await, retaining the button's user activation.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], allowsMultipleSelection: false,
    allowsEditing: Platform.OS !== 'web', aspect: [1, 1], quality: 1,
    exif: false, base64: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset || !asset.uri || (asset.type && asset.type !== 'image')) {
    throw new ProfileImageSelectionError('processing');
  }
  let context: ReturnType<typeof ImageManipulator.manipulate> | undefined;
  let decoded: ImageRef | undefined;
  let normalized: ImageRef | undefined;
  try {
    if ((asset.fileSize ?? 0) > MAX_SOURCE_BYTES) throw new ProfileImageSelectionError('too_large');
    checkDimensions(asset.width, asset.height);
    context = ImageManipulator.manipulate(asset.uri);
    // Expo's loader applies orientation; use decoded dimensions rather than
    // trusting platform-dependent picker crop/EXIF dimensions.
    decoded = await context.renderAsync();
    checkDimensions(decoded.width, decoded.height);
    const side = Math.min(decoded.width, decoded.height);
    if (decoded.width !== decoded.height) {
      context.crop({ originX: Math.floor((decoded.width - side) / 2), originY: Math.floor((decoded.height - side) / 2), width: side, height: side });
    }
    if (side > MAX_AVATAR_SIDE) context.resize({ width: MAX_AVATAR_SIDE, height: MAX_AVATAR_SIDE });
    normalized = await context.renderAsync();
    const image = await normalized.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: false });
    if (!image.uri || image.width !== image.height || image.width > MAX_AVATAR_SIDE || image.width < 1) {
      throw new ProfileImageSelectionError('processing');
    }
    return { uri: image.uri, name: 'profile.jpg', type: 'image/jpeg' };
  } catch (error) {
    if (error instanceof ProfileImageSelectionError) throw error;
    throw new ProfileImageSelectionError('processing');
  } finally {
    normalized?.release();
    if (decoded !== normalized) decoded?.release();
    context?.release();
    if (Platform.OS === 'web' && asset.uri.startsWith('blob:')) URL.revokeObjectURL(asset.uri);
  }
}
