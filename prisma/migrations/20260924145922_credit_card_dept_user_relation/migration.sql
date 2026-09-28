-- 1 Department can now hold many CreditCards (drop unique on departmentId);
-- add userId FK (card holder is now a User, not a free-text name) and
-- best-effort backfill userId by matching existing cardHolderName to a User's
-- name before the column is dropped.

-- DropIndex
DROP INDEX "credit_cards_departmentId_key";

-- AlterTable
ALTER TABLE "credit_cards" ADD COLUMN     "userId" TEXT;

-- Backfill: try to resolve existing free-text cardHolderName to a User
UPDATE "credit_cards" cc
SET "userId" = u.id
FROM "users" u
WHERE u.name = cc."cardHolderName" AND cc."userId" IS NULL;

-- AlterTable
ALTER TABLE "credit_cards" DROP COLUMN "cardHolderName";

-- AddForeignKey
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
