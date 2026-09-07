-- AlterTable
ALTER TABLE "approval_request_steps" ADD COLUMN     "emailToken" TEXT,
ADD COLUMN     "emailTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_steps_emailToken_key" ON "approval_request_steps"("emailToken");

