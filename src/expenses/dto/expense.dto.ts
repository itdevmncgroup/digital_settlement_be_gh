import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ParticipantCategory, PaymentMethodType } from '@prisma/client';

export class ExpenseItemDto {
  @IsString()
  description: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  categoryId?: string;
}

// Agency/Advertiser/Employee attendee (name + jabatan) attached to an Expense.
export class ExpenseParticipantDto {
  @IsEnum(ParticipantCategory)
  category: ParticipantCategory;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsOptional()
  @IsString()
  company?: string;

  // Which already-selected Agency/Advertiser this participant belongs to
  // (AGENCY/ADVERTISER category), from the mobile app's Agency/Advertiser
  // Participant comboboxes.
  @IsOptional()
  @IsString()
  agencyId?: string;

  @IsOptional()
  @IsString()
  advertiserId?: string;

  // Which Unit an internal/EMPLOYEE-category participant belongs to.
  @IsOptional()
  @IsString()
  unitId?: string;
}

// Pre-Event is retired (BR-002/BR-003): unitId/advertiserId/brandId/activityTypeId
// are always required and always supplied directly by the caller. See ExpensesService.create.
export class CreateExpenseDto {
  // Admin/Finance only - create on behalf of another Sales for historical/corrective
  // entry (BRD section 5.3 "Finance ... memperbaiki master data"). Ignored for a
  // Sales-role caller, who can only create their own.
  @IsOptional()
  @IsString()
  salesId?: string;

  @IsOptional()
  @IsString()
  podId?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  unitId?: string;

  @IsOptional()
  @IsString()
  advertiserId?: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  activityTypeId?: string;

  @IsOptional()
  @IsString()
  costCenterId?: string;

  @IsOptional()
  @IsEnum(PaymentMethodType)
  paymentMethodType?: PaymentMethodType;

  @IsOptional()
  @IsString()
  paymentMethodNote?: string;

  @IsOptional()
  @IsString()
  creditCardId?: string;

  @IsOptional()
  @IsString()
  merchantName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsDateString()
  expenseDate: string;

  @IsString()
  purpose: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ExpenseItemDto)
  items?: ExpenseItemDto[];

  // Brands beyond the single Brand inherited from the approved Pre-Event.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraBrandIds?: string[];

  // Agencies/Advertisers beyond the single Advertiser inherited from the
  // approved Pre-Event - same "additional, add/remove" pattern as extraBrandIds.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraAgencyIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraAdvertiserIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseParticipantDto)
  participants?: ExpenseParticipantDto[];
}

export class UpdateExpenseDto {
  @IsOptional()
  @IsString()
  costCenterId?: string;

  @IsOptional()
  @IsEnum(PaymentMethodType)
  paymentMethodType?: PaymentMethodType;

  @IsOptional()
  @IsString()
  paymentMethodNote?: string;

  @IsOptional()
  @IsString()
  creditCardId?: string;

  @IsOptional()
  @IsString()
  merchantName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseItemDto)
  items?: ExpenseItemDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraBrandIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraAgencyIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraAdvertiserIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseParticipantDto)
  participants?: ExpenseParticipantDto[];
}
