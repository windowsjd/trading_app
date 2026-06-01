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
  LogoutResponse,
  RefreshTokenRequestBody,
  RequestAuthMetadata,
  SignupRequestBody,
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
    const existingEmail = await this.prisma.user.findUnique({
      where: {
        email: request.email,
      },
      select: {
        id: true,
      },
    });

    if (existingEmail) {
      this.throwConflict('EMAIL_ALREADY_EXISTS', 'Email already exists.');
    }

    const existingNickname = await this.prisma.user.findUnique({
      where: {
        nickname: request.nickname,
      },
      select: {
        id: true,
      },
    });

    if (existingNickname) {
      this.throwConflict('NICKNAME_ALREADY_EXISTS', 'Nickname already exists.');
    }

    const passwordHash = await argon2.hash(request.password);
    const refreshToken = this.createRefreshTokenArtifacts();

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email: request.email,
            passwordHash,
            nickname: request.nickname,
            role: UserRole.user,
            status: UserStatus.active,
          },
          select: {
            id: true,
            email: true,
            nickname: true,
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
        nickname: true,
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

    return this.createAuthTokenResponse(
      {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        status: user.status,
      },
      metadata,
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
              status: true,
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
        id: session.user.id,
        email: session.user.email,
        nickname: session.user.nickname,
        status: session.user.status,
      };
    });

    return this.buildAuthTokenResponse(user, nextRefreshToken);
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

    return {
      success: true,
      data: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        profileImageUrl: user.profileImageUrl,
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
    if (typeof value !== 'string') {
      this.throwBadRequest('INVALID_EMAIL', 'Email must be a valid email.');
    }

    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.throwBadRequest('INVALID_EMAIL', 'Email must be a valid email.');
    }

    return email;
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
          ),
          refreshToken: refreshToken.token,
          accessTokenExpiresIn,
          refreshTokenExpiresAt: refreshToken.expiresAt.toISOString(),
        },
      },
    };
  }

  private async createAuthTokenResponse(
    user: AuthUser,
    metadata: RequestAuthMetadata,
  ) {
    const refreshToken = this.createRefreshTokenArtifacts();

    await this.createRefreshSession(
      this.prisma,
      user.id,
      metadata,
      refreshToken,
    );

    return this.buildAuthTokenResponse(user, refreshToken);
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

  private signAccessToken(userId: string, expiresIn = this.getAccessTtl()) {
    return this.jwtService.signAsync(
      {
        sub: userId,
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
