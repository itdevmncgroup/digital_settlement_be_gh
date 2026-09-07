import { Module } from '@nestjs/common';
import { SalesAssignmentsController } from './sales-assignments.controller';
import { SalesAssignmentsService } from './sales-assignments.service';

@Module({
  controllers: [SalesAssignmentsController],
  providers: [SalesAssignmentsService],
  exports: [SalesAssignmentsService],
})
export class SalesAssignmentsModule {}
