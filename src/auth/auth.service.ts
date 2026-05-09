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
import { UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AuthTokenResponse,
  AuthUser,
  CurrentUserResponse,
  LoginRequestBody,
  SignupRequestBody,
} from './auth.types';

type JwtTtlUnit = 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'y';
type JwtExpiresIn =
  | `${number}`
  | `${number}${JwtTtlUnit}`
  | `${number} ${JwtTtlUnit}`;

type ParsedSignupRequest = {
  email: string;
  password: string;
  nickname: string;
};

type ParsedLoginRequest = {
  email: string;
  password: string;
};

const DEFAULT_ACCESS_TTL: JwtExpiresIn = '15m';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.getAccessSecret();
  }

  async signup(body: SignupRequestBody = {}): Promise<AuthTokenResponse> {
    const request = this.parseSignupRequest(body);
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

    try {
      const user = await this.prisma.user.create({
        data: {
          email: request.email,
          passwordHash,
          nickname: request.nickname,
          status: UserStatus.active,
        },
        select: {
          id: true,
          email: true,
          nickname: true,
          status: true,
        },
      });

      return this.buildAuthTokenResponse(user);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        this.throwSignupUniqueConflict(error);
      }

      throw error;
    }
  }

  async login(body: LoginRequestBody = {}): Promise<AuthTokenResponse> {
    const request = this.parseLoginRequest(body);
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

    return this.buildAuthTokenResponse({
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      status: user.status,
    });
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
  ): Promise<AuthTokenResponse> {
    return {
      success: true,
      data: {
        user,
        tokens: {
          accessToken: await this.signAccessToken(user.id),
        },
      },
    };
  }

  private signAccessToken(userId: string) {
    return this.jwtService.signAsync(
      {
        sub: userId,
      },
      {
        secret: this.getAccessSecret(),
        expiresIn: this.getAccessTtl(),
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
    if (/^\d+(?:\s?(?:ms|s|m|h|d|w|y))?$/.test(ttl)) {
      return ttl as JwtExpiresIn;
    }

    throw new InternalServerErrorException(
      this.createErrorBody(
        'AUTH_CONFIGURATION_ERROR',
        'Auth configuration is invalid.',
      ),
    );
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

  private throwUserNotActive(): never {
    throw new ForbiddenException(
      this.createErrorBody('USER_NOT_ACTIVE', 'User is not active.'),
    );
  }

  private isUniqueConstraintError(error: unknown) {
    return (error as { code?: unknown }).code === 'P2002';
  }
}
