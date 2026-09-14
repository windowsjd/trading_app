import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { AdminDiagnosticLogger } from './common/admin-diagnostic.logger';
import { adminDiagnosticRequestMiddleware } from './common/admin-diagnostics';
import { createCorsOptions } from './common/cors.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useLogger(new AdminDiagnosticLogger());
  app.use(adminDiagnosticRequestMiddleware);
  app.enableCors(createCorsOptions());
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
