import {
  EmailVerificationService,
  authEmail,
} from './email-verification.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import {
  Prisma,
  RefreshTokenSessionStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AuthTokenResponse,
  AuthUser,
  CurrentUserResponse,
  LoginRequestBody,
  PasswordResetBody,
  LogoutResponse,
  RefreshTokenRequestBody,
  RequestAuthMetadata,
  SignupRequestBody,
  UpdateProfileRequestBody,
} from './auth.types';

type JwtTtlUnit = 's' | 'm' | 'h' | 'd' | 'w';
type JwtExpiresIn = `${number}${JwtTtlUnit}`;

type ParsedSignupRequest = {
  email: string;
  password: string;
  nickname: string;
};

type ParsedLoginRequest = {
  email: string;
  password: string;
};

type PublicUserRecord = {
  id: string;
  email: string;
  nickname: string;
  profileImageUrl: string | null;
  portfolioPublic: boolean;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
};

type RefreshTokenArtifacts = {
  token: string;
  tokenHash: string;
  expiresAt: Date;
};

const DEFAULT_ACCESS_TTL: JwtExpiresIn = '15m';
const REFRESH_TOKEN_BYTE_LENGTH = 48;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  onModuleInit() {
    this.validateAuthConfiguration();
  }

  async signup(
    body: SignupRequestBody = {},
    metadata: RequestAuthMetadata = {},
  ): Promise<AuthTokenResponse> {
    const request = this.parseSignupRequest(body);
    this.validateAuthConfiguration();
    await this.emailVerification.limit('complete', metadata);

    const passwordHash = await argon2.hash(request.password);
    const refreshToken = this.createRefreshTokenArtifacts();

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const evidence = await this.emailVerification.consume(
          tx,
          request.email,
          'signup',
          body.verificationToken,
        );
        const existingEmail = await tx.user.findUnique({
          where: { email: request.email },
          select: { id: true },
        });
        if (existingEmail)
          this.throwConflict('EMAIL_ALREADY_EXISTS', 'Email already exists.');
        const existingNickname = await tx.user.findUnique({
          where: { nickname: request.nickname },
          select: { id: true },
        });
        if (existingNickname)
          this.throwConflict(
            'NICKNAME_ALREADY_EXISTS',
            'Nickname already exists.',
          );
        const createdUser = await tx.user.create({
          data: {
            email: request.email,
            passwordHash,
            emailVerifiedAt: evidence.verifiedAt,
            nickname: request.nickname,
            role: UserRole.user,
            status: UserStatus.active,
          },
          select: {
            id: true,
            email: true,
            nickname: true,
            role: true,
            status: true,
          },
        });

        await this.createRefreshSession(
          tx,
          createdUser.id,
          metadata,
          refreshToken,
        );

        return createdUser;
      });

      return this.buildAuthTokenResponse(user, refreshToken);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.throwSignupUniqueConflict(error);
      }

      throw error;
    }
  }

  async login(
    body: LoginRequestBody = {},
    metadata: RequestAuthMetadata = {},
  ): Promise<AuthTokenResponse> {
    const request = this.parseLoginRequest(body);
    this.validateAuthConfiguration();
    const user = await this.prisma.user.findUnique({
      where: {
        email: request.email,
      },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        tokenVersion: true,
        nickname: true,
        role: true,
        status: true,
      },
    });

    if (!user) {
      this.throwInvalidCredentials();
    }

    const passwordMatches = await this.verifyPassword(
      user.passwordHash,
      request.password,
    );
    if (!passwordMatches) {
      this.throwInvalidCredentials();
    }

    if (user.status !== UserStatus.active) {
      this.throwUserNotActive();
    }

    const refreshToken = this.createRefreshTokenArtifacts();
    await this.prisma.$transaction(async (tx) => {
      const [current] = await this.lockUser(tx, user.id);
      if (
        !current ||
        current.passwordHash !== user.passwordHash ||
        current.tokenVersion !== (user.tokenVersion ?? 0)
      )
        this.throwInvalidCredentials();
      if (current.status !== UserStatus.active) this.throwUserNotActive();
      await this.createRefreshSession(tx, user.id, metadata, refreshToken);
    });
    return this.buildAuthTokenResponse(
      {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        status: user.status,
      },
      refreshToken,
      user.tokenVersion ?? 0,
    );
  }

  async refresh(
    body: RefreshTokenRequestBody = {},
    metadata: RequestAuthMetadata = {},
  ): Promise<AuthTokenResponse> {
    const refreshToken = this.parseRefreshToken(body.refreshToken);
    this.validateAuthConfiguration();
    const tokenHash = this.hashRefreshToken(refreshToken);
    const nextRefreshToken = this.createRefreshTokenArtifacts();
    const now = new Date();

    const user = await this.prisma.$transaction(async (tx) => {
      const session = await tx.refreshTokenSession.findUnique({
        where: {
          tokenHash,
        },
        select: {
          id: true,
          userId: true,
          status: true,
          expiresAt: true,
          user: {
            select: {
              id: true,
              email: true,
              nickname: true,
              role: true,
              status: true,
              tokenVersion: true,
            },
          },
        },
      });

      if (!session) {
        this.throwInvalidRefreshToken();
      }

      if (session.status !== RefreshTokenSessionStatus.active) {
        this.throwInvalidRefreshToken();
      }

      if (session.expiresAt.getTime() <= now.getTime()) {
        this.throwInvalidRefreshToken();
      }

      if (session.user.status !== UserStatus.active) {
        this.throwUserNotActive();
      }

      const [current] = await this.lockUser(tx, session.userId);
      if (!current || current.tokenVersion !== (session.user.tokenVersion ?? 0))
        this.throwInvalidRefreshToken();
      if (current.status !== UserStatus.active) this.throwUserNotActive();
      const newSession = await this.createRefreshSession(
        tx,
        session.userId,
        metadata,
        nextRefreshToken,
      );
      const revokeResult = await tx.refreshTokenSession.updateMany({
        where: {
          id: session.id,
          status: RefreshTokenSessionStatus.active,
        },
        data: {
          status: RefreshTokenSessionStatus.revoked,
          revokedAt: now,
          replacedBySessionId: newSession.id,
        },
      });

      if (revokeResult.count !== 1) {
        this.throwInvalidRefreshToken();
      }

      return {
        tokenVersion: session.user.tokenVersion ?? 0,
        id: session.user.id,
        email: session.user.email,
        nickname: session.user.nickname,
        role: session.user.role,
        status: session.user.status,
      };
    });

    const { tokenVersion, ...publicUser } = user;
    return this.buildAuthTokenResponse(
      publicUser,
      nextRefreshToken,
      tokenVersion,
    );
  }

  async resetPassword(
    body: PasswordResetBody = {},
    metadata: RequestAuthMetadata = {},
  ) {
    await this.emailVerification.limit('complete', metadata);
    const email = authEmail(body.email);
    const password = this.parsePassword(body.password);
    const passwordHash = await argon2.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const evidence = await this.emailVerification.consume(
        tx,
        email,
        'password_reset',
        body.verificationToken,
      );
      if (!evidence.targetUserId) this.emailVerification.proofError();
      const [user] = await this.lockUser(tx, evidence.targetUserId);
      if (
        !user ||
        user.email !== email ||
        user.status !== UserStatus.active ||
        user.tokenVersion !== evidence.targetVersion
      )
        this.emailVerification.proofError();
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
          emailVerifiedAt: evidence.verifiedAt,
        },
      });
      await tx.refreshTokenSession.updateMany({
        where: { userId: user.id, status: RefreshTokenSessionStatus.active },
        data: {
          status: RefreshTokenSessionStatus.revoked,
          revokedAt: evidence.now,
        },
      });
    });
    return { success: true, data: { changed: true } };
  }

  private lockUser(tx: Prisma.TransactionClient, userId: string) {
    return tx.$queryRaw<
      {
        id: string;
        email: string;
        passwordHash: string;
        tokenVersion: number;
        status: UserStatus;
      }[]
    >`
      SELECT id, email, password_hash AS "passwordHash", token_version AS "tokenVersion", status
      FROM users WHERE id = ${userId} FOR UPDATE`;
  }

  async logout(body: RefreshTokenRequestBody = {}): Promise<LogoutResponse> {
    const refreshToken = this.parseOptionalRefreshToken(body.refreshToken);
    if (refreshToken) {
      await this.prisma.refreshTokenSession.updateMany({
        where: {
          tokenHash: this.hashRefreshToken(refreshToken),
          status: RefreshTokenSessionStatus.active,
        },
        data: {
          status: RefreshTokenSessionStatus.revoked,
          revokedAt: new Date(),
        },
      });
    }

    return {
      success: true,
      data: {
        revoked: Boolean(refreshToken),
      },
    };
  }

  async logoutAll(userId: string | undefined): Promise<LogoutResponse> {
    if (!userId) {
      this.throwUnauthorized();
    }

    await this.prisma.refreshTokenSession.updateMany({
      where: {
        userId,
        status: RefreshTokenSessionStatus.active,
      },
      data: {
        status: RefreshTokenSessionStatus.revoked,
        revokedAt: new Date(),
      },
    });

    return {
      success: true,
      data: {
        revoked: true,
      },
    };
  }

  async me(userId: string | undefined): Promise<CurrentUserResponse> {
    if (!userId) {
      this.throwUnauthorized();
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        email: true,
        nickname: true,
        profileImageUrl: true,
        portfolioPublic: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user) {
      this.throwUnauthorized();
    }

    if (user.status !== UserStatus.active) {
      this.throwUserNotActive();
    }

    return this.buildCurrentUserResponse(user);
  }

  async updateMe(
    userId: string | undefined,
    body: UpdateProfileRequestBody = {},
  ): Promise<CurrentUserResponse> {
    if (!userId) {
      this.throwUnauthorized();
    }

    const currentUser = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        email: true,
        nickname: true,
        profileImageUrl: true,
        portfolioPublic: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    if (!currentUser) {
      this.throwUnauthorized();
    }

    if (currentUser.status !== UserStatus.active) {
      this.throwUserNotActive();
    }

    const data: Prisma.UserUpdateInput = {};
    if (this.hasOwn(body, 'profileImageUrl')) {
      this.throwBadRequest(
        'PROFILE_IMAGE_READ_ONLY',
        'Use the profile image upload or delete endpoint.',
      );
    }
    if (this.hasOwn(body, 'nickname')) {
      const nickname = this.parseNickname(body.nickname);
      if (nickname !== currentUser.nickname) {
        const existingNickname = await this.prisma.user.findUnique({
          where: {
            nickname,
          },
          select: {
            id: true,
          },
        });

        if (existingNickname && existingNickname.id !== userId) {
          this.throwConflict(
            'NICKNAME_ALREADY_EXISTS',
            'Nickname already exists.',
          );
        }
      }

      data.nickname = nickname;
    }

    if (this.hasOwn(body, 'portfolioPublic')) {
      if (typeof body.portfolioPublic !== 'boolean') {
        this.throwBadRequest(
          'VALIDATION_ERROR',
          'portfolioPublic must be a boolean.',
        );
      }
      data.portfolioPublic = body.portfolioPublic;
    }

    if (Object.keys(data).length === 0) {
      return this.buildCurrentUserResponse(currentUser);
    }

    try {
      const updatedUser = await this.prisma.user.update({
        where: {
          id: userId,
        },
        data,
        select: {
          id: true,
          email: true,
          nickname: true,
          profileImageUrl: true,
          portfolioPublic: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      return this.buildCurrentUserResponse(updatedUser);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const targets = this.getUniqueConstraintTargets(error);
        if (targets.includes('nickname')) {
          this.throwConflict(
            'NICKNAME_ALREADY_EXISTS',
            'Nickname already exists.',
          );
        }
      }

      throw error;
    }
  }

  private buildCurrentUserResponse(
    user: PublicUserRecord,
  ): CurrentUserResponse {
    return {
      success: true,
      data: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        profileImageUrl: user.profileImageUrl,
        portfolioPublic: user.portfolioPublic,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  private parseSignupRequest(body: SignupRequestBody): ParsedSignupRequest {
    const email = this.parseEmail(body.email);
    const password = this.parsePassword(body.password);
    const nickname = this.parseNickname(body.nickname);

    return {
      email,
      password,
      nickname,
    };
  }

  private parseLoginRequest(body: LoginRequestBody): ParsedLoginRequest {
    return {
      email: this.parseEmail(body.email),
      password: this.parsePassword(body.password),
    };
  }

  private parseEmail(value: unknown) {
    return authEmail(value);
  }

  private parsePassword(value: unknown) {
    if (typeof value !== 'string' || value.length < 8) {
      this.throwBadRequest(
        'INVALID_PASSWORD',
        'Password must be at least 8 characters.',
      );
    }

    return value;
  }

  private parseNickname(value: unknown) {
    if (typeof value !== 'string') {
      this.throwBadRequest('INVALID_NICKNAME', 'Nickname is required.');
    }

    const nickname = value.trim();
    if (!nickname) {
      this.throwBadRequest('INVALID_NICKNAME', 'Nickname is required.');
    }

    return nickname;
  }

  private hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
    return Object.hasOwn(value, key);
  }

  private async verifyPassword(passwordHash: string, password: string) {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  private async buildAuthTokenResponse(
    user: AuthUser,
    refreshToken: RefreshTokenArtifacts,
    tokenVersion = 0,
  ): Promise<AuthTokenResponse> {
    const accessTokenExpiresIn = this.getAccessTtl();

    return {
      success: true,
      data: {
        user,
        tokens: {
          accessToken: await this.signAccessToken(
            user.id,
            accessTokenExpiresIn,
            tokenVersion,
          ),
          refreshToken: refreshToken.token,
          accessTokenExpiresIn,
          refreshTokenExpiresAt: refreshToken.expiresAt.toISOString(),
        },
      },
    };
  }

  private async createRefreshSession(
    client: Pick<PrismaService, 'refreshTokenSession'>,
    userId: string,
    metadata: RequestAuthMetadata,
    refreshToken: RefreshTokenArtifacts,
  ) {
    return client.refreshTokenSession.create({
      data: {
        userId,
        tokenHash: refreshToken.tokenHash,
        status: RefreshTokenSessionStatus.active,
        expiresAt: refreshToken.expiresAt,
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
      },
      select: {
        id: true,
      },
    });
  }

  private createRefreshTokenArtifacts(): RefreshTokenArtifacts {
    const token = randomBytes(REFRESH_TOKEN_BYTE_LENGTH).toString('base64url');

    return {
      token,
      tokenHash: this.hashRefreshToken(token),
      expiresAt: this.calculateExpiresAt(this.getRefreshTtl()),
    };
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseRefreshToken(value: unknown) {
    if (typeof value !== 'string') {
      this.throwInvalidRefreshToken();
    }

    const token = value.trim();
    if (!this.isValidRefreshToken(token)) {
      this.throwInvalidRefreshToken();
    }

    return token;
  }

  private parseOptionalRefreshToken(value: unknown) {
    if (typeof value !== 'string') {
      return null;
    }

    const token = value.trim();
    return this.isValidRefreshToken(token) ? token : null;
  }

  private isValidRefreshToken(token: string) {
    return REFRESH_TOKEN_PATTERN.test(token);
  }

  private signAccessToken(
    userId: string,
    expiresIn = this.getAccessTtl(),
    tokenVersion = 0,
  ) {
    return this.jwtService.signAsync(
      {
        sub: userId,
        tv: tokenVersion,
      },
      {
        secret: this.getAccessSecret(),
        expiresIn,
      },
    );
  }

  private getAccessSecret() {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET')?.trim();
    if (!secret) {
      throw new InternalServerErrorException(
        this.createErrorBody(
          'AUTH_CONFIGURATION_ERROR',
          'Auth configuration is missing.',
        ),
      );
    }

    return secret;
  }

  private getAccessTtl(): JwtExpiresIn {
    const ttl =
      this.configService.get<string>('JWT_ACCESS_TTL')?.trim() ||
      DEFAULT_ACCESS_TTL;
    return this.validateTtl(ttl);
  }

  private getRefreshTtl(): JwtExpiresIn {
    const ttl = this.configService.get<string>('REFRESH_TOKEN_TTL')?.trim();
    if (!ttl) {
      throw new InternalServerErrorException(
        this.createErrorBody(
          'AUTH_CONFIGURATION_ERROR',
          'Auth configuration is missing.',
        ),
      );
    }

    return this.validateTtl(ttl);
  }

  private validateAuthConfiguration() {
    this.getAccessSecret();
    this.getAccessTtl();
    this.getRefreshTtl();
  }

  private validateTtl(ttl: string): JwtExpiresIn {
    const match = /^(\d+)(s|m|h|d|w)$/.exec(ttl);
    if (match && Number(match[1]) > 0) {
      return ttl as JwtExpiresIn;
    }

    throw new InternalServerErrorException(
      this.createErrorBody(
        'AUTH_CONFIGURATION_ERROR',
        'Auth configuration is invalid.',
      ),
    );
  }

  private calculateExpiresAt(ttl: JwtExpiresIn) {
    const match = /^(\d+)(s|m|h|d|w)$/.exec(ttl);
    if (!match) {
      throw new InternalServerErrorException(
        this.createErrorBody(
          'AUTH_CONFIGURATION_ERROR',
          'Auth configuration is invalid.',
        ),
      );
    }

    const amount = Number(match[1]);
    const unit = match[2] as JwtTtlUnit;
    const unitMs: Record<JwtTtlUnit, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };

    return new Date(Date.now() + amount * unitMs[unit]);
  }

  private getUniqueConstraintTargets(error: unknown) {
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    return Array.isArray(target) ? target.map(String) : [];
  }

  private throwSignupUniqueConflict(error: unknown): never {
    const targets = this.getUniqueConstraintTargets(error);

    if (targets.includes('email')) {
      this.throwConflict('EMAIL_ALREADY_EXISTS', 'Email already exists.');
    }

    if (targets.includes('nickname')) {
      this.throwConflict('NICKNAME_ALREADY_EXISTS', 'Nickname already exists.');
    }

    this.throwConflict('AUTH_SIGNUP_CONFLICT', 'Signup conflicted.');
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private throwBadRequest(code: string, message: string): never {
    throw new BadRequestException(this.createErrorBody(code, message));
  }

  private throwConflict(code: string, message: string): never {
    throw new ConflictException(this.createErrorBody(code, message));
  }

  private throwInvalidCredentials(): never {
    throw new UnauthorizedException(
      this.createErrorBody('INVALID_CREDENTIALS', 'Invalid credentials.'),
    );
  }

  private throwUnauthorized(): never {
    throw new UnauthorizedException(
      this.createErrorBody('UNAUTHORIZED', 'Unauthorized'),
    );
  }

  private throwInvalidRefreshToken(): never {
    throw new UnauthorizedException(
      this.createErrorBody('INVALID_REFRESH_TOKEN', 'Invalid refresh token.'),
    );
  }

  private throwUserNotActive(): never {
    throw new ForbiddenException(
      this.createErrorBody('USER_NOT_ACTIVE', 'User is not active.'),
    );
  }

  private isUniqueConstraintError(error: unknown) {
    return (error as { code?: unknown }).code === 'P2002';
  }
}
