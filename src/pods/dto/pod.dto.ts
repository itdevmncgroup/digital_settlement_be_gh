import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsOptional, IsString, ValidateNested } from 'class-validator';

export class PodAssignmentInputDto {
  @IsString()
  agencyId: string;

  @IsString()
  brandId: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

export class CreatePodDto {
  @IsString()
  name: string;

  // Initial Sales members (optional - more can be added later via /pods/:id/members).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  salesIds?: string[];

  // A Brand may appear at most once per POD - enforced again server-side
  // (PodAssignment.@@unique([podId, brandId])). One Agency can cover many Brands.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PodAssignmentInputDto)
  assignments?: PodAssignmentInputDto[];
}

export class UpdatePodDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AddPodAssignmentDto extends PodAssignmentInputDto {}

// Who holds a given Position (e.g. "Head POD") specifically for this POD -
// feeds the POD-scoped Approval Level engine (see ApprovalsService).
export class AddPodApproverDto {
  @IsString()
  positionId: string;

  @IsString()
  userId: string;
}

export class AddPodMemberDto {
  @IsString()
  salesId: string;
}
