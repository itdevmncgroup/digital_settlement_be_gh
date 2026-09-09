-- Merge Pod into Department: Pod disappears as a separate entity, Department
-- becomes canonical and gains Pod's coverage (assignments), per-department
-- approvers, and 1:1 credit card. Membership ("who's in this Department") is
-- simply User.departmentId - no join table survives for that.
--
-- Ordering below is deliberate: back-fill every value that depends on the old
-- pod_* tables/columns FIRST, then drop the old constraints/columns/tables.

-- 1. Relax departments.code so Pod-derived rows (no org code) can be inserted.
ALTER TABLE "departments" ALTER COLUMN "code" DROP NOT NULL;

-- 2. Migrate every Pod row into a Department row, reusing the same id so
--    every existing FK value pointing at a pod id keeps resolving once
--    repointed to "departments".
INSERT INTO "departments" ("id", "name", "code", "isActive", "createdAt", "updatedAt")
SELECT "id", "name", NULL, "isActive", "createdAt", "updatedAt" FROM "pods";

-- 3. Backfill a Sales' own department from their old Pod membership, where
--    they didn't already have one.
UPDATE "users" u
SET "departmentId" = pm."podId"
FROM "pod_members" pm
WHERE pm."salesId" = u.id AND u."departmentId" IS NULL;

-- 4. Collapse the independent podId/departmentId pair on documents down to
--    the single surviving departmentId (podId was the live/used value).
UPDATE "expenses" SET "departmentId" = "podId" WHERE "podId" IS NOT NULL;
UPDATE "events" SET "departmentId" = "podId" WHERE "podId" IS NOT NULL;
UPDATE "settlements" SET "departmentId" = "podId";
UPDATE "approval_levels" SET "departmentId" = "podId", "scopeType" = 'DEPARTMENT' WHERE "scopeType" = 'POD';

-- 5. CreditCard never had its own departmentId - add it fresh and backfill
--    from podId before podId is dropped.
ALTER TABLE "credit_cards" ADD COLUMN "departmentId" TEXT;
UPDATE "credit_cards" SET "departmentId" = "podId" WHERE "podId" IS NOT NULL;

-- 6. Create the new department_* tables and copy Pod's assignment/approver
--    rows over (same ids, podId -> departmentId).
CREATE TABLE "department_position_assignments" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_position_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "department_assignments" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "department_assignments_pkey" PRIMARY KEY ("id")
);

INSERT INTO "department_position_assignments" ("id", "departmentId", "positionId", "userId", "status", "createdAt")
SELECT "id", "podId", "positionId", "userId", "status", "createdAt" FROM "pod_position_assignments";

INSERT INTO "department_assignments" ("id", "departmentId", "agencyId", "brandId", "effectiveDate", "endDate", "status")
SELECT "id", "podId", "agencyId", "brandId", "effectiveDate", "endDate", "status" FROM "pod_assignments";

-- 7. Now safe to shrink the enum - no row still carries scopeType='POD'.
BEGIN;
CREATE TYPE "ApprovalScopeType_new" AS ENUM ('ANY', 'DEPARTMENT');
ALTER TABLE "approval_levels" ALTER COLUMN "scopeType" DROP DEFAULT;
ALTER TABLE "approval_levels" ALTER COLUMN "scopeType" TYPE "ApprovalScopeType_new" USING ("scopeType"::text::"ApprovalScopeType_new");
ALTER TYPE "ApprovalScopeType" RENAME TO "ApprovalScopeType_old";
ALTER TYPE "ApprovalScopeType_new" RENAME TO "ApprovalScopeType";
DROP TYPE "ApprovalScopeType_old";
ALTER TABLE "approval_levels" ALTER COLUMN "scopeType" SET DEFAULT 'ANY';
COMMIT;

-- 8. Drop old FKs/index referencing Pod-related tables/columns.
ALTER TABLE "approval_levels" DROP CONSTRAINT "approval_levels_podId_fkey";
ALTER TABLE "credit_cards" DROP CONSTRAINT "credit_cards_podId_fkey";
ALTER TABLE "events" DROP CONSTRAINT "events_podId_fkey";
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_podId_fkey";
ALTER TABLE "pod_assignments" DROP CONSTRAINT "pod_assignments_agencyId_fkey";
ALTER TABLE "pod_assignments" DROP CONSTRAINT "pod_assignments_brandId_fkey";
ALTER TABLE "pod_assignments" DROP CONSTRAINT "pod_assignments_podId_fkey";
ALTER TABLE "pod_members" DROP CONSTRAINT "pod_members_podId_fkey";
ALTER TABLE "pod_members" DROP CONSTRAINT "pod_members_salesId_fkey";
ALTER TABLE "pod_position_assignments" DROP CONSTRAINT "pod_position_assignments_podId_fkey";
ALTER TABLE "pod_position_assignments" DROP CONSTRAINT "pod_position_assignments_positionId_fkey";
ALTER TABLE "pod_position_assignments" DROP CONSTRAINT "pod_position_assignments_userId_fkey";
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_departmentId_fkey";
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_podId_fkey";

DROP INDEX "credit_cards_podId_key";

-- 9. Drop old columns / tables now that everything's copied.
ALTER TABLE "approval_levels" DROP COLUMN "podId";
ALTER TABLE "credit_cards" DROP COLUMN "podId";
ALTER TABLE "events" DROP COLUMN "podId";
ALTER TABLE "expenses" DROP COLUMN "podId";
ALTER TABLE "settlements" DROP COLUMN "podId", ALTER COLUMN "departmentId" SET NOT NULL;

DROP TABLE "pod_assignments";
DROP TABLE "pod_members";
DROP TABLE "pod_position_assignments";
DROP TABLE "pods";

-- 10. New indexes/constraints for the merged shape.
CREATE UNIQUE INDEX "department_position_assignments_departmentId_positionId_key" ON "department_position_assignments"("departmentId", "positionId");
CREATE UNIQUE INDEX "department_assignments_departmentId_brandId_key" ON "department_assignments"("departmentId", "brandId");
CREATE UNIQUE INDEX "credit_cards_departmentId_key" ON "credit_cards"("departmentId");
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

ALTER TABLE "department_position_assignments" ADD CONSTRAINT "department_position_assignments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_position_assignments" ADD CONSTRAINT "department_position_assignments_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "department_position_assignments" ADD CONSTRAINT "department_position_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "department_assignments" ADD CONSTRAINT "department_assignments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_assignments" ADD CONSTRAINT "department_assignments_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "department_assignments" ADD CONSTRAINT "department_assignments_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "settlements" ADD CONSTRAINT "settlements_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
