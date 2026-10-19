import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AccountDeletionService,
  type AccountDeletionPasswordBody,
  type AccountDeletionStatusBody,
  type AppAccountDeletionBody,
  type WebAccountDeletionBody,
} from './account-deletion.service';
import { Public } from './auth.decorators';
import type { AuthenticatedRequest, RequestAuthMetadata } from './auth.types';

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/** Same request metadata as AuthController (rate-limit IP, user agent). */
function metadataOf(request: Request): RequestAuthMetadata {
  return {
    userAgent: headerValue(request.headers['user-agent']),
    ipAddress: request.ip,
  };
}

/** docs/account-deletion-contract.md. The app routes rely on the global
 * access-token guard and use only request.user.userId; the web routes are
 * public and carry their own single-use email proof or request key. */
@Controller('api/v1')
export class AccountDeletionController {
  constructor(private readonly deletions: AccountDeletionService) {}

  @HttpCode(HttpStatus.OK)
  @Post('me/account-deletion/password-check')
  checkPassword(
    @Body() body: AccountDeletionPasswordBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.deletions.checkPassword(
      request.user?.userId,
      body,
      metadataOf(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('me/account-deletion')
  deleteMine(
    @Body() body: AppAccountDeletionBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.deletions.deleteFromApp(
      request.user?.userId,
      body,
      metadataOf(request),
    );
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/account-deletion')
  deleteWithEmailProof(
    @Body() body: WebAccountDeletionBody,
    @Req() request: Request,
  ) {
    return this.deletions.deleteFromWeb(body, metadataOf(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/account-deletion/status')
  status(@Body() body: AccountDeletionStatusBody, @Req() request: Request) {
    return this.deletions.status(body, metadataOf(request));
  }
}
