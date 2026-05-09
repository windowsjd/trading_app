import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Public } from './auth.decorators';
import { AuthService } from './auth.service';
import type {
  AuthenticatedRequest,
  LoginRequestBody,
  SignupRequestBody,
} from './auth.types';

@Controller('api/v1')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @HttpCode(HttpStatus.CREATED)
  @Post('auth/signup')
  signup(@Body() body: SignupRequestBody) {
    return this.authService.signup(body);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/login')
  login(@Body() body: LoginRequestBody) {
    return this.authService.login(body);
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.authService.me(request.user?.userId);
  }
}
