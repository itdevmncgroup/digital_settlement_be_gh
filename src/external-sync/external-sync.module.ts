import { Module } from '@nestjs/common';
import { ExternalSettlementsController } from './external-sync.controller';
import { ExternalSyncService } from './external-sync.service';

@Module({
  controllers: [ExternalSettlementsController],
  providers: [ExternalSyncService],
  exports: [ExternalSyncService],
})
export class ExternalSyncModule {}
