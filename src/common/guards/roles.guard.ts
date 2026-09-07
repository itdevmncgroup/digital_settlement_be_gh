import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '../constants/role-name';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const hasRoleGate = requiredRoles && requiredRoles.length > 0;
    const hasPermissionGate = requiredPermissions && requiredPermissions.length > 0;

    if (!hasRoleGate && !hasPermissionGate) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser | undefined;

    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }

    // @Roles() and @RequirePermission() on the same route are OR'd - a
    // Permission granted via the Role/Permission master (see roles.controller)
    // opens the route even for a role missing from the hardcoded @Roles list.
    const hasRole = hasRoleGate && requiredRoles!.some((role) => user.roles.includes(role));
    const hasPermission = hasPermissionGate && requiredPermissions!.some((p) => user.permissions?.includes(p));

    if (hasRole || hasPermission) {
      return true;
    }

    const reasons = [
      hasRoleGate ? `role in [${requiredRoles!.join(', ')}]` : null,
      hasPermissionGate ? `permission in [${requiredPermissions!.join(', ')}]` : null,
    ].filter(Boolean);
    throw new ForbiddenException(`Requires ${reasons.join(' or ')}`);
  }
}
