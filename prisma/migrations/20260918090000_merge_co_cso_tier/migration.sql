-- CO-CSO-1 and CO-CSO-2 merge into a single CO-CSO tier (see schema.prisma
-- ExpenseStatus comment). APPROVAL_CO_CSO_1/2 stay in the enum for historical
-- rows only - new chains produce APPROVAL_CO_CSO instead.
-- AlterEnum
ALTER TYPE "ExpenseStatus" ADD VALUE 'APPROVAL_CO_CSO';
