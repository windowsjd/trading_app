import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { OperatorGuard } from './operator.guard';
import { OperatorService } from './operator.service';

@Controller('api/v1/operator')
@UseGuards(OperatorGuard)
export class OperatorController {
  constructor(private readonly operatorService: OperatorService) {}

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.operatorService.me(request.user);
  }
}
