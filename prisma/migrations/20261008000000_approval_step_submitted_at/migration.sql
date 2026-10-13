-- When the approver pressed "Submit" for this tier of a Settlement's own chain
-- (ApprovalsService.submitSettlementTier). Drives the PDF's "Log Approval Dokumen".
-- IF NOT EXISTS: safe to re-run if the column was already added by hand.
ALTER TABLE "approval_request_steps" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);

-- Backfill tiers submitted before this column existed from their SUBMIT audit
-- row (newValue.tier = the step's stepOrder).
UPDATE "approval_request_steps" s
SET "submittedAt" = (
  SELECT MAX(a."timestamp")
  FROM "audit_logs" a
  WHERE a."objectType" = 'Settlement'
    AND a."action" = 'SUBMIT'
    AND a."objectId" = r."settlementId"
    AND (a."newValue"->>'tier')::int = s."stepOrder"
)
FROM "approval_requests" r
WHERE r."id" = s."approvalRequestId"
  AND r."settlementId" IS NOT NULL
  AND s."status" = 'APPROVED'
  AND s."submittedAt" IS NULL;
