import { Module } from '@nestjs/common';
import { AuditReportController } from './audit-report.controller';
import { AuditReportService } from './audit-report.service';

@Module({
  controllers: [AuditReportController],
  providers: [AuditReportService],
})
export class AuditReportModule {}
