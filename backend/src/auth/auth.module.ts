import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AccessTokenGuard } from './access-token.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ProfileImageController } from './profile-image.controller';
import { ProfileImageService } from './profile-image.service';
import { ProfileImageStorageService } from './profile-image-storage.service';

@Module({
  imports: [JwtModule.register({}), PrismaModule],
  controllers: [AuthController, ProfileImageController],
  providers: [
    AuthService,
    ProfileImageService,
    ProfileImageStorageService,
    AccessTokenGuard,
    {
      provide: APP_GUARD,
      useExisting: AccessTokenGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
