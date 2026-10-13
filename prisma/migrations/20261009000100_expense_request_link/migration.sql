-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "expenseRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_expenseRequestId_key" ON "expenses"("expenseRequestId");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "expense_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
