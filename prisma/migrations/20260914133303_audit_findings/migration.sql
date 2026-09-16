-- CreateEnum
CREATE TYPE "AuditFindingType" AS ENUM ('MISSING_RECEIPT', 'UNMATCHED_TRANSACTION', 'OVERDUE_SETTLEMENT', 'DUPLICATE_CLAIM', 'POLICY_EXCEPTION');

-- CreateEnum
CREATE TYPE "AuditRiskLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AuditFindingStatus" AS ENUM ('OPEN', 'FOLLOW_UP', 'INVESTIGATING', 'RESOLVED');

-- AlterTable
ALTER TABLE "expense_categories" ADD COLUMN     "policyLimit" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "audit_findings" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "findingType" "AuditFindingType" NOT NULL,
    "riskLevel" "AuditRiskLevel" NOT NULL,
    "status" "AuditFindingStatus" NOT NULL DEFAULT 'OPEN',
    "amount" DECIMAL(18,2) NOT NULL,
    "departmentId" TEXT,
    "expenseId" TEXT,
    "settlementId" TEXT,
    "agingDays" INTEGER NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_findings_riskLevel_idx" ON "audit_findings"("riskLevel");

-- CreateIndex
CREATE INDEX "audit_findings_status_idx" ON "audit_findings"("status");

-- CreateIndex
CREATE INDEX "audit_findings_departmentId_idx" ON "audit_findings"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_findings_findingType_expenseId_key" ON "audit_findings"("findingType", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_findings_findingType_settlementId_key" ON "audit_findings"("findingType", "settlementId");

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
