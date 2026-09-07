import { Module } from '@nestjs/common';
import { AdvertisersController } from './advertisers.controller';
import { AdvertisersService } from './advertisers.service';

@Module({
  controllers: [AdvertisersController],
  providers: [AdvertisersService],
  exports: [AdvertisersService],
})
export class AdvertisersModule {}
