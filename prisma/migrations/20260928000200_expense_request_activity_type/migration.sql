-- ApprovalLevel: optional ActivityType filter (NULL = any activity type).
ALTER TABLE "approval_levels" ADD COLUMN "activityTypeId" TEXT;

-- ExpenseRequest.activityType (free text) -> activityTypeId (FK to activity_types).
-- Only "Karangan Bunga" was ever accepted; make sure the master row exists, then backfill by name.
INSERT INTO "activity_types" ("id", "name", "isActive", "createdAt")
SELECT gen_random_uuid()::text, 'Karangan Bunga', true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "activity_types" WHERE "name" = 'Karangan Bunga');

ALTER TABLE "expense_requests" ADD COLUMN "activityTypeId" TEXT;

UPDATE "expense_requests" er
SET "activityTypeId" = at."id"
FROM "activity_types" at
WHERE at."name" = er."activityType";

-- Any row whose text matched nothing falls back to Karangan Bunga (the only allowed value).
UPDATE "expense_requests"
SET "activityTypeId" = (SELECT "id" FROM "activity_types" WHERE "name" = 'Karangan Bunga')
WHERE "activityTypeId" IS NULL;

ALTER TABLE "expense_requests" ALTER COLUMN "activityTypeId" SET NOT NULL;
ALTER TABLE "expense_requests" DROP COLUMN "activityType";

-- AddForeignKey
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_activityTypeId_fkey" FOREIGN KEY ("activityTypeId") REFERENCES "activity_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_activityTypeId_fkey" FOREIGN KEY ("activityTypeId") REFERENCES "activity_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
