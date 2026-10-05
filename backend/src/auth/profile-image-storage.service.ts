import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  PROFILE_IMAGE_ENV_KEYS,
  type ProfileImageStorageConfig,
  readProfileImageStorageConfig,
} from './profile-image.config';
import { profileImageError } from './profile-image.validation';

const UUID_V4 =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

@Injectable()
export class ProfileImageStorageService implements OnModuleDestroy {
  private readonly config: ProfileImageStorageConfig | null;
  private readonly client: S3Client | null;

  constructor(configService: ConfigService) {
    this.config = readProfileImageStorageConfig(
      Object.fromEntries(
        PROFILE_IMAGE_ENV_KEYS.map((key) => [
          key,
          configService.get<unknown>(key),
        ]),
      ),
    );
    this.client = this.config
      ? new S3Client({
          endpoint: this.config.endpoint,
          region: this.config.region,
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          },
          forcePathStyle: true,
          maxAttempts: 2,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
        })
      : null;
  }

  requireConfigured() {
    if (!this.config || !this.client) {
      throw new ServiceUnavailableException(
        profileImageError(
          'PROFILE_IMAGE_STORAGE_UNAVAILABLE',
          'Profile image storage is unavailable.',
        ),
      );
    }
    return { config: this.config, client: this.client };
  }

  publicUrl(key: string): string {
    return `${this.requireConfigured().config.publicBaseUrl}/${key}`;
  }

  managedKey(url: string | null, userId: string): string | null {
    if (!url || !this.config || !/^[a-zA-Z0-9-]+$/.test(userId)) return null;
    const prefix = `${this.config.publicBaseUrl}/profile-images/${userId}/`;
    if (!url.startsWith(prefix)) return null;
    const filename = url.slice(prefix.length);
    if (!new RegExp(`^${UUID_V4}\\.jpg$`).test(filename)) return null;
    return `profile-images/${userId}/${filename}`;
  }

  async upload(key: string, bytes: Buffer): Promise<void> {
    const { client, config } = this.requireConfigured();
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
        ContentLength: bytes.length,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
  }

  async delete(key: string): Promise<void> {
    const { client, config } = this.requireConfigured();
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }

  onModuleDestroy() {
    this.client?.destroy();
  }
}
