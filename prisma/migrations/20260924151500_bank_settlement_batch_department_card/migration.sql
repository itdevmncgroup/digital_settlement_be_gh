-- Auto Match popup now tags each uploaded statement with the Department/
-- Corporate Card it belongs to; matching is scoped to that Department.
-- AlterTable
ALTER TABLE "bank_settlement_batches" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "bank_settlement_batches" ADD COLUMN "creditCardId" TEXT;

-- AddForeignKey
ALTER TABLE "bank_settlement_batches" ADD CONSTRAINT "bank_settlement_batches_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_settlement_batches" ADD CONSTRAINT "bank_settlement_batches_creditCardId_fkey" FOREIGN KEY ("creditCardId") REFERENCES "credit_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
