import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { WalletsService } from './wallets.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get()
  getWallets(@Req() request: AuthenticatedRequest) {
    return this.walletsService.getWallets(this.extractUserId(request));
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
