-- The Settlement tier is no longer a separate ApprovalRequest bound to the
-- Settlement itself: the same Expense continues into a second chain
-- (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV) once it is grouped into a
-- Settlement, so approval always acts on an Expense. Drop the short-lived
-- settlement-bound requests before removing the column they hang off.
DELETE FROM "approval_requests" WHERE "settlementId" IS NOT NULL;

-- AlterEnum
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_CO_CSO_1';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_CO_CSO_2';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_SLS_MAR_DIR';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_VP_ACC_BIL_TAX_3TV';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_CO_CFO_3TV';
ALTER TYPE "ExpenseStatus" ADD VALUE 'COMPLETE';

-- DropForeignKey
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_settlementId_fkey";

-- DropIndex
DROP INDEX "approval_requests_settlementId_key";

-- AlterTable
ALTER TABLE "approval_requests" DROP COLUMN "settlementId";

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "externalSyncedAt" TIMESTAMP(3);
