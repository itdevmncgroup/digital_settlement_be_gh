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

  @IsOptional()
  @IsString()
  departmentId?: string;

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
  @IsString()
  departmentId?: string;

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
