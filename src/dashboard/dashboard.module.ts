import { Module } from '@nestjs/common';
import { DashboardController, MyDashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  imports: [ApprovalsModule],
  controllers: [DashboardController, MyDashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
