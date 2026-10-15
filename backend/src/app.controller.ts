import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from './auth/auth.decorators';
import { AppService } from './app.service';

@Public()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  @Get('health/db')
  getDbHealth() {
    return this.appService.getDbHealth();
  }

  @Get('readiness')
  getReadiness() {
    return this.appService.getReadiness();
  }

  /** 503 while an operator alert is active. For external monitors only: never
   * a platform health check path, which would restart a serving instance. */
  @Get('readiness/alerts')
  async getReadinessAlerts(@Res({ passthrough: true }) response: Response) {
    const { httpStatus, body } = await this.appService.getReadinessAlerts();
    response.status(httpStatus);
    return body;
  }
}
