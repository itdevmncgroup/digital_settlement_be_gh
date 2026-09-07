-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('CREDIT_CARD', 'GOPAY', 'SHOPEEPAY', 'DANA', 'OVO', 'BANK_TRANSFER', 'CASH', 'OTHER');

-- DropForeignKey
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_eventId_fkey";

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "paymentMethodNote" TEXT,
ADD COLUMN     "paymentMethodType" "PaymentMethodType",
ADD COLUMN     "settlementId" TEXT,
ALTER COLUMN "eventId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "settlementNo" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "departmentId" TEXT,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "settlements_settlementNo_key" ON "settlements"("settlementNo");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
