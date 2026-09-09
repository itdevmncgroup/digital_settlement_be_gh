-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "settlementId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_settlementId_key" ON "approval_requests"("settlementId");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

