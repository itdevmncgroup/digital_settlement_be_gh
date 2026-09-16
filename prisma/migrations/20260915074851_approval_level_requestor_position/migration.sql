-- CreateTable
CREATE TABLE "approval_level_requestor_positions" (
    "id" TEXT NOT NULL,
    "approvalLevelId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_level_requestor_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_level_requestor_positions_approvalLevelId_position_key" ON "approval_level_requestor_positions"("approvalLevelId", "positionId");

-- AddForeignKey
ALTER TABLE "approval_level_requestor_positions" ADD CONSTRAINT "approval_level_requestor_positions_approvalLevelId_fkey" FOREIGN KEY ("approvalLevelId") REFERENCES "approval_levels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_level_requestor_positions" ADD CONSTRAINT "approval_level_requestor_positions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
