-- Expense raised from an Expense Request may have only an Agency (no Advertiser/Brand).
ALTER TABLE "expenses" ALTER COLUMN "advertiserId" DROP NOT NULL;
ALTER TABLE "expenses" ALTER COLUMN "brandId" DROP NOT NULL;
