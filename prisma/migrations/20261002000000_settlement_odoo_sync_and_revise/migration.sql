-- CreateEnum
CREATE TYPE "OdooSyncStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "ApprovalActionType" ADD VALUE 'REVISE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_REVISED';
ALTER TYPE "NotificationType" ADD VALUE 'SETTLEMENT_REVISED';

-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE 'REVISION';

-- AlterTable: add the new Odoo-sync columns first (externalSyncedAt is kept
-- for now so the backfill below can read it before it's dropped).
ALTER TABLE "settlements"
ADD COLUMN     "odooSyncAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "odooSyncError" TEXT,
ADD COLUMN     "odooSyncStatus" "OdooSyncStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- Backfill: a Settlement already pushed successfully (externalSyncedAt set)
-- becomes SENT; a COMPLETE Settlement never pushed becomes PENDING so it's
-- retry-able via SettlementsService.retrySync; everything else stays at the
-- NOT_STARTED default.
UPDATE "settlements" SET "odooSyncStatus" = 'SENT', "sentAt" = "externalSyncedAt" WHERE "externalSyncedAt" IS NOT NULL;
UPDATE "settlements" SET "odooSyncStatus" = 'PENDING' WHERE "status" = 'COMPLETE' AND "externalSyncedAt" IS NULL;

-- AlterTable: drop the old nullable-DateTime guard now that odooSyncStatus
-- (checked against SENT, not a null check) is the sync guard.
ALTER TABLE "settlements" DROP COLUMN "externalSyncedAt";
