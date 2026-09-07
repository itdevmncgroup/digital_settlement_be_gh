import { Module } from '@nestjs/common';
import { PodsController } from './pods.controller';
import { PodsService } from './pods.service';

@Module({
  controllers: [PodsController],
  providers: [PodsService],
  exports: [PodsService],
})
export class PodsModule {}
