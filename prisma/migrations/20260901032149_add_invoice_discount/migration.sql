-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "finalDiscount" DECIMAL(18,2),
ADD COLUMN     "ocrDiscount" DECIMAL(18,2);
