import { Module } from '@nestjs/common';
import { ApprovalLevelsController, ApprovalsController, PublicApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { EmailModule } from '../email/email.module';
import { ExternalSyncModule } from '../external-sync/external-sync.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [EmailModule, ExternalSyncModule, NotificationsModule],
  controllers: [ApprovalLevelsController, ApprovalsController, PublicApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
