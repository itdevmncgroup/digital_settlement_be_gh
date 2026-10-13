-- Corsec's final decision is now Proceed / Cancel instead of Approved / Rejected.
-- Existing APPROVED rows become PROCEED (RENAME VALUE keeps them); REJECTED stays for approver rejects.
ALTER TYPE "ExpenseRequestStatus" RENAME VALUE 'APPROVED' TO 'PROCEED';
ALTER TYPE "ExpenseRequestStatus" ADD VALUE 'CANCELLED';
