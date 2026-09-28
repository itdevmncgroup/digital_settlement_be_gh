-- SUPERVISOR and FINANCE removed as Roles - their back-office override access
-- (see scope.util.ts's BACK_OFFICE_ROLES/isBackOffice()/canUploadExpenseFiles)
-- folded into ADMIN only. RoleName backs no table column (see its comment in
-- schema.prisma), so this is a pure type recreation - no ALTER TABLE needed.
-- AlterEnum
BEGIN;
ALTER TYPE "RoleName" RENAME TO "RoleName_old";
CREATE TYPE "RoleName" AS ENUM ('SALES', 'ADMIN', 'MANAGEMENT');
DROP TYPE "RoleName_old";
COMMIT;
