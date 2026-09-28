-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE 'DRAFT_SETTLEMENT';

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "revenueSharePercent" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "settlement_allocations" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "description" TEXT,
    "analyticAcc" TEXT,
    "account" TEXT,
    "wilayah" TEXT,
    "linePr" TEXT,
    "qty" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "curr" TEXT NOT NULL DEFAULT 'IDR',
    "originalPrice" DECIMAL(18,2) NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "totalPrice" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_allocations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
