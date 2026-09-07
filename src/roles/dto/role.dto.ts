import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Role.name is free text (Admin can create custom roles beyond the 5 built-in
// ones) - uppercase/underscore only, matching the existing SALES/ADMIN/... style,
// since it's echoed in JWT claims and `Requires one of roles: X` guard errors.
const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(NAME_PATTERN, { message: 'name must be uppercase letters, numbers and underscores, starting with a letter' })
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(NAME_PATTERN, { message: 'name must be uppercase letters, numbers and underscores, starting with a letter' })
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
