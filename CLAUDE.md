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

Storage (`src/common/storage/providers/`) and OCR (`src/common/ocr/providers/`) are both
provider-switched via env var (`STORAGE_PROVIDER`: local/s3/gdrive; `OCR_PROVIDER`:
tesseract/textract/ai) — see `.env.example` for the per-backend config. `@aws-sdk/client-s3`,
`@aws-sdk/client-textract`, `googleapis`, `@anthropic-ai/sdk` back the non-default backends.

`DATABASE_URL` itself is also provider-switched: `DB_PROVIDER` (postgres/supabase/aws)
picks which `DATABASE_URL_<PROVIDER>` value gets copied into `DATABASE_URL` before Prisma
reads it — same `postgresql` Prisma provider throughout, just a different connection
string. Resolved in `src/config/resolve-database-url.ts` (app boot, `main.ts`) and
`scripts/resolve-database-url.js` (a `-r` preload wired into the `prisma:*`/`seed` npm
scripts, since the Prisma CLI is a separate process). Standalone scripts under `scripts/`
that call `new PrismaClient()` directly (not through those npm scripts) still expect
`DATABASE_URL` exported in the shell — they don't go through this resolver.

Seeding (`npm run seed`): `prisma/seed-master-snapshot.ts` loads `prisma/seed-data/master/*.json`
(exported from a real DB) into an EMPTY database keeping original ids; `prisma/seed.ts` then tops up
idempotently from hardcoded tables (roles, permissions, role→permission defaults, positions, departments
POD1-7, approval levels, core users, department approvers) that mirror that snapshot. After changing
master data in the live DB, re-run the export script and update those tables in `seed.ts` to match.

Master `DELETE /:id` endpoints (`deleteRecord` / `assertUnused` in `src/common/delete.util.ts`): FK-referenced
rows return 409 "deactivate instead"; SET NULL references (users.unitId/positionId, expenses.paymentMethodId...)
are checked explicitly because the DB would otherwise orphan them silently. Built-in roles can't be deleted.

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
node scripts/export-master-snapshot.js        # refresh prisma/seed-data/master/*.json from the live DB (read-only)
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
   e.g. HEAD-POD → CO-CSO, terminal state `READY_TO_MATCHING`. (CO-CSO-1/CO-CSO-2 were
   merged into the single CO-CSO tier — `APPROVAL_CO_CSO_1`/`_2` stay in the enum only
   for historical rows.)
2. **Settlement chain** — entered once matched Expenses are grouped into a `Settlement`
   (SLS_MAR_DIR → VP_ACC_BIL_TAX_3TV → CO_CFO_3TV). Tier advances only when the approver
   reviews every member Expense individually then submits the batch in one call
   (`submitSettlementTier`). Final tier only marks it COMPLETE - a holder of `settlement.send.odoo.all` (any Settlement) / `settlement.send.odoo.owndept` (own Department's Settlements) / Admin then picks a Unit and sends it via "Create Draft PR" (`GET :id/draft-pr/preview`, `POST :id/draft-pr/send` -> `ExternalSyncService.pushSettlement`).

**Expense Request** (`expense-requests`, Karangan Bunga, entered by Sales Admin) is a third,
separate flow: optional `DRAFT` (requester-only, editable via `PATCH :id`, `POST :id/submit` starts the chain), then Head Dept → Co-CSO via `ApprovalLevel` (`DocumentStage.EXPENSE_REQUEST`,
`ApprovalRequest.expenseRequestId`, no amount → Level `minAmount` 0; an Admin must configure
the Level or create fails), then Sales Customer Service (Position `SLS-CS`) fills
`budgetAmount`, then Corsec (Position `CORSEC`) picks Proceed (`PROCEED`, formerly `APPROVED`) or Cancel (`CANCELLED`, reason kept in `rejectReason`; `REJECTED` = approver reject in the chain). Those last two
stages are Position-gated in `ExpenseRequestsService`, not `@Roles`. Approve/reject go
through `POST /approvals/expense-request/:id/approve|reject`; no email one-click link.
A Request can be keyed in on another user's behalf (`dto.requestedById`; requestor must hold Position `SLS`/`STAFF`/`CO-CSO`
in the Request's Department, which must be one of the caller's own unless Admin): needs `webmobile.request.expense.create.owndept`
(or Admin), else 403. The requestor becomes `requestedById`, the caller `ExpenseRequest.createdById` (inputter keeps
DRAFT edit/submit + list access). Candidates: `GET /expense-requests/requestors` (`listRequestors`).
`ApprovalLevel.activityTypes` (join table `ApprovalLevelActivityType`, multi; empty = any) filters any stage by Activity Type and
outranks the other specificity tiers. An `EXPENSE_REQUEST` Level scoped to an Activity Type
also means Expenses of that Activity Type + Department skip the `EXPENSES` chain
(`enterExpenseApproval` → straight to `READY_TO_MATCHING`); Settlement chain unchanged.
E.g. Karangan Bunga: Sales dept → HEAD-POD → CO-CSO, HRD dept → `DIV-HEAD` only.

**Expense from Expense Request**: Corsec (Position `CORSEC`) picks a `PROCEED` Request in All Expenses -> `POST /expenses` with `expenseRequestId` (`ExpensesService.createFromExpenseRequest`), or clicks "Add Invoices" on the Expense Request list -> multipart `POST /expenses/from-request/:requestId` (`files[]`), which does the same and attaches the files as one Invoice (`createFromExpenseRequestWithInvoices`; purpose/amount derived from the Request). Date/Department/Activity Type/Agency/Advertiser/Brand come from the Request, `salesId` = the Request's requester, status `PENDING_SALES_ADMIN`, no chain yet; `Expense.expenseRequestId` is unique (1 Request -> 1 Expense). A `SALES_ADMIN` of the same Department completes it (PATCH + photos/invoices, `canCompletePendingSalesAdmin`) and `POST :id/submit` -> `enterExpenseApproval`, which does NOT apply the "pre-approved, skip to READY_TO_MATCHING" shortcut for a Request-linked Expense, so the Activity-Type-scoped EXPENSES Level ("Expense - Karangan Bunga" -> CO-CSO) runs. Corsec sees only Request-linked Expenses in the list. `request.expense.read.owndept` lets a user list Expense Requests of their own Department(s) (`ExpenseRequestsService.findAll`).

**Expense on behalf of a requestor**: `expense.create.all` (any active user) / `expense.create.owndept` (only users sharing a Department with the caller, and the Expense's Department must be one of the caller's own) - in both cases the requestor must hold Position `SLS`/`STAFF`/`CO-CSO` (`REQUESTOR_POSITION_CODES`) let the caller `POST /expenses` with `salesId` = another user. `salesId` stays the requestor; the caller is stored in `Expense.createdById` (the inputter), who keeps edit/upload/submit access (`assertCanEdit`, `canUploadExpenseFiles`) and sees it in the list. Candidates come from `GET /expenses/requestors` (`ExpensesService.listRequestors`, same rules as `resolveRequestorId`). `expense.create.own` (default for role SALES) only creates the caller's own Expense, within their own Department(s). A caller without `.all`/`.owndept` gets `salesId` ignored.

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
