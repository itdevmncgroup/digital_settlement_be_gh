-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "isMatched" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: an Expense already carrying an AUTO_MATCHED/MANUAL_MATCHED bank
-- transaction was "matched" before this column existed - reflect that instead
-- of defaulting every pre-existing row to false.
UPDATE "expenses" e
SET "isMatched" = true
WHERE EXISTS (
  SELECT 1 FROM "bank_transactions" bt
  WHERE bt."matchedExpenseId" = e.id
    AND bt."status" IN ('AUTO_MATCHED', 'MANUAL_MATCHED')
);
