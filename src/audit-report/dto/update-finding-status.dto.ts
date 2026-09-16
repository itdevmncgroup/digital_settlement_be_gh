import { IsIn, IsOptional, IsString } from 'class-validator';
import { AuditFindingStatus } from '@prisma/client';

const STATUS_VALUES: AuditFindingStatus[] = ['OPEN', 'FOLLOW_UP', 'INVESTIGATING', 'RESOLVED'];

export class UpdateAuditFindingStatusDto {
  @IsIn(STATUS_VALUES)
  status: AuditFindingStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
