-- Who pressed "Submit" for a Settlement tier (may be an Admin acting for the
-- assigned approver). Companion to approval_request_steps."submittedAt".
ALTER TABLE "approval_request_steps" ADD COLUMN IF NOT EXISTS "submittedById" TEXT;

DO $$ BEGIN
  ALTER TABLE "approval_request_steps"
    ADD CONSTRAINT "approval_request_steps_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill from the SUBMIT audit row of the same tier.
UPDATE "approval_request_steps" s
SET "submittedById" = (
  SELECT a."userId"
  FROM "audit_logs" a
  WHERE a."objectType" = 'Settlement'
    AND a."action" = 'SUBMIT'
    AND a."objectId" = r."settlementId"
    AND (a."newValue"->>'tier')::int = s."stepOrder"
  ORDER BY a."timestamp" DESC
  LIMIT 1
)
FROM "approval_requests" r
WHERE r."id" = s."approvalRequestId"
  AND r."settlementId" IS NOT NULL
  AND s."submittedAt" IS NOT NULL
  AND s."submittedById" IS NULL;
