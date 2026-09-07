// Role.name (see prisma/schema.prisma) is free text now - Admin can create
// custom roles via the Role master page (POST /roles). This constant is NOT
// backed by that column; it just keeps the `RoleName.SALES` call-site syntax
// for the ~30 `@Roles(RoleName.X)` guards across the API that protect the
// app's built-in feature set. A custom role has no guard wired to it here and
// is not part of this list - it simply carries no extra access until a
// developer adds one.
export const RoleName = {
  SALES: 'SALES',
  SALES_ADMIN: 'SALES_ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  FINANCE: 'FINANCE',
  ADMIN: 'ADMIN',
  MANAGEMENT: 'MANAGEMENT',
} as const;

export type RoleName = (typeof RoleName)[keyof typeof RoleName];
