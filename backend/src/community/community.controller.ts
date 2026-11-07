import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import type { OperatorRequestContext } from '../operator/operator-account-management.service';
import { OperatorGuard } from '../operator/operator.guard';
import { CommunityModerationService } from './community-moderation.service';
import { CommunityPhotoUploadInterceptor } from './community-photo-upload.interceptor';
import type { CommunityUploadedFile } from './community-photo.validation';
import {
  type CommunityCommentsQuery,
  type CommunityFeedQuery,
  CommunityReadService,
} from './community-read.service';
import { CommunityWriteService } from './community-write.service';

const feedPipe = new ScalarQueryPipe({
  category: 'INVALID_COMMUNITY_CATEGORY',
  limit: 'INVALID_PAGINATION',
  offset: 'INVALID_PAGINATION',
} satisfies Record<keyof CommunityFeedQuery, string>);

const commentsPipe = new ScalarQueryPipe({
  sort: 'INVALID_COMMUNITY_SORT',
  limit: 'INVALID_PAGINATION',
  offset: 'INVALID_PAGINATION',
} satisfies Record<keyof CommunityCommentsQuery, string>);

/** Authenticated by the global access-token guard (no guest access);
 * docs/community-api-contract.md §5. */
@Controller('api/v1/community')
export class CommunityController {
  constructor(
    private readonly reads: CommunityReadService,
    private readonly writes: CommunityWriteService,
  ) {}

  @Get('bootstrap')
  bootstrap(@Req() request: AuthenticatedRequest) {
    return this.reads.bootstrap(request.user);
  }

  @Get('posts')
  feed(
    @Req() request: AuthenticatedRequest,
    @Query(feedPipe) query: CommunityFeedQuery,
  ) {
    return this.reads.feed(request.user, query);
  }

  @Get('posts/:postId')
  post(@Req() request: AuthenticatedRequest, @Param('postId') postId: string) {
    return this.reads.post(request.user, postId);
  }

  @Get('posts/:postId/comments')
  comments(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Query(commentsPipe) query: CommunityCommentsQuery,
  ) {
    return this.reads.comments(request.user, postId, query);
  }

  @Post('posts')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(CommunityPhotoUploadInterceptor)
  createPost(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @UploadedFiles() photos?: CommunityUploadedFile[],
  ) {
    return this.writes.createPost(request.user, body, photos);
  }

  @Delete('posts/:postId')
  deletePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
  ) {
    return this.writes.deletePost(request.user, postId);
  }

  @Put('posts/:postId/like')
  likePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
  ) {
    return this.writes.setPostLike(request.user, postId, true);
  }

  @Delete('posts/:postId/like')
  unlikePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
  ) {
    return this.writes.setPostLike(request.user, postId, false);
  }

  @Post('posts/:postId/comments')
  @HttpCode(HttpStatus.CREATED)
  createComment(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Body() body: unknown,
  ) {
    return this.writes.createComment(request.user, postId, body);
  }

  @Delete('comments/:commentId')
  deleteComment(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    return this.writes.deleteComment(request.user, commentId);
  }

  @Put('comments/:commentId/like')
  likeComment(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    return this.writes.setCommentLike(request.user, commentId, true);
  }

  @Delete('comments/:commentId/like')
  unlikeComment(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    return this.writes.setCommentLike(request.user, commentId, false);
  }

  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  report(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.writes.report(request.user, body);
  }

  @Post('rules/consent')
  @HttpCode(HttpStatus.OK)
  consent(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.writes.consent(request.user, body);
  }
}

/** Operator/admin only (current DB role via OperatorGuard); contract §9. */
@Controller('api/v1/operator/community')
@UseGuards(OperatorGuard)
export class OperatorCommunityController {
  constructor(private readonly moderation: CommunityModerationService) {}

  @Post('posts/:postId/remove')
  @HttpCode(HttpStatus.OK)
  removePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Body() body: unknown,
  ) {
    return this.moderation.removePost(
      request.user,
      postId,
      body,
      this.context(request),
    );
  }

  @Post('comments/:commentId/remove')
  @HttpCode(HttpStatus.OK)
  removeComment(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    return this.moderation.removeComment(
      request.user,
      commentId,
      body,
      this.context(request),
    );
  }

  @Get('users/:userId')
  user(@Req() request: AuthenticatedRequest, @Param('userId') userId: string) {
    return this.moderation.userSummary(
      request.user,
      userId,
      this.context(request),
    );
  }

  @Post('users/:userId/sanctions')
  @HttpCode(HttpStatus.CREATED)
  sanction(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.moderation.createSanction(
      request.user,
      userId,
      body,
      this.context(request),
    );
  }

  @Post('sanctions/:sanctionId/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param('sanctionId') sanctionId: string,
  ) {
    return this.moderation.revokeSanction(
      request.user,
      sanctionId,
      this.context(request),
    );
  }

  private context(request: AuthenticatedRequest): OperatorRequestContext {
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
