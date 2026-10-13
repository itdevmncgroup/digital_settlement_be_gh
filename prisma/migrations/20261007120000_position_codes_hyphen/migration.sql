-- Position codes use '-' instead of '_' (e.g. HEAD_POD -> HEAD-POD). Status enum keys
-- (APPROVAL_HEAD_POD, ...) are unchanged - the app maps '-' back to '_' when deriving them.
-- Also adds the SLS-PARTNER ("Sales Partner") Position.
UPDATE "positions" SET "code" = 'HEAD-POD' WHERE "code" = 'HEAD_POD';
UPDATE "positions" SET "code" = 'SLS-MAR-DIR' WHERE "code" = 'SLS_MAR_DIR';
UPDATE "positions" SET "code" = 'VP-ACC-BIL-TAX-3TV' WHERE "code" = 'VP_ACC_BIL_TAX_3TV';
UPDATE "positions" SET "code" = 'CO-CFO-3TV' WHERE "code" = 'CO_CFO_3TV';
UPDATE "positions" SET "code" = 'DIV-HEAD' WHERE "code" = 'DIV_HEAD';
UPDATE "positions" SET "code" = 'DEPT-HEAD' WHERE "code" = 'DEPT_HEAD';
UPDATE "positions" SET "code" = 'SLS-CS' WHERE "code" = 'SLS_CS';
INSERT INTO "positions" ("id", "code", "name", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'SLS-PARTNER', 'Sales Partner', true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "positions" WHERE "code" = 'SLS-PARTNER');
