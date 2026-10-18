import { readAuthTrustProxyHops } from './auth/email-auth.config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { AdminDiagnosticLogger } from './common/admin-diagnostic.logger';
import { adminDiagnosticRequestMiddleware } from './common/admin-diagnostics';
import { createCorsOptions } from './common/cors.config';
import { assertNormalEnvironment } from '../scripts/load-test/manifest';
import { loadRuntimeEnv } from '../scripts/lib/load-runtime-env';

async function bootstrap() {
  loadRuntimeEnv();
  assertNormalEnvironment(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set(
    'trust proxy',
    readAuthTrustProxyHops(process.env.AUTH_TRUST_PROXY_HOPS),
  );
  app.useLogger(new AdminDiagnosticLogger());
  app.use(adminDiagnosticRequestMiddleware);
  app.enableCors(createCorsOptions());
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
