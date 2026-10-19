import { HttpStatus, Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import type { PushNotificationType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** The seven user-facing switches, in settings order. */
export const PREFERENCE_KEYS = [
  'tradeFill',
  'futuresLiquidation',
  'orderFailure',
  'friendRequest',
  'importantNotice',
  'seasonFinalResult',
  'seasonEndingSoon',
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
export type NotificationPreferences = Record<PreferenceKey, boolean>;
/** 전체 알림: off holds every type without rewriting the switches above, so
 * turning it back on restores them; stored in the same row for every device. */
export const ALL_ENABLED_KEY = 'allEnabled';
type StoredPreferences = Partial<NotificationPreferences> & {
  allEnabled?: boolean;
};

export const PREFERENCE_KEY_BY_TYPE: Record<
  PushNotificationType,
  PreferenceKey
> = {
  trade_fill: 'tradeFill',
  futures_liquidation: 'futuresLiquidation',
  order_failure: 'orderFailure',
  friend_request: 'friendRequest',
  important_notice: 'importantNotice',
  season_final_result: 'seasonFinalResult',
  season_ending_soon: 'seasonEndingSoon',
};

/** Every type is on until the user turns it off. */
export const DEFAULT_PREFERENCES: NotificationPreferences = Object.freeze({
  tradeFill: true,
  futuresLiquidation: true,
  orderFailure: true,
  friendRequest: true,
  importantNotice: true,
  seasonFinalResult: true,
  seasonEndingSoon: true,
});

export function preferenceEnabled(
  row: StoredPreferences | null | undefined,
  type: PushNotificationType,
): boolean {
  return (
    (row?.allEnabled ?? true) && (row?.[PREFERENCE_KEY_BY_TYPE[type]] ?? true)
  );
}

function pick(row: (NotificationPreferences & { allEnabled: boolean }) | null) {
  const preferences = row
    ? (Object.fromEntries(
        PREFERENCE_KEYS.map((key) => [key, row[key]]),
      ) as NotificationPreferences)
    : { ...DEFAULT_PREFERENCES };
  return { allEnabled: row?.allEnabled ?? true, preferences };
}

/** In-app notification switches. Stored per user in PostgreSQL; a response
 * is always the committed row, so the app never shows an unsaved state as
 * saved. The OS permission is the device's own, separate state. */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  private fail(status: HttpStatus, code: string, message: string): never {
    throw createApiError(code, message, status);
  }

  private viewer(userId: string | undefined): string {
    if (!userId)
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    return userId;
  }

  async get(userId: string | undefined) {
    const viewer = this.viewer(userId);
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId: viewer },
    });
    return { success: true, data: pick(row) };
  }

  async update(userId: string | undefined, body: unknown) {
    const viewer = this.viewer(userId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_NOTIFICATION_PREFERENCES',
        'A preferences object is required.',
      );
    const entries = Object.entries(body as Record<string, unknown>);
    if (
      !entries.length ||
      entries.some(
        ([key, value]) =>
          !(
            (PREFERENCE_KEYS as readonly string[]).includes(key) ||
            key === ALL_ENABLED_KEY
          ) || typeof value !== 'boolean',
      )
    )
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_NOTIFICATION_PREFERENCES',
        'Only known notification types with true/false values are accepted.',
      );
    const patch = Object.fromEntries(entries) as StoredPreferences;
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId: viewer },
      create: {
        userId: viewer,
        allEnabled: true,
        ...DEFAULT_PREFERENCES,
        ...patch,
      },
      update: patch,
    });
    return { success: true, data: pick(row) };
  }
}
