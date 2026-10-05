export const PROFILE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export type ProfileImageUpload = { uri: string; name: 'profile.jpg'; type: 'image/jpeg' };

export class ProfileImageSelectionError extends Error {
  readonly reason: 'permission' | 'too_large' | 'processing';

  constructor(reason: 'permission' | 'too_large' | 'processing') {
    super(reason);
    this.reason = reason;
    this.name = 'ProfileImageSelectionError';
  }
}
