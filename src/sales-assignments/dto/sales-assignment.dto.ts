import { IsDateString, IsOptional, IsString } from 'class-validator';

export class CreateSalesAssignmentDto {
  @IsString()
  salesId: string;

  @IsString()
  unitId: string;

  @IsDateString()
  effectiveDate: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
