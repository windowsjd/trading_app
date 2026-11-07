import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { communityError } from './community-errors';
import {
  COMMUNITY_MAX_PHOTOS,
  COMMUNITY_PHOTO_MAX_BYTES,
} from './community.policy';

// Multer's default memory storage. Limits bound every part: up to 4 files in
// `photos`, one `payload` text field (a 500-code-point body is ≤ 2 KB UTF-8).
// The part limit leaves room so a fifth file trips the file-count limit
// (COMMUNITY_TOO_MANY_PHOTOS) rather than the generic part limit.
const MultipartInterceptor = FilesInterceptor('photos', COMMUNITY_MAX_PHOTOS, {
  limits: {
    fileSize: COMMUNITY_PHOTO_MAX_BYTES,
    files: COMMUNITY_MAX_PHOTOS,
    fields: 1,
    parts: COMMUNITY_MAX_PHOTOS + 3,
    fieldSize: 16 * 1024,
  },
});

/** Maps Multer's limit errors to the community codes (contract §10.1). */
@Injectable()
export class CommunityPhotoUploadInterceptor extends MultipartInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 413)
        throw communityError('COMMUNITY_PHOTO_TOO_LARGE');
      const response =
        error instanceof HttpException ? error.getResponse() : null;
      const text =
        response && typeof response === 'object' && 'message' in response
          ? (response as { message?: unknown }).message
          : null;
      // A fifth file trips busboy's file-count limit first.
      if (text === 'Too many files')
        throw communityError('COMMUNITY_TOO_MANY_PHOTOS');
      throw communityError('INVALID_COMMUNITY_POST');
    }
  }
}
