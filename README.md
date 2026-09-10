# Digital Settlement — Backend API

NestJS + PostgreSQL (Prisma) backend for **Digital Settlement** (Sales Client
Entertainment & Expense Management System) — an internal MNC Group app covering
Auth/RBAC, Master Data, Pre-Event, Expense, Invoice (manual entry + OCR-assisted),
multi-tier Approval Workflow, Bank-Statement Auto-Matching, Settlement batching +
external export, Audit Trail, and Management Dashboard.

This repo is the API only. Two sibling repos consume it, both against `/api/v1`:

- **`digital_settlement_fe`** — Next.js Web Admin (Dashboard, Transactions, Master data,
  Import, Approval, Settlement, Bank-Matching, Users/Roles/Permissions, Audit Log).
- **`digital_settlement_mobile`** — Flutter app (Login, New Expense, Approvals, Settlement).

See each repo's own README/CLAUDE.md for details — they mirror this API's auth and
permission model.

## ⚠️ Windows path caveat

This project directory's path has historically contained characters (`&`, spaces) that
break Windows `.cmd` shims (`npx prisma ...`, `npx nest ...`) — `cmd.exe` mangles them.
**Fix applied:** every `package.json` script invokes `node node_modules/<pkg>/<entry>.js`
directly instead of the broken shim, so `npm run build`, `npm run seed`,
`npm run prisma:migrate`, etc. all work as-is.

If you run Prisma/Nest CLI commands **not** listed in `package.json` (e.g. `nest g module
foo`), add a script the same way rather than invoking `npx`/the shim directly.

## Setup

```bash
npm install
cp .env.example .env   # edit DATABASE_URL to point at your PostgreSQL instance
npm run prisma:migrate # creates tables + runs prisma/seed.ts
npm run start:dev
```

Seed creates:
- Roles (`SALES`, `SUPERVISOR`, `FINANCE`, `ADMIN`, `MANAGEMENT`) plus the Position chain
  used by multi-tier approval (Head POD, Koordinator, Dept Head, BOD, Division Head, ...).
- Units matching the MNC Group structure (`HOLDING`, `RCTI`, `MNCTV`, `GTV`) and default
  Activity Types.
- An Admin user: `admin@example.com` / `Admin@12345` (override via `SEED_ADMIN_EMAIL` /
  `SEED_ADMIN_PASSWORD`).
- **Demo dataset** (password `Demo@12345`, override via `SEED_DEMO_PASSWORD`): Agencies →
  Advertisers → Brands, Cost Centers, Expense Categories, Merchants, PODs, and demo users
  covering every role — Sales (`budi.santoso@example.com`, `siti.rahma@example.com`),
  Supervisor (`andi.wijaya@example.com`), Finance (`rina.kartika@example.com`),
  Management (`bambang.hartono@example.com`), plus approval-chain position holders
  (`yusuf.pratama@example.com` Head POD, `dewi.anggraini@example.com` Koordinator,
  `hendra.gunawan@example.com` Dept Head, `diana.puspita@example.com` BOD,
  `andi.wijaya@example.com` Supervisor, `bambang.hartono@example.com` Division Head) —
  plus Pre-Events and Expenses walking every status so the Dashboard, Approvals inbox, and
  list pages have real data on first login. Re-running `npm run seed` is idempotent —
  Units/Agencies/Advertisers/Brands/PODs/Approval Levels self-correct, transactional demo
  data (events/expenses/users) is skipped if already present.
- **Bulk stress dataset** (guarded on Agency code `AGY01`): 10 Agencies × 10 Advertisers ×
  10 Brands, 50 Sales split across 10 PODs (`sales1@example.com`..`sales50@example.com`,
  same `Demo@12345`) — for exercising list pages/search/pickers at scale, no Events/Expenses.

API is served under `/api/v1`. Login via `POST /api/v1/auth/login`, then send
`Authorization: Bearer <accessToken>` on subsequent requests.

## Module map (`src/`)

| Area | Modules | Notes |
|---|---|---|
| Auth/RBAC | `auth`, `users`, `roles`, `positions`, `departments` | JWT access+refresh; free-text `Role`/`Permission` tables **plus** ~30 hardcoded `@Roles()` guard call sites — a custom Role grants nothing without a matching code check |
| Master Data | `units`, `agencies`, `advertisers`, `brands`, `sales-assignments`, `activity-types`, `cost-centers`, `expense-categories`, `merchants`, `credit-cards` | Agency → Advertiser → Brand is a strict 1:N ownership chain, not a link table |
| Transactions | `events` (Pre-Event, mandatory), `expenses`, `invoices` | Invoice has separate `ocr_*` vs `final_*` columns; this API only ever writes `final_*` |
| Approval | `approvals` | `ApprovalLevel` master data scoped by `DocumentStage` (`EXPENSES`/`SETTLEMENT`/legacy `PRE_EVENT`) + amount range + optional `Department`, resolved to an ordered `Position` chain |
| Settlement/Matching | `settlements`, `bank-matching`, `external-sync` | Groups matched Expenses into a `Settlement`, runs its own approval tier, pushes to an external system on final approval |
| Import/OCR | `import`, `ocr` | Excel/CSV/PDF import for master data + Expense, invoice OCR summary extraction |
| Cross-cutting | `audit-logs`, `email` | Every mutation writes to `audit_logs`; `email` sends one-click approval links |

## Key flows

- **Agency → Advertiser → Brand**: an `Agency` (media buying agency) has many
  `Advertiser`s; each `Advertiser` owns many `Brand`s; each `Brand` belongs to **exactly
  one** `Advertiser` (`brands.advertiserId` required FK, not a link table).
- **Pre-Event is mandatory**: Sales must `POST /events` + `/events/:id/submit` and get it
  approved before spending. `POST /expenses` requires `eventId` pointing at that Sales'
  own approved event — `advertiserId`/`brandId`/`activityTypeId`/`unitId` are inherited
  from the event. Admin/Finance can create/submit an Event on behalf of another Sales via
  an optional `salesId` in the body (same pattern as manual Expense entry).
- **Two approval chains**:
  1. **Expense chain** — `Expense.status` mirrors the current tier
     (`ExpenseStatus.APPROVAL_<POSITION_CODE>`), e.g. HEAD_POD → CO-CSO-1 → CO-CSO-2,
     terminal state `READY_TO_MATCHING`.
  2. **Settlement chain** — entered once matched Expenses are grouped into a
     `Settlement` (e.g. SLS_MAR_DIR → VP_ACC_BIL_TAX_3TV → CO_CFO_3TV). Each tier's
     approver reviews every member Expense, then submits the whole batch in one call.
     Final tier triggers `ExternalSyncService.pushSettlement`.
  Override permissions (`expense.approve.all`/`.owndept`, `approval.read.all`/`.owndept`)
  let non-assigned actors act on/view others' pending approvals.
- **Bank-statement auto-matching**: uploaded PDF statements are parsed into
  `BankTransaction` rows, scored against unmatched Expenses by amount, date proximity, and
  normalized merchant name — auto-matched above a score threshold with a margin over the
  runner-up, otherwise flagged `REVIEW_REQUIRED`. Re-uploads are deduped via a SHA-256
  content hash on the batch.
- **Submit requires an invoice attached**: `POST /expenses/:id/submit` fails until at
  least one invoice has been uploaded.
- **Rejection + resubmit**: reject requires a reason; the expense/settlement flips back,
  the owner edits it, then resubmitting re-runs approval routing from the top.
- **Import**: `GET /import/:entityType/template` downloads an empty `.xlsx`;
  `POST /import/:entityType/preview` validates without persisting (rows tagged
  `VALID`/`INVALID`/`DUPLICATE`); `POST /import/:entityType/commit` re-validates and
  inserts only `VALID` rows. CSV/Excel parse exactly; PDF import is best-effort
  (assumes a simple table layout).
- **One-click email approval**: approval notification emails carry a single-use token
  (`ApprovalRequestStep.emailToken`) that approves/rejects without logging into the UI.

## Security

Helmet, global rate limiting (`@nestjs/throttler`), JWT auth guard + role guard on every
route, class-validator input validation, invoice/file download gated by ownership/role (no
public URLs), file-type/size validation on upload. Import intentionally uses `exceljs`
rather than `xlsx`/SheetJS (unpatched prototype-pollution advisory); `multer` is pinned to
`^2.2.0` via `overrides` for a DoS fix past what `@nestjs/platform-express` pulls in by
default.
