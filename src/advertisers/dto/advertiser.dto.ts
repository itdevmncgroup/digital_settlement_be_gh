import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateAdvertiserDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsString()
  agencyId: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateAdvertiserDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  agencyId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
