-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExpenseStatus" ADD VALUE 'READY_TO_MATCHING';
ALTER TYPE "ExpenseStatus" ADD VALUE 'READY_TO_SETTLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SettlementStatus" ADD VALUE 'APPROVAL_SLS_MAR_DIR';
ALTER TYPE "SettlementStatus" ADD VALUE 'APPROVAL_VP_ACC_BIL_TAX_3TV';
ALTER TYPE "SettlementStatus" ADD VALUE 'APPROVAL_CO_CFO_3TV';

-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "settlementId" TEXT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "settlementApprovedStep" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_settlementId_key" ON "approval_requests"("settlementId");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

