import { IsBoolean, IsNumberString, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

// MasterCrudPage's text inputs always send '' for an untouched optional field -
// normalize that (and undefined) to "not provided" before IsNumberString runs.
const blankToUndefined = ({ value }: { value: unknown }) => (value === '' || value === undefined ? undefined : value);

export class CreateUnitDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsNumberString()
  revenueSharePercent?: string;
}

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsNumberString()
  revenueSharePercent?: string;
}
