-- CreateTable
CREATE TABLE "user_departments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_departments_userId_departmentId_key" ON "user_departments"("userId", "departmentId");

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: preserve every existing User.departmentId as a membership row
-- before the column is dropped below.
INSERT INTO "user_departments" ("id", "userId", "departmentId", "status", "createdAt")
SELECT gen_random_uuid(), "id", "departmentId", 'ACTIVE', now()
FROM "users"
WHERE "departmentId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_departmentId_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "departmentId";
