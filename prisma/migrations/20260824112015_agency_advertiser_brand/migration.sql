-- DropForeignKey
ALTER TABLE "client_brands" DROP CONSTRAINT "client_brands_brandId_fkey";

-- DropForeignKey
ALTER TABLE "client_brands" DROP CONSTRAINT "client_brands_clientId_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_clientId_fkey";

-- DropForeignKey
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_clientId_fkey";

-- DropForeignKey
ALTER TABLE "pod_assignments" DROP CONSTRAINT "pod_assignments_clientId_fkey";

-- DropIndex
DROP INDEX "pod_assignments_podId_clientId_key";

-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "advertiserId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "events" DROP COLUMN "clientId",
ADD COLUMN     "advertiserId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "expenses" DROP COLUMN "clientId",
ADD COLUMN     "advertiserId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "pod_assignments" DROP COLUMN "clientId",
ADD COLUMN     "agencyId" TEXT NOT NULL;

-- DropTable
DROP TABLE "client_brands";

-- DropTable
DROP TABLE "clients";

-- CreateTable
CREATE TABLE "agencies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertisers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "agencyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advertisers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agencies_code_key" ON "agencies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "advertisers_code_key" ON "advertisers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "pod_assignments_podId_agencyId_key" ON "pod_assignments"("podId", "agencyId");

-- AddForeignKey
ALTER TABLE "advertisers" ADD CONSTRAINT "advertisers_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_assignments" ADD CONSTRAINT "pod_assignments_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

