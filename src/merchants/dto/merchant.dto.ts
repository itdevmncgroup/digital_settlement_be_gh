import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateMerchantDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  alias?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateMerchantDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  alias?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
