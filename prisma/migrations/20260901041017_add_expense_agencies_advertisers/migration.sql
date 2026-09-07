-- CreateTable
CREATE TABLE "expense_agencies" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_advertisers" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_advertisers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_agencies_expenseId_agencyId_key" ON "expense_agencies"("expenseId", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_advertisers_expenseId_advertiserId_key" ON "expense_advertisers"("expenseId", "advertiserId");

-- AddForeignKey
ALTER TABLE "expense_agencies" ADD CONSTRAINT "expense_agencies_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_agencies" ADD CONSTRAINT "expense_agencies_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_advertisers" ADD CONSTRAINT "expense_advertisers_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_advertisers" ADD CONSTRAINT "expense_advertisers_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
