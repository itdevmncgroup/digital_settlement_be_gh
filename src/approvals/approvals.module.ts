import { Module } from '@nestjs/common';
import { ApprovalLevelsController, ApprovalsController, PublicApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { EmailModule } from '../email/email.module';
import { ExternalSyncModule } from '../external-sync/external-sync.module';

@Module({
  imports: [EmailModule, ExternalSyncModule],
  controllers: [ApprovalLevelsController, ApprovalsController, PublicApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
