import { ArrayNotEmpty, IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  employeeId: string;

  @IsString()
  name: string;

  @IsEmail()
  email: string;

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

  @IsString()
  @MinLength(8)
  password: string;

  // Role.name is free text now (Admin can create custom roles) - validated
  // dynamically against the roles table in UsersService, not a fixed enum.
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roles: string[];
}
