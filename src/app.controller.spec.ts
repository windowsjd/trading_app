jest.mock('./prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const appService = {
      getHealth: jest.fn().mockReturnValue({
        success: true,
        data: {
          service: 'ok',
        },
      }),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: appService,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('should return service health status', () => {
      expect(appController.getHealth()).toEqual({
        success: true,
        data: {
          service: 'ok',
        },
      });
    });
  });
});
