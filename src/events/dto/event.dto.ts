import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class EventParticipantDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsOptional()
  @IsString()
  company?: string;
}

export class CreateEventDto {
  // Admin/Finance only - create on behalf of another Sales for manual/historical
  // entry (BRD section 5.3). Ignored for a Sales-role caller.
  @IsOptional()
  @IsString()
  salesId?: string;

  // Which Department this Pre-Event falls under - determines the
  // Department-scoped Approval Level chain (e.g. "Head -> Supervisor").
  // Optional: defaults to the target Sales' own Department.
  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsString()
  advertiserId: string;

  @IsString()
  brandId: string;

  @IsString()
  activityTypeId: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  startTime?: string;

  @IsOptional()
  @IsString()
  endTime?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsString()
  purpose: string;

  @IsNumber()
  @Min(0)
  estimatedAmount: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => EventParticipantDto)
  participants?: EventParticipantDto[];
}

export class UpdateEventDto {
  // Admin/Finance only - reassign this Pre-Event to another Sales. Ignored for
  // a plain Sales caller (can only ever own their own).
  @IsOptional()
  @IsString()
  salesId?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

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
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  startTime?: string;

  @IsOptional()
  @IsString()
  endTime?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedAmount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

