import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { readLegacyAndroidRelease } from './app-release.policy';
import { AppStoreLookupService } from './app-store-lookup.service';

/**
 * Read-only, public (the app checks it before and after sign-in): the
 * store-published latest version per platform. iOS comes from the App Store
 * itself (cached lookup); Android only for app builds from before
 * 2026-11-13. No user data, no writes; a store that cannot be read is null.
 */
@Public()
@Controller('api/v1/app-release')
export class AppReleaseController {
  constructor(private readonly appStore: AppStoreLookupService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async get() {
    return {
      success: true as const,
      data: {
        android: readLegacyAndroidRelease(),
        ios: await this.appStore.current(),
      },
    };
  }
}
