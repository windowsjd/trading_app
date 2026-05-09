import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { FxModule } from './fx/fx.module';
import { HomeModule } from './home/home.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { RankingModule } from './ranking/ranking.module';
import { RecordsModule } from './records/records.module';
import { SeasonsModule } from './seasons/seasons.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
    }),
    AuthModule,
    FxModule,
    HomeModule,
    OrdersModule,
    PrismaModule,
    RankingModule,
    RecordsModule,
    SeasonsModule,
    WalletsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
