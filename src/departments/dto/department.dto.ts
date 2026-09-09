import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsOptional, IsString, ValidateNested } from 'class-validator';

export class DepartmentAssignmentInputDto {
  @IsString()
  agencyId: string;

  @IsString()
  brandId: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

export class CreateDepartmentDto {
  // Org code (e.g. "SALES_MKT") - optional since a Department created as a
  // named Sales coverage group (e.g. "POD 1") won't always have one.
  @IsOptional()
  @IsString()
  code?: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // A Brand may appear at most once per Department - enforced again
  // server-side (DepartmentAssignment.@@unique([departmentId, brandId])).
  // One Agency can cover many Brands.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DepartmentAssignmentInputDto)
  assignments?: DepartmentAssignmentInputDto[];
}

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AddDepartmentAssignmentDto extends DepartmentAssignmentInputDto {}

// Who holds a given Position (e.g. "Head") specifically for this Department -
// feeds the Department-scoped Approval Level engine (see ApprovalsService).
export class AddDepartmentApproverDto {
  @IsString()
  positionId: string;

  @IsString()
  userId: string;
}
