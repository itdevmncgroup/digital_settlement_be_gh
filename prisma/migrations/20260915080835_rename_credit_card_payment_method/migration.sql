-- Business rename: "Credit Card" payment method is now labeled "Corporate Card".
-- code stays CREDIT_CARD (referenced throughout the codebase) - only the
-- user-facing display name changes.
UPDATE "payment_methods" SET "name" = 'Corporate Card' WHERE "code" = 'CREDIT_CARD';
