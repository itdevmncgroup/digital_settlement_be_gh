-- Pod rework: Pod becomes a pure (id, name, status, createdAt, updatedAt) entity.
-- Sales<->POD membership moves to a new many-to-many join table (pod_members).
-- Previously one Pod row existed per Sales sharing a name (e.g. 5 rows named
-- "POD 1", one per covering Sales) - this migration consolidates every group
-- of same-named rows into a single canonical row (earliest createdAt wins),
-- remaps every FK that pointed at a now-redundant row onto the canonical row,
-- backfills pod_members from the old salesId column, then drops the
-- redundant rows and the old salesId/unitId columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "pod_members" (
    "id" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "salesId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pod_members_podId_salesId_key" ON "pod_members"("podId", "salesId");

-- AddForeignKey
ALTER TABLE "pod_members" ADD CONSTRAINT "pod_members_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_members" ADD CONSTRAINT "pod_members_salesId_fkey" FOREIGN KEY ("salesId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data consolidation: remap every FK off a redundant same-named Pod row onto
-- its canonical row (earliest createdAt), skipping any remap that would
-- violate a unique constraint (that row's data is then dropped for free when
-- the redundant Pod row is deleted below, via ON DELETE CASCADE).

WITH canonical AS (
  SELECT DISTINCT ON (name) id, name FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
UPDATE "pod_assignments" pa
SET "podId" = c.id
FROM "pods" p
JOIN canonical c ON c.name = p.name
WHERE pa."podId" = p.id
  AND pa."podId" <> c.id
  AND NOT EXISTS (
    SELECT 1 FROM "pod_assignments" pa2 WHERE pa2."podId" = c.id AND pa2."brandId" = pa."brandId"
  );

WITH canonical AS (
  SELECT DISTINCT ON (name) id, name FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
UPDATE "pod_position_assignments" ppa
SET "podId" = c.id
FROM "pods" p
JOIN canonical c ON c.name = p.name
WHERE ppa."podId" = p.id
  AND ppa."podId" <> c.id
  AND NOT EXISTS (
    SELECT 1 FROM "pod_position_assignments" ppa2 WHERE ppa2."podId" = c.id AND ppa2."positionId" = ppa."positionId"
  );

WITH canonical AS (
  SELECT DISTINCT ON (name) id, name FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
UPDATE "approval_levels" al
SET "podId" = c.id
FROM "pods" p
JOIN canonical c ON c.name = p.name
WHERE al."podId" = p.id AND al."podId" <> c.id;

WITH canonical AS (
  SELECT DISTINCT ON (name) id, name FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
UPDATE "events" e
SET "podId" = c.id
FROM "pods" p
JOIN canonical c ON c.name = p.name
WHERE e."podId" = p.id AND e."podId" <> c.id;

WITH canonical AS (
  SELECT DISTINCT ON (name) id, name FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
UPDATE "expenses" ex
SET "podId" = c.id
FROM "pods" p
JOIN canonical c ON c.name = p.name
WHERE ex."podId" = p.id AND ex."podId" <> c.id;

-- Backfill membership: one pod_members row per original Pod row's salesId,
-- mapped onto its canonical Pod id.
WITH canonical AS (
  SELECT DISTINCT ON (name) id, name FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
INSERT INTO "pod_members" ("id", "podId", "salesId", "createdAt")
SELECT gen_random_uuid(), c.id, p."salesId", now()
FROM "pods" p
JOIN canonical c ON c.name = p.name
ON CONFLICT ("podId", "salesId") DO NOTHING;

-- Drop the now-redundant same-named Pod rows (their remaining pod_assignments /
-- pod_position_assignments cascade-delete; approval_levels/events/expenses were
-- already remapped above so nothing references them anymore).
WITH canonical AS (
  SELECT DISTINCT ON (name) id FROM "pods" ORDER BY name, "createdAt" ASC, id ASC
)
DELETE FROM "pods" WHERE id NOT IN (SELECT id FROM canonical);

-- DropForeignKey
ALTER TABLE "pods" DROP CONSTRAINT "pods_salesId_fkey";

-- DropForeignKey
ALTER TABLE "pods" DROP CONSTRAINT "pods_unitId_fkey";

-- AlterTable
ALTER TABLE "pods" DROP COLUMN "salesId",
DROP COLUMN "unitId";

-- CreateIndex
CREATE UNIQUE INDEX "pods_name_key" ON "pods"("name");
