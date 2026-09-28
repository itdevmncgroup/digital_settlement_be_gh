-- Role.name is free text (see schema.prisma Role model comment); this renames
-- the built-in ADMIN role's display/lookup value to ADMINISTRATOR to match
-- src/common/constants/role-name.ts RoleName.ADMIN's new value.
UPDATE "roles" SET "name" = 'ADMINISTRATOR' WHERE "name" = 'ADMIN';
