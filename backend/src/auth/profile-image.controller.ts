import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types';
import { ProfileImageService } from './profile-image.service';
import type { ProfileImageFile } from './profile-image.validation';
import { ProfileImageUploadInterceptor } from './profile-image-upload.interceptor';

@Controller('api/v1/me/profile-image')
export class ProfileImageController {
  constructor(private readonly images: ProfileImageService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(ProfileImageUploadInterceptor)
  upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file?: ProfileImageFile,
  ) {
    return this.images.upload(request.user?.userId, file);
  }

  @Delete()
  delete(@Req() request: AuthenticatedRequest) {
    return this.images.delete(request.user?.userId);
  }
}
