import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { BatchModule } from './batch/batch.module';
import { GlobalHttpExceptionFilter } from './common/global-http-exception.filter';
import { FxModule } from './fx/fx.module';
import { HomeModule } from './home/home.module';
import { OperatorModule } from './operator/operator.module';
import { OpsModule } from './ops/ops.module';
import { OrdersModule } from './orders/orders.module';
import { PositionsModule } from './positions/positions.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProvidersModule } from './providers/providers.module';
import { RankingModule } from './ranking/ranking.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RecordsModule } from './records/records.module';
import { RewardsModule } from './rewards/rewards.module';
import { RedisModule } from './redis/redis.module';
import { SeasonsModule } from './seasons/seasons.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env.development', '.env'],
    }),
    AssetsModule,
    AuthModule,
    BatchModule,
    FxModule,
    HomeModule,
    OperatorModule,
    OpsModule,
    OrdersModule,
    PositionsModule,
    PortfolioModule,
    PrismaModule,
    ProvidersModule,
    RankingModule,
    RealtimeModule,
    RedisModule,
    RecordsModule,
    RewardsModule,
    SeasonsModule,
    WalletsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
  ],
})
export class AppModule {}
