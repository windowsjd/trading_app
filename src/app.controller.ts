import { Controller, Get } from '@nestjs/common';
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
}
