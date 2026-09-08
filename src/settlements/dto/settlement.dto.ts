import { ArrayNotEmpty, IsArray, IsDateString, IsOptional, IsString } from 'class-validator';

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

// Adds already-eligible Expenses (SETTLED, matched, same POD, not yet grouped)
// to an existing DRAFT Settlement - the "add to existing settlement" action on
// the web admin Settlement page.
export class AddExpensesToSettlementDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  expenseIds!: string[];
}

// "Buat baru" - the user's checked subset from the generate-preview table,
// committed as a brand-new Settlement instead of growing an existing DRAFT one.
export class CreateSettlementFromSelectionDto {
  @IsString()
  podId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  expenseIds!: string[];
}
