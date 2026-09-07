-- AlterTable
ALTER TABLE "bank_settlement_batches" ADD COLUMN "contentHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "bank_settlement_batches_contentHash_key" ON "bank_settlement_batches"("contentHash");
