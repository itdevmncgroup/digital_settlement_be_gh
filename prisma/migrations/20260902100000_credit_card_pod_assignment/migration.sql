-- AlterTable
ALTER TABLE "credit_cards" ADD COLUMN "podId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "credit_cards_podId_key" ON "credit_cards"("podId");

-- AddForeignKey
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
