import { Module } from '@nestjs/common';
import { BankMatchingController } from './bank-matching.controller';
import { BankMatchingService } from './bank-matching.service';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  imports: [ApprovalsModule],
  controllers: [BankMatchingController],
  providers: [BankMatchingService],
  exports: [BankMatchingService],
})
export class BankMatchingModule {}
