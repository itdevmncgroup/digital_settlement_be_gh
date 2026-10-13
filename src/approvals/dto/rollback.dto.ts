import { Type } from 'class-transformer';
import { IsInt, IsString, Min, MinLength } from 'class-validator';

// How many approval tiers to rewind - the upper bound depends on the document's
// current step, so it is checked in ApprovalsService.rollbackApproval.
export class RollbackDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  steps: number;

  @IsString()
  @MinLength(3)
  reason: string;
}
