-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentStage" AS ENUM ('PRE_EVENT', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "ApprovalScopeType" AS ENUM ('ANY', 'POD', 'DEPARTMENT');

-- DropForeignKey
ALTER TABLE "approval_rules" DROP CONSTRAINT "approval_rules_categoryId_fkey";

-- Truncate legacy approval data: RoleName-based approval_requests/approval_actions
-- are structurally incompatible with the new Position-based engine (dev-stage DB,
-- no production data - approved wipe). In-flight Expense/Event approvals must be
-- resubmitted after this migration to get a fresh chain under the new engine.
TRUNCATE TABLE "approval_actions", "approval_requests" RESTART IDENTITY CASCADE;

-- AlterTable
ALTER TABLE "approval_actions" DROP COLUMN "role",
ADD COLUMN     "positionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "approval_requests" DROP COLUMN "requiredRoles",
ADD COLUMN     "approvalLevelId" TEXT NOT NULL,
ADD COLUMN     "documentStage" "DocumentStage" NOT NULL,
ADD COLUMN     "eventId" TEXT,
ALTER COLUMN "expenseId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "podId" TEXT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "departmentId" TEXT;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "department",
DROP COLUMN "position",
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "positionId" TEXT;

-- DropTable
DROP TABLE "approval_rules";

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_position_assignments" (
    "id" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_position_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_levels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentStage" "DocumentStage" NOT NULL,
    "scopeType" "ApprovalScopeType" NOT NULL DEFAULT 'ANY',
    "podId" TEXT,
    "departmentId" TEXT,
    "minAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(18,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_level_steps" (
    "id" TEXT NOT NULL,
    "approvalLevelId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "positionId" TEXT NOT NULL,

    CONSTRAINT "approval_level_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request_steps" (
    "id" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "positionId" TEXT NOT NULL,
    "resolvedApproverId" TEXT NOT NULL,
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "approval_request_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "positions_code_key" ON "positions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "pod_position_assignments_podId_positionId_key" ON "pod_position_assignments"("podId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_level_steps_approvalLevelId_stepOrder_key" ON "approval_level_steps"("approvalLevelId", "stepOrder");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_steps_approvalRequestId_stepOrder_key" ON "approval_request_steps"("approvalRequestId", "stepOrder");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_eventId_key" ON "approval_requests"("eventId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_position_assignments" ADD CONSTRAINT "pod_position_assignments_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_position_assignments" ADD CONSTRAINT "pod_position_assignments_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_position_assignments" ADD CONSTRAINT "pod_position_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_level_steps" ADD CONSTRAINT "approval_level_steps_approvalLevelId_fkey" FOREIGN KEY ("approvalLevelId") REFERENCES "approval_levels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_level_steps" ADD CONSTRAINT "approval_level_steps_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_approvalLevelId_fkey" FOREIGN KEY ("approvalLevelId") REFERENCES "approval_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request_steps" ADD CONSTRAINT "approval_request_steps_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request_steps" ADD CONSTRAINT "approval_request_steps_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request_steps" ADD CONSTRAINT "approval_request_steps_resolvedApproverId_fkey" FOREIGN KEY ("resolvedApproverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

