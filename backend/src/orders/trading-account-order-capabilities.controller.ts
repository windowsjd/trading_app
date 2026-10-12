import { Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createApiError } from '../common/api-error';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { readOrderCapabilities } from './order-capabilities';

type AuthRequest = Request & { user?: { userId?: string } };

/**
 * GET /api/v1/trading-accounts/:accountId/order-capabilities — read-only.
 * Ownership is the existing account check (a foreign account is the same
 * 404 as an unknown one). It touches no order, wallet or ledger row.
 */
@Controller('api/v1/trading-accounts/:accountId/order-capabilities')
export class TradingAccountOrderCapabilitiesController {
  constructor(private readonly access: TradingAccountAccessService) {}

  @Get()
  async get(
    @Req() request: AuthRequest,
    @Param('accountId') accountId: string,
  ) {
    const userId = request.user?.userId;
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return {
      success: true as const,
      data: { tradingAccountId: accountId, ...readOrderCapabilities() },
    };
  }
}
