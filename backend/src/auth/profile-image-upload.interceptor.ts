import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  PROFILE_IMAGE_MAX_BYTES,
  profileImageError,
} from './profile-image.validation';

// No dest/storage path: Multer's default memory storage. Limits also bound fields.
const MultipartInterceptor = FileInterceptor('file', {
  limits: { fileSize: PROFILE_IMAGE_MAX_BYTES, files: 1, fields: 0, parts: 2 },
});

@Injectable()
export class ProfileImageUploadInterceptor extends MultipartInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 413) {
        throw new PayloadTooLargeException(
          profileImageError(
            'PROFILE_IMAGE_TOO_LARGE',
            'Profile image must be at most 2 MiB.',
          ),
        );
      }
      throw new BadRequestException(
        profileImageError(
          'INVALID_PROFILE_IMAGE',
          'Expected one JPEG file in the file field.',
        ),
      );
    }
  }
}
