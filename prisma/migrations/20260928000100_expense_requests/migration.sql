-- CreateEnum
CREATE TYPE "ExpenseRequestStatus" AS ENUM ('PENDING_APPROVAL', 'BUDGET_INPUT', 'CORSEC_VERIFICATION', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "expenseRequestId" TEXT;

-- CreateTable
CREATE TABLE "expense_requests" (
    "id" TEXT NOT NULL,
    "requestNo" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "departmentId" TEXT,
    "activityType" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "greetingText" TEXT NOT NULL,
    "sendDate" TIMESTAMP(3) NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "status" "ExpenseRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "rejectReason" TEXT,
    "budgetAmount" DECIMAL(18,2),
    "budgetNotes" TEXT,
    "budgetById" TEXT,
    "budgetAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_requests_requestNo_key" ON "expense_requests"("requestNo");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_expenseRequestId_key" ON "approval_requests"("expenseRequestId");

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_budgetById_fkey" FOREIGN KEY ("budgetById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "expense_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

