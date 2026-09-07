-- AlterEnum: one pending status per approval Position code, so an Expense's
-- status itself shows which tier is currently reviewing it (see
-- ApprovalsService.pendingStatusForPosition). PENDING_APPROVAL remains as the
-- fallback for a Position that doesn't have a matching value here.
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_HEAD_POD' AFTER 'PENDING_APPROVAL';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_KOORDINATOR' AFTER 'APPROVAL_HEAD_POD';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_SUPERVISOR' AFTER 'APPROVAL_KOORDINATOR';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_DEPT_HEAD' AFTER 'APPROVAL_SUPERVISOR';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_DIV_HEAD' AFTER 'APPROVAL_DEPT_HEAD';
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_BOD' AFTER 'APPROVAL_DIV_HEAD';

-- Data backfill: APPROVED is no longer a resting state - the final approval
-- step now sets SETTLED directly (no manual Finance settle step in this app).
-- Only references pre-existing enum values, so it's safe to run in the same
-- transaction as the ADD VALUE statements above.
UPDATE "expenses" SET "status" = 'SETTLED' WHERE "status" = 'APPROVED';
