import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { AdMobRewardSessionService } from './admob-reward-session.service';

/**
 * Google's AdMob server-side verification callback (2026-11-07). Public: it
 * carries no member credentials, only Google's signature, which is the whole
 * authentication (AdMobRewardSessionService.handleSsvCallback). The query is
 * read RAW from the request line — the signed bytes must not be re-encoded
 * or reordered by a parser. Only 200 stops Google's retries.
 *
 * Configure in the AdMob console (rewarded ad unit › server-side
 * verification): https://<api host>/api/v1/ad-rewards/admob/ssv
 */
@Controller('api/v1/ad-rewards/admob')
export class AdMobSsvController {
  constructor(private readonly sessions: AdMobRewardSessionService) {}

  @Public()
  @Get('ssv')
  async callback(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const url = request.originalUrl ?? request.url ?? '';
    const at = url.indexOf('?');
    const result = await this.sessions.handleSsvCallback(
      at >= 0 ? url.slice(at + 1) : '',
    );
    response.status(result.status);
    return { success: result.status === 200 };
  }
}
