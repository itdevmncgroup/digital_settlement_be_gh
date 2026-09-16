-- Business rename: the old e-wallet/cash/bank-transfer/credit-card payment
-- method taxonomy is retired in favor of 4 finance-driven methods (AP
-- Disbursement / Corporate Card / Petty Cash / Reimbursement). FK on
-- expenses.paymentMethodId is ON DELETE SET NULL, so any Expense still
-- referencing a retired method just loses the link instead of failing.
DELETE FROM "payment_methods"
WHERE "code" IN ('CREDIT_CARD', 'GOPAY', 'SHOPEEPAY', 'DANA', 'OVO', 'BANK_TRANSFER', 'CASH', 'OTHER');

INSERT INTO "payment_methods" ("id", "code", "name") VALUES
    ('9b1f1a10-0002-4000-8000-000000000001', 'AP_DISBURSEMENT', 'AP Disbursement'),
    ('9b1f1a10-0002-4000-8000-000000000002', 'CORPORATE_CARD', 'Corporate Card'),
    ('9b1f1a10-0002-4000-8000-000000000003', 'PETTY_CASH', 'Petty Cash'),
    ('9b1f1a10-0002-4000-8000-000000000004', 'REIMBURSEMENT', 'Reimbursement')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "isActive" = true;
