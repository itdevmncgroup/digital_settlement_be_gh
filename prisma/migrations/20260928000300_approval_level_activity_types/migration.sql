-- ApprovalLevel.activityTypeId (single) -> join table so a Level can cover several Activity Types.
CREATE TABLE "approval_level_activity_types" (
    "id" TEXT NOT NULL,
    "approvalLevelId" TEXT NOT NULL,
    "activityTypeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_level_activity_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_level_activity_types_approvalLevelId_activityTypeId_key" ON "approval_level_activity_types"("approvalLevelId", "activityTypeId");

-- AddForeignKey
ALTER TABLE "approval_level_activity_types" ADD CONSTRAINT "approval_level_activity_types_approvalLevelId_fkey" FOREIGN KEY ("approvalLevelId") REFERENCES "approval_levels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_level_activity_types" ADD CONSTRAINT "approval_level_activity_types_activityTypeId_fkey" FOREIGN KEY ("activityTypeId") REFERENCES "activity_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill from the old single column.
INSERT INTO "approval_level_activity_types" ("id", "approvalLevelId", "activityTypeId")
SELECT gen_random_uuid()::text, "id", "activityTypeId" FROM "approval_levels" WHERE "activityTypeId" IS NOT NULL;

ALTER TABLE "approval_levels" DROP CONSTRAINT "approval_levels_activityTypeId_fkey";
ALTER TABLE "approval_levels" DROP COLUMN "activityTypeId";
