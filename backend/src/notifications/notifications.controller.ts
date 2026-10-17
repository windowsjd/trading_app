import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { Public } from '../auth/auth.decorators';
import { OperatorGuard } from '../operator/operator.guard';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushDevicesService } from './push-devices.service';
import { ImportantNoticesService } from './important-notices.service';
import { OrderFailuresService } from './order-failures.service';

/** The caller's own settings and devices (global access-token guard),
 * except `devices/release`, which proves possession of the token itself. */
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly devices: PushDevicesService,
  ) {}

  @Get('preferences')
  getPreferences(@Req() request: AuthenticatedRequest) {
    return this.preferences.get(request.user?.userId);
  }

  @Patch('preferences')
  updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.preferences.update(request.user?.userId, body);
  }

  @Put('devices')
  registerDevice(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.devices.register(request.user?.userId, body);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('devices/release')
  releaseDevice(@Body() body: unknown) {
    return this.devices.release(body);
  }
}

/** The stored result of the failure an `order_failure` push names, read
 * only inside the caller's own account (authenticated, read-only). */
@Controller('api/v1/trading-accounts/:accountId/order-failures')
export class OrderFailuresController {
  constructor(private readonly failures: OrderFailuresService) {}

  @Get(':kind/:failureId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Param('kind') kind: string,
    @Param('failureId') failureId: string,
  ) {
    return this.failures.get(request.user?.userId, accountId, kind, failureId);
  }
}

/** Published important notices for the app's 공지사항 list (authenticated). */
@Controller('api/v1/notices')
export class NoticesController {
  constructor(private readonly notices: ImportantNoticesService) {}

  @Get()
  list() {
    return this.notices.listPublished();
  }
}

/** Operator-only important notice management. Publishing pushes the notice
 * to every user with important notices on, so it requires `confirm: true`
 * and happens once per notice. */
@Controller('api/v1/operator/notices')
@UseGuards(OperatorGuard)
export class OperatorNoticesController {
  constructor(private readonly notices: ImportantNoticesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.notices.create(request.user, body, this.context(request));
  }

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.notices.listForOperator(request.user);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':noticeId/publish')
  publish(
    @Req() request: AuthenticatedRequest,
    @Param('noticeId') noticeId: string,
    @Body() body: unknown,
  ) {
    return this.notices.publish(
      request.user,
      noticeId,
      body,
      this.context(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post(':noticeId/withdraw')
  withdraw(
    @Req() request: AuthenticatedRequest,
    @Param('noticeId') noticeId: string,
  ) {
    return this.notices.withdraw(request.user, noticeId, this.context(request));
  }

  private context(request: AuthenticatedRequest) {
    const header = (name: string) => {
      const value = request.headers[name];
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === 'string' && first.trim() ? first.trim() : null;
    };
    return {
      requestId: header('x-request-id'),
      ipAddress: request.ip ?? null,
      userAgent: header('user-agent'),
    };
  }
}
