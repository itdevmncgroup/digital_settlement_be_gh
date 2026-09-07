-- Data backfill: every existing "SETTLEMENT"-stage ApprovalLevel/ApprovalRequest
-- was actually configured/created for the Expense submit -> approval chain
-- (ExpensesService.submit() hard-coded DocumentStage.SETTLEMENT - the Settlement
-- entity itself has never had its own approval flow). Retag them EXPENSES so
-- they keep resolving once ExpensesService.submit() switches to that stage.
UPDATE "approval_levels" SET "documentStage" = 'EXPENSES' WHERE "documentStage" = 'SETTLEMENT';
UPDATE "approval_requests" SET "documentStage" = 'EXPENSES' WHERE "documentStage" = 'SETTLEMENT';
