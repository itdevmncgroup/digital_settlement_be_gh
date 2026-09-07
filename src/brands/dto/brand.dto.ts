import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateBrandDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  // Every Brand belongs to exactly one Advertiser (1:N, never shared).
  @IsString()
  advertiserId: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  advertiserId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
