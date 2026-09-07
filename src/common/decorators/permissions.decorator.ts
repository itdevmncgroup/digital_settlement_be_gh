import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Grants access to a route when the user holds one of these Permission codes
 * (from the Role/Permission master, see prisma Permission/RolePermission),
 * even if @Roles() on the same route does not list their role. Evaluated as
 * OR against @Roles() by RolesGuard - either one being satisfied is enough.
 */
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);
