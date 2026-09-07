import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

// Role.name is free text now (Admin can create custom roles) - the actual set
// of valid names is validated dynamically against the roles table in
// UsersService, not against a fixed enum here.
export class AssignRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roles: string[];
}
