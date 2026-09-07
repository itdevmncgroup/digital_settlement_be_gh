import { SetMetadata } from '@nestjs/common';
import { RoleName } from '../constants/role-name';

export const ROLES_KEY = 'roles';

/** Restrict an endpoint to one or more roles (BRD section 5). */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
