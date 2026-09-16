-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- Seed canonical rows with fixed literal ids, so the backfill below (and the
-- idempotent upsert-by-code in prisma/seed.ts) don't depend on a DB-side uuid
-- generation function being available.
INSERT INTO "payment_methods" ("id", "code", "name") VALUES
    ('9b1f1a10-0001-4000-8000-000000000001', 'CREDIT_CARD', 'Credit Card'),
    ('9b1f1a10-0001-4000-8000-000000000002', 'GOPAY', 'GoPay'),
    ('9b1f1a10-0001-4000-8000-000000000003', 'SHOPEEPAY', 'ShopeePay'),
    ('9b1f1a10-0001-4000-8000-000000000004', 'DANA', 'Dana'),
    ('9b1f1a10-0001-4000-8000-000000000005', 'OVO', 'OVO'),
    ('9b1f1a10-0001-4000-8000-000000000006', 'BANK_TRANSFER', 'Bank Transfer'),
    ('9b1f1a10-0001-4000-8000-000000000007', 'CASH', 'Cash'),
    ('9b1f1a10-0001-4000-8000-000000000008', 'OTHER', 'Others');

-- AddColumn
ALTER TABLE "expenses" ADD COLUMN "paymentMethodId" TEXT;

-- Backfill from the legacy enum column before it's dropped
UPDATE "expenses" e
SET "paymentMethodId" = pm.id
FROM "payment_methods" pm
WHERE e."paymentMethodType"::text = pm.code;

-- DropColumn (legacy enum column) + DropType
ALTER TABLE "expenses" DROP COLUMN "paymentMethodType";
DROP TYPE "PaymentMethodType";

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
