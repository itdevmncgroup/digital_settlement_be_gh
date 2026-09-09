import { ArrayNotEmpty, IsArray, IsDateString, IsOptional, IsString } from 'class-validator';

// Admin/Finance only - create on behalf of another Sales, same "on behalf" pattern
// as CreateExpenseDto.salesId. Ignored for a plain Sales caller, who can only ever
// create settlements for their own Department.
export class CreateSettlementDto {
  @IsOptional()
  @IsString()
  salesId?: string;
}

// Backs the Settlement page's "Create Settlement" popup: pick one Department +
// a date range, generate one Settlement scoped to just that
// Department/range. A plain Sales caller may only target their own
// Department (enforced in the service).
export class GenerateSettlementDto {
  @IsString()
  departmentId!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;
}

// Adds already-eligible Expenses (SETTLED, matched, same Department, not yet
// grouped) to an existing DRAFT Settlement - the "add to existing settlement"
// action on the web admin Settlement page.
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
  departmentId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  expenseIds!: string[];
}
