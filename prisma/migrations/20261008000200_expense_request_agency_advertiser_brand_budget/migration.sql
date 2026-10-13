-- Expense Request: client free text -> Agency (optional) / Advertiser / Brand (multi), plus requester Budget.
ALTER TABLE "expense_requests" ALTER COLUMN "clientName" DROP NOT NULL;
ALTER TABLE "expense_requests" ADD COLUMN "requestBudget" DECIMAL(18,2);

CREATE TABLE "expense_request_agencies" (
    "id" TEXT NOT NULL,
    "expenseRequestId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_request_agencies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "expense_request_advertisers" (
    "id" TEXT NOT NULL,
    "expenseRequestId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_request_advertisers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "expense_request_brands" (
    "id" TEXT NOT NULL,
    "expenseRequestId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_request_brands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expense_request_agencies_expenseRequestId_agencyId_key" ON "expense_request_agencies"("expenseRequestId", "agencyId");
CREATE UNIQUE INDEX "expense_request_advertisers_expenseRequestId_advertiserId_key" ON "expense_request_advertisers"("expenseRequestId", "advertiserId");
CREATE UNIQUE INDEX "expense_request_brands_expenseRequestId_brandId_key" ON "expense_request_brands"("expenseRequestId", "brandId");

ALTER TABLE "expense_request_agencies" ADD CONSTRAINT "expense_request_agencies_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "expense_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_request_agencies" ADD CONSTRAINT "expense_request_agencies_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_request_advertisers" ADD CONSTRAINT "expense_request_advertisers_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "expense_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_request_advertisers" ADD CONSTRAINT "expense_request_advertisers_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_request_brands" ADD CONSTRAINT "expense_request_brands_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "expense_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_request_brands" ADD CONSTRAINT "expense_request_brands_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
