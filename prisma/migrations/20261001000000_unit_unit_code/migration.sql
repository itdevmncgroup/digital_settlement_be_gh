-- Add external-system unit code (RCTI=84, GTV=85, MNCTV=86, INews=83), used by
-- ExternalSyncService's PR push.
ALTER TABLE "units" ADD COLUMN "unit_code" TEXT;

UPDATE "units" SET "unit_code" = '84' WHERE "code" = 'RCTI';
UPDATE "units" SET "unit_code" = '85' WHERE "code" = 'GTV';
UPDATE "units" SET "unit_code" = '86' WHERE "code" = 'MNCTV';
UPDATE "units" SET "unit_code" = '83' WHERE "code" = 'INEWS';
