import { Module } from '@nestjs/common';
import { AppReleaseController } from './app-release.controller';

@Module({ controllers: [AppReleaseController] })
export class AppReleaseModule {}
