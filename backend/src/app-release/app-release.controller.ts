import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { readAppReleaseManifest } from './app-release.policy';

/**
 * Read-only, public (the app checks it before and after sign-in): the
 * store-published latest version per platform. No user data, no writes.
 */
@Public()
@Controller('api/v1/app-release')
export class AppReleaseController {
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  get() {
    return { success: true as const, data: readAppReleaseManifest() };
  }
}
