import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { OperatorGuard } from './operator.guard';
import {
  OperatorProviderIngestionService,
  type OperatorProviderIngestionBody,
} from './operator-provider-ingestion.service';

@Controller('api/v1/operator/provider-ingestions')
@UseGuards(OperatorGuard)
export class OperatorProviderIngestionController {
  constructor(
    private readonly providerIngestionService: OperatorProviderIngestionService,
  ) {}

  @Post(':provider/run')
  @HttpCode(200)
  runProviderIngestion(
    @Req() request: AuthenticatedRequest,
    @Param('provider') provider: string,
    @Body() body: OperatorProviderIngestionBody = {},
  ) {
    return this.providerIngestionService.runProviderIngestion(
      request.user,
      provider,
      body,
      {
        requestId: readHeader(request, 'x-request-id'),
        ipAddress: request.ip,
        userAgent: readHeader(request, 'user-agent'),
      },
    );
  }
}

function readHeader(
  request: AuthenticatedRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
