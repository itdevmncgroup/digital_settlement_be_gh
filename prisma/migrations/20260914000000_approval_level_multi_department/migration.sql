-- CreateTable
CREATE TABLE "approval_level_departments" (
    "id" TEXT NOT NULL,
    "approvalLevelId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_level_departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_level_departments_approvalLevelId_departmentId_key" ON "approval_level_departments"("approvalLevelId", "departmentId");

-- AddForeignKey
ALTER TABLE "approval_level_departments" ADD CONSTRAINT "approval_level_departments_approvalLevelId_fkey" FOREIGN KEY ("approvalLevelId") REFERENCES "approval_levels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_level_departments" ADD CONSTRAINT "approval_level_departments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: preserve every existing ApprovalLevel.departmentId as a join row
-- before the column is dropped below.
INSERT INTO "approval_level_departments" ("id", "approvalLevelId", "departmentId", "createdAt")
SELECT gen_random_uuid(), "id", "departmentId", now()
FROM "approval_levels"
WHERE "departmentId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "approval_levels" DROP CONSTRAINT "approval_levels_departmentId_fkey";

-- AlterTable
ALTER TABLE "approval_levels" DROP COLUMN "departmentId";
