import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Corporate Card (paymentMethod.code === 'CORPORATE_CARD') vs everything else - a
// Settlement may never mix the two (see SettlementsService.groupOfExpense).
export const PAYMENT_METHOD_GROUPS = ['CORPORATE_CARD', 'NON_CORPORATE_CARD'] as const;
export type PaymentMethodGroup = (typeof PAYMENT_METHOD_GROUPS)[number];

// Admin/Finance only - create on behalf of another Sales, same "on behalf" pattern
// as CreateExpenseDto.salesId. Ignored for a plain Sales caller, who can only ever
// create settlements for their own Department.
export class CreateSettlementDto {
  @IsOptional()
  @IsString()
  salesId?: string;
}

// Backs the Settlement page's "Create Settlement" popup: pick one Department +
// a date range + a payment method group, generate one Settlement scoped to just
// that Department/range/group. A plain Sales caller may only target their own
// Department (enforced in the service).
export class GenerateSettlementDto {
  @IsString()
  departmentId!: string;

  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsIn(PAYMENT_METHOD_GROUPS)
  paymentMethodGroup!: PaymentMethodGroup;

  // Narrows the preview to one specific Corporate Card (a Department can hold
  // more than one) - ignored for NON_CORPORATE_CARD.
  @IsOptional()
  @IsString()
  creditCardId?: string;

  // Narrows the preview to Expenses of these Activity Types - blank/omitted
  // means any Activity Type.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  activityTypeIds?: string[];
}

// Adds already-eligible Expenses (SETTLED, matched, same Department, not yet
// grouped) to an existing DRAFT Settlement - the "add to existing settlement"
// action on the web admin Settlement page.
export class SendDraftPrDto {
  @IsString()
  unitId!: string;
}

export class AddExpensesToSettlementDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  expenseIds!: string[];
}

// One row of the Create Settlement popup's Unit/Persentase/... section (added
// dynamically, one per Unit split). originalPrice/unitPrice/totalPrice are
// never accepted from the client - the service always recomputes them from
// the Settlement's own total * percentage (see SettlementsService.buildAllocationRow).
export class SettlementAllocationRowDto {
  @IsString()
  unitId!: string;

  @IsNumber()
  percentage!: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  analyticAcc?: string;

  @IsOptional()
  @IsString()
  account?: string;

  @IsOptional()
  @IsString()
  wilayah?: string;

  @IsOptional()
  @IsString()
  linePr?: string;

  @IsOptional()
  @IsNumber()
  qty?: number;

  @IsOptional()
  @IsString()
  curr?: string;

  @IsOptional()
  @IsNumber()
  rate?: number;
}

// Edit of a DRAFT_SETTLEMENT - full replacement of the member Expense set and
// (when sent) the allocation rows. Department and payment method group are
// fixed at creation and never editable here.
export class UpdateSettlementDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  expenseIds!: string[];

  // Omitted = keep the existing rows (their amounts are recomputed against the
  // new total); sent (even empty) = replace all rows.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SettlementAllocationRowDto)
  allocations?: SettlementAllocationRowDto[];
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

  @IsIn(PAYMENT_METHOD_GROUPS)
  paymentMethodGroup!: PaymentMethodGroup;

  // Same Corporate Card filter as GenerateSettlementDto - re-validated here so a
  // stale/tampered selection can't slip in an Expense on a different card.
  @IsOptional()
  @IsString()
  creditCardId?: string;

  // The Unit/Persentase/Analytic Acc/... rows entered below the Expense list in
  // the Create Settlement popup - optional so existing callers/tests still work.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SettlementAllocationRowDto)
  allocations?: SettlementAllocationRowDto[];
}
