# CLAUDE.md — digital_settlement_be

Guide for Claude Code working in this repo. Backend API for **Digital Settlement**
(Sales Client Entertainment & Expense Management System), MNC Group internal app.

## Stack

NestJS 10 (Express) + TypeScript 5.5 + Prisma 5 + PostgreSQL. Auth: `@nestjs/jwt` +
`passport-jwt`, access+refresh tokens, `bcryptjs` hashing. Validation: global
`ValidationPipe` (whitelist/forbidNonWhitelisted/transform) in `src/main.ts`. Security:
`helmet`, `@nestjs/throttler` (global `APP_GUARD`). Files: `exceljs` for import (not
`xlsx`/SheetJS — prototype-pollution advisory), `pdf-lib`/`pdfjs-dist`/`pdf-to-img`/`sharp`/
`tesseract.js` for bank-statement PDF parsing + OCR. `multer` pinned `^2.2.0` via
`overrides` for a DoS fix. API served under global prefix `/api/v1`.

No test suite exists (`npm test` not defined) — don't assume Jest is wired up.

## Windows path caveat

Repo path history contains `&` / spaces that break `.cmd` shims. Every `package.json`
script invokes `node node_modules/<pkg>/<entry>.js` directly instead of `npx`/shim calls.
**Follow this pattern for any new script** — don't add `npx ...` or bare shim invocations.

## Commands

```
npm run start:dev              # nest watch mode
npm run build && npm run start:prod
npm run lint                   # eslint --fix on src/test
npm run prisma:generate
npm run prisma:migrate         # dev migration + seed
npm run prisma:migrate:deploy  # prod
npm run prisma:studio
npm run seed                   # prisma/seed.ts via ts-node
node scripts/reset-and-seed-expenses.js       # standalone demo-data generator, not an npm script
node scripts/generate-sample-statements.js    # standalone bank-statement sample generator
```

## Module map (`src/`)

Nest module pattern throughout: `*.module.ts` + `*.controller.ts` + `*.service.ts` + `dto/`.

- **Auth/RBAC**: `auth`, `users`, `roles`, `positions`, `departments` — free-text
  `Role`/`Permission`/`RolePermission` tables *plus* ~30 hardcoded `@Roles(RoleName.X)`
  guard call sites. Creating a custom Role via Admin UI grants no extra access without a
  matching code-level check — don't assume the permission table alone is authoritative.
- **Master data**: `units`, `agencies`, `advertisers`, `brands`, `sales-assignments`,
  `activity-types`, `cost-centers`, `expense-categories`, `merchants`, `credit-cards`.
  Agency → Advertiser → Brand is a strict 1:N ownership chain, not a link table
  (`brands.advertiserId` required FK) — a Brand belongs to exactly one Advertiser.
- **Transactions**: `events` (Pre-Event, mandatory before spend), `expenses`, `invoices`
  (manual entry `final_*` fields; `ocr_*`/`matching_status` reserved for OCR worker).
- **Approval**: `approvals` — driven by `ApprovalLevel` master data, scoped by
  `DocumentStage` (`EXPENSES`, `SETTLEMENT`, legacy `PRE_EVENT`) + amount range + optional
  `Department` scope, each with an ordered `Position` chain resolved to concrete `User`s via
  `DepartmentPositionAssignment` (or first active Position holder for `ANY` scope).
- **Settlement/matching**: `settlements`, `bank-matching`, `external-sync`, `import`,
  `ocr`, `email` (one-click email approval via single-use `ApprovalRequestStep.emailToken`).
- **Cross-cutting** (`src/common/`): `audit` (global `AuditService`, every mutation logs to
  `audit_logs`), `storage` (local-disk file storage — only `storageKey` ever leaves this
  module, swap for S3 later), `guards` (`JwtAuthGuard`/`RolesGuard`), `rbac` (permission-scope
  util), `matching` (merchant-name normalization for auto-match), `ocr`, `pdf`.
- `src/prisma` — `PrismaModule`/`PrismaService`. `src/app.module.ts` wires ~25 modules.
  `src/main.ts` — bootstrap, global prefix, ValidationPipe, helmet, CORS.

## Approval / settlement flow (read before touching this area)

Two separate approval chains:
1. **Expense chain** — `Expense.status` mirrors current tier
   (`ExpenseStatus.APPROVAL_<POSITION_CODE>`, `-` normalized to `_` in position codes),
   e.g. HEAD_POD → CO-CSO-1 → CO-CSO-2, terminal state `READY_TO_MATCHING`.
2. **Settlement chain** — entered once matched Expenses are grouped into a `Settlement`
   (SLS_MAR_DIR → VP_ACC_BIL_TAX_3TV → CO_CFO_3TV). Tier advances only when the approver
   reviews every member Expense individually then submits the batch in one call
   (`submitSettlementTier`). Final tier triggers `ExternalSyncService.pushSettlement`.

Override permissions (`expense.approve.all`/`expense.approve.owndept`,
`approval.read.all`/`approval.read.owndept`) let non-assigned actors act on/view others'
pending approvals — see `assertApprovalOverride` / `findPendingFor` in
`src/approvals/approvals.service.ts`.

**Auto-matching** (`src/bank-matching/`): parses uploaded bank/credit-card statement PDFs
into `BankTransaction` rows, scores candidates against unmatched Expenses by amount
(exact/close threshold), date proximity, and normalized merchant name
(`src/common/matching/normalize.ts`) — auto-matches ≥80 score with a 10-point margin over
runner-up, flags 40–80 as `REVIEW_REQUIRED`. `BankSettlementBatch.contentHash` (SHA-256)
dedupes re-uploads.

## Prisma schema

`prisma/schema.prisma` (~950 lines) is heavily commented with BRD section references and
notes on superseded/legacy values (e.g. old `ExpenseStatus.APPROVED`/`SETTLED` kept only
for historical rows). **Read the inline comments before modifying models** — several
fields exist only for backward compatibility with pre-refactor data.

## Related repos

Frontend (`digital_settlement_fe`, Next.js) and mobile app (`digital_settlement_mobile`,
Flutter) are separate repos, siblings of this one, both consuming this API under
`/api/v1`. They mirror this API's auth/permission model — see their own CLAUDE.md files.
