-- Who keyed an Expense in (the inputter), distinct from salesId (the requestor) when
-- a holder of expense.create.owndept/.all enters it on another user's behalf.
ALTER TABLE "expenses" ADD COLUMN "createdById" TEXT;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
