import { Module } from '@nestjs/common';
import { ApprovalLevelsController, ApprovalsController, PublicApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [ApprovalLevelsController, ApprovalsController, PublicApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
