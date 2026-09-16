import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  positionId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];

  @IsOptional()
  @IsString()
  unitId?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
