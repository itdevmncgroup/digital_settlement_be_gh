/*
  Warnings:

  - You are about to drop the column `source` on the `expenses` table. All the data in the column will be lost.
  - Made the column `eventId` on table `expenses` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_eventId_fkey";

-- AlterTable
ALTER TABLE "expenses" DROP COLUMN "source",
ALTER COLUMN "eventId" SET NOT NULL;

-- DropEnum
DROP TYPE "ExpenseSource";

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
