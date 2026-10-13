import { Module } from '@nestjs/common';
import { ApprovalLevelsController, ApprovalRollbackController, ApprovalsController, PublicApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [EmailModule, NotificationsModule],
  controllers: [ApprovalLevelsController, ApprovalRollbackController, ApprovalsController, PublicApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
