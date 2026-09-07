-- DropIndex
DROP INDEX "pod_assignments_podId_agencyId_key";

-- CreateIndex
CREATE UNIQUE INDEX "pod_assignments_podId_brandId_key" ON "pod_assignments"("podId", "brandId");

