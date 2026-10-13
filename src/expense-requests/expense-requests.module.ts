import { Module } from '@nestjs/common';
import { ExpenseRequestsController } from './expense-requests.controller';
import { ExpenseRequestsService } from './expense-requests.service';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ApprovalsModule, NotificationsModule],
  controllers: [ExpenseRequestsController],
  providers: [ExpenseRequestsService],
})
export class ExpenseRequestsModule {}
