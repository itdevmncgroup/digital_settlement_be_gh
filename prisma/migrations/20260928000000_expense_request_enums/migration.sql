-- AlterEnum (kept separate from the table migration: new enum values cannot be used in the same transaction that adds them)
ALTER TYPE "DocumentStage" ADD VALUE 'EXPENSE_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_REQUEST_PENDING';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_REQUEST_REJECTED';
