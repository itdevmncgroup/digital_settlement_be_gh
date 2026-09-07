import { IsDateString, IsOptional, IsString } from 'class-validator';

// Admin/Finance only - create on behalf of another Sales, same "on behalf" pattern
// as CreateExpenseDto.salesId. Ignored for a plain Sales caller, who can only ever
// create settlements for their own PODs.
export class CreateSettlementDto {
  @IsOptional()
  @IsString()
  salesId?: string;
}

// Backs the Settlement page's "Create Settlement" popup: pick one POD + a date
// range, generate one Settlement scoped to just that POD/range. A plain Sales
// caller may only target a POD they're a member of (enforced in the service).
export class GenerateSettlementDto {
  @IsString()
  podId!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;
}
