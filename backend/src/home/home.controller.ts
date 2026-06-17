import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { HomeService } from './home.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get()
  getHome(@Req() request: AuthenticatedRequest) {
    return this.homeService.getHome(this.extractUserId(request));
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
