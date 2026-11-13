import { Module } from '@nestjs/common';
import { AppReleaseController } from './app-release.controller';
import { AppStoreLookupService } from './app-store-lookup.service';

@Module({
  controllers: [AppReleaseController],
  // One cache per instance; the constructor's parameters are test seams only.
  providers: [
    {
      provide: AppStoreLookupService,
      useFactory: () => new AppStoreLookupService(),
    },
  ],
})
export class AppReleaseModule {}
