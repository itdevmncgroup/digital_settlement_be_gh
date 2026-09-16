import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ApprovalScopeType, DocumentStage } from '@prisma/client';

export class ApprovalLevelStepInputDto {
  @IsString()
  positionId: string;
}

export class CreateApprovalLevelDto {
  @IsString()
  name: string;

  @IsEnum(DocumentStage)
  documentStage: DocumentStage;

  @IsOptional()
  @IsEnum(ApprovalScopeType)
  scopeType?: ApprovalScopeType;

  // Departments this Level applies to when scopeType is DEPARTMENT - can list
  // several (e.g. one CO-CSO-1 chain covering POD 1/4/5/6 at once).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];

  // Position(s) the requestor (Expense/Event sales) must hold for this Level to
  // match - e.g. a Sales requestor's Expense matches a HEAD_POD-first chain,
  // while a HEAD_POD requestor's own Expense matches a CO-CSO-first chain.
  // Empty/omitted matches any requestor.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requestorPositionIds?: string[];

  @IsNumber()
  @Min(0)
  minAmount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number;

  // Ordered approval chain, e.g. [Head, Supervisor] - step order is the array order.
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ApprovalLevelStepInputDto)
  steps: ApprovalLevelStepInputDto[];
}

export class UpdateApprovalLevelDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(ApprovalScopeType)
  scopeType?: ApprovalScopeType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requestorPositionIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  minAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovalLevelStepInputDto)
  steps?: ApprovalLevelStepInputDto[];
}
