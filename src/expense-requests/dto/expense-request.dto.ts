import { ArrayUnique, IsArray, IsBoolean, IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateExpenseRequestDto {
  // Must be the "Karangan Bunga" ActivityType for now (checked in the service).
  @IsString()
  @IsNotEmpty()
  activityTypeId: string;

  // At least one of agencyIds / advertiserIds is required (checked in the service); several allowed.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  agencyIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  advertiserIds?: string[];

  // Optional; several allowed. Each Brand must belong to one of advertiserIds (checked in the service).
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  brandIds?: string[];

  // Optional; when given must be positive.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  budget?: number;

  @IsString()
  @IsNotEmpty()
  greetingText: string;

  @IsDateString()
  sendDate: string;

  @IsString()
  @IsNotEmpty()
  recipientAddress: string;

  @IsOptional()
  @IsString()
  logo?: string;

  // Head Dept step is Department-scoped. Optional when the caller belongs to exactly one Department.
  @IsOptional()
  @IsString()
  departmentId?: string;

  // Enter the Request on another user's behalf (they become requestedBy, the caller is stored as
  // createdById). Only for an Admin / holder of webmobile.request.expense.create.owndept (403
  // otherwise), and the requestor must hold Position SLS/STAFF/CO-CSO in the Request's Department.
  // Ignored on update - the requestor of an existing Request never changes.
  @IsOptional()
  @IsString()
  requestedById?: string;

  // true -> saved as an editable DRAFT with no approval chain started; submit later via POST :id/submit.
  @IsOptional()
  @IsBoolean()
  saveAsDraft?: boolean;
}

// Full replacement of a DRAFT's fields (same shape as create). saveAsDraft is ignored here.
export class UpdateExpenseRequestDto extends CreateExpenseRequestDto {}

// Sales Customer Service fills the budget once the approval chain is done.
export class SetExpenseRequestBudgetDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  budgetAmount: number;

  @IsOptional()
  @IsString()
  budgetNotes?: string;
}

// Corsec's Proceed/Cancel decision.
export class VerifyExpenseRequestDto {
  @IsIn(['PROCEED', 'CANCELLED'])
  decision: 'PROCEED' | 'CANCELLED';

  // Required when decision is CANCELLED (checked in the service).
  @IsOptional()
  @IsString()
  reason?: string;
}
