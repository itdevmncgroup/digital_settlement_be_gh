/*
  Warnings:

  - You are about to drop the column `brandId` on the `pods` table. All the data in the column will be lost.
  - You are about to drop the column `clientId` on the `pods` table. All the data in the column will be lost.
  - You are about to drop the column `effectiveDate` on the `pods` table. All the data in the column will be lost.
  - You are about to drop the column `endDate` on the `pods` table. All the data in the column will be lost.
  - Added the required column `name` to the `pods` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "pods" DROP CONSTRAINT "pods_brandId_fkey";

-- DropForeignKey
ALTER TABLE "pods" DROP CONSTRAINT "pods_clientId_fkey";

-- AlterTable
ALTER TABLE "pods" DROP COLUMN "brandId",
DROP COLUMN "clientId",
DROP COLUMN "effectiveDate",
DROP COLUMN "endDate",
ADD COLUMN     "name" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "pod_assignments" (
    "id" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "pod_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pod_assignments_podId_clientId_key" ON "pod_assignments"("podId", "clientId");

-- AddForeignKey
ALTER TABLE "pod_assignments" ADD CONSTRAINT "pod_assignments_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_assignments" ADD CONSTRAINT "pod_assignments_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_assignments" ADD CONSTRAINT "pod_assignments_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
