-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'COMPLETE');

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "location" TEXT,
ADD COLUMN     "merchantName" TEXT;

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT';
