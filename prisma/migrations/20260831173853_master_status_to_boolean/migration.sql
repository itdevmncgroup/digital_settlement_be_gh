-- Master data status ("ACTIVE"/"INACTIVE" string) -> isActive (boolean),
-- across every master-data catalog table. Data-preserving: add the new
-- column, backfill it from the old status value, then drop status - unlike
-- a blind ADD COLUMN ... DEFAULT true, this does not silently flip any
-- existing INACTIVE row back to active.

ALTER TABLE "advertisers" ADD COLUMN "isActive" BOOLEAN;
UPDATE "advertisers" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "advertisers" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "advertisers" DROP COLUMN "status";

ALTER TABLE "agencies" ADD COLUMN "isActive" BOOLEAN;
UPDATE "agencies" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "agencies" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "agencies" DROP COLUMN "status";

ALTER TABLE "brands" ADD COLUMN "isActive" BOOLEAN;
UPDATE "brands" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "brands" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "brands" DROP COLUMN "status";

ALTER TABLE "cost_centers" ADD COLUMN "isActive" BOOLEAN;
UPDATE "cost_centers" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "cost_centers" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "cost_centers" DROP COLUMN "status";

ALTER TABLE "credit_cards" ADD COLUMN "isActive" BOOLEAN;
UPDATE "credit_cards" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "credit_cards" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "credit_cards" DROP COLUMN "status";

ALTER TABLE "departments" ADD COLUMN "isActive" BOOLEAN;
UPDATE "departments" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "departments" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "departments" DROP COLUMN "status";

ALTER TABLE "expense_categories" ADD COLUMN "isActive" BOOLEAN;
UPDATE "expense_categories" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "expense_categories" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "expense_categories" DROP COLUMN "status";

ALTER TABLE "merchants" ADD COLUMN "isActive" BOOLEAN;
UPDATE "merchants" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "merchants" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "merchants" DROP COLUMN "status";

ALTER TABLE "pods" ADD COLUMN "isActive" BOOLEAN;
UPDATE "pods" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "pods" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "pods" DROP COLUMN "status";

ALTER TABLE "positions" ADD COLUMN "isActive" BOOLEAN;
UPDATE "positions" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "positions" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "positions" DROP COLUMN "status";

ALTER TABLE "units" ADD COLUMN "isActive" BOOLEAN;
UPDATE "units" SET "isActive" = (status = 'ACTIVE');
ALTER TABLE "units" ALTER COLUMN "isActive" SET NOT NULL, ALTER COLUMN "isActive" SET DEFAULT true;
ALTER TABLE "units" DROP COLUMN "status";
