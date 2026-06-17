import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from './auth.decorators';
import { AuthService } from './auth.service';
import type {
  AuthenticatedRequest,
  LoginRequestBody,
  RefreshTokenRequestBody,
  RequestAuthMetadata,
  SignupRequestBody,
} from './auth.types';

@Controller('api/v1')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @HttpCode(HttpStatus.CREATED)
  @Post('auth/signup')
  signup(@Body() body: SignupRequestBody, @Req() request: Request) {
    return this.authService.signup(body, this.getRequestAuthMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/login')
  login(@Body() body: LoginRequestBody, @Req() request: Request) {
    return this.authService.login(body, this.getRequestAuthMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/refresh')
  refresh(@Body() body: RefreshTokenRequestBody, @Req() request: Request) {
    return this.authService.refresh(body, this.getRequestAuthMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout')
  logout(@Body() body: RefreshTokenRequestBody) {
    return this.authService.logout(body);
  }

  @HttpCode(HttpStatus.OK)
  @Post('auth/logout-all')
  logoutAll(@Req() request: AuthenticatedRequest) {
    return this.authService.logoutAll(request.user?.userId);
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.authService.me(request.user?.userId);
  }

  private getRequestAuthMetadata(request: Request): RequestAuthMetadata {
    return {
      userAgent: this.getHeaderValue(request.headers['user-agent']),
      ipAddress: request.ip,
    };
  }

  private getHeaderValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
  }
}
