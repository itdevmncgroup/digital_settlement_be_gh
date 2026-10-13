import { Module } from '@nestjs/common';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';
import { SettlementPdfService } from './settlement-pdf.service';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ExternalSyncModule } from '../external-sync/external-sync.module';

@Module({
  imports: [ApprovalsModule, ExternalSyncModule],
  controllers: [SettlementsController],
  providers: [SettlementsService, SettlementPdfService],
})
export class SettlementsModule {}
