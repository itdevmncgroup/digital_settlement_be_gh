/*
  Warnings:

  - Changed the type of `name` on the `roles` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "permissions" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Convert "name" from the RoleName enum to free text, preserving existing values.
-- The unique index on "name" (roles_name_key, from the init migration) stays intact.
ALTER TABLE "roles" ALTER COLUMN "name" TYPE TEXT USING "name"::text;
