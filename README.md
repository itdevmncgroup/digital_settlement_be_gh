# Sales Client Entertainment & Expense Management System

Two apps in this repo:

- **`/` (this README)** — NestJS + PostgreSQL (Prisma) backend: **Backend API Core** slice of the BRD —
  Auth/RBAC, Master Data, Pre-Event, Expense, Invoice (manual entry), Approval Workflow, Audit Trail,
  Management Dashboard.
- **`/web-admin`** — Next.js Web Admin frontend consuming that API: login, dashboard, master data
  (Unit/Agency/Advertiser/Brand/Activity Type/POD), Pre-Event requests + approval, Expense
  list/detail/submit, Invoice attach + file upload, Approval inbox (approve/reject), Approval Rule
  config, Users, Audit Log. See `web-admin/README.md`.

**Not included in this slice** (see BRD sections 11-13, 17-20, 25, 26 web/mobile UI): OCR engine,
LLM extraction, automatic/fuzzy matching engine, Excel/CSV import, notifications, the mobile app,
and the web admin frontend. The schema already has the fields OCR/matching will need
(`invoices.ocr_*`, `invoices.matching_status`) so that worker can be added later without breaking
this API.

## ⚠️ Windows path caveat

This project directory contains an `&`, which breaks Windows `.cmd` shims (`npx prisma ...`,
`npx nest ...`, `npm run <script>` that calls those shims directly) — `cmd.exe` treats `&` as a
command separator and mangles the path. **Fix applied:** every `package.json` script now invokes
`node node_modules/<pkg>/<entry>.js` directly instead of the broken shim, so `npm run build`,
`npm run seed`, `npm run prisma:migrate`, etc. all work as-is.

If you run Prisma/Nest CLI commands **not** listed in `package.json` (e.g. `nest g module foo`),
either add a script for it the same way, or the permanent fix: rename the project folder to
remove the `&` (e.g. `Sales Client Entertainment and Expense Management System`).

## Setup

```bash
npm install
cp .env.example .env   # edit DATABASE_URL to point at your PostgreSQL instance
npm run prisma:migrate # creates tables + runs prisma/seed.ts
npm run start:dev
```

Seed creates:
- 5 roles (`SALES`, `SUPERVISOR`, `FINANCE`, `ADMIN`, `MANAGEMENT`)
- 2 default Approval Rules (<= Rp 1.000.000 → Supervisor; above → Supervisor + Management, per BRD section 22)
- Units matching the MNC Group structure Sales are assigned to (BRD section 6.2 example) —
  `HOLDING`, `RCTI`, `MNCTV`, `GTV` — and the BRD's default Activity Types
- an Admin user: `admin@example.com` / `Admin@12345` (override via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`)
- **Demo dataset** (password `Demo@12345`, override via `SEED_DEMO_PASSWORD`): 2 Agencies (GroupM,
  OMD), 4 Advertisers under them, 6 Brands (each owned by one Advertiser), Cost Centers, Expense
  Categories, 3 Merchants, 2 PODs (each 2 Agency→Brand pairs), and 5 users covering every role —
  - Sales: `budi.santoso@example.com` (POD "RCTI - Budi Coverage": GroupM→Pepsodent, OMD→Indomie), `siti.rahma@example.com` (POD "MNCTV - Siti Coverage": GroupM→Milo, OMD→Kopiko)
  - Supervisor: `andi.wijaya@example.com`
  - Finance: `rina.kartika@example.com`
  - Management: `bambang.hartono@example.com`

  Plus 5 Pre-Event requests (one each: draft/submitted/approved×2/rejected) and 5 Expenses walking every status
  (`DRAFT`/`PENDING_APPROVAL`/`APPROVED`/`REJECTED`/`SETTLED`) with invoices, approval trails, and a `podId`, so the
  Dashboard, Approvals inbox, and every list page have real data on first login. Re-running `npm run seed` skips the
  user/event/expense block if `budi.santoso@example.com` already exists, but Units, Agencies/Advertisers/Brands, and
  PODs all self-correct/find-or-create so schema-driven fixes still land without wiping transactional data.
- **Bulk POD/master-data stress dataset** (separate from the curated demo above, guarded on Agency
  code `AGY01`): 10 Agencies × 10 Advertisers each (100) × 10 Brands each (1000), and 50 Sales users
  split 5-per-POD across 10 PODs named `POD 1`..`POD 10` — since `Pod.salesId` is one Sales per row,
  each POD *name* is shared by 5 separate `Pod` rows (one per Sales), not a single row with 5 sales.
  Each Pod row gets 2 Agency→Brand coverage pairs. Names are drawn from word pools (Sales:
  first+last name combos; Agency: real-sounding media-agency names; Advertiser/Brand: prefix/suffix
  word combinations) rather than "Thing 1, Thing 2, ..." — only the `code` columns are sequential
  (`AGY01`, `ADV0001`, `BRD00001`, `SLS-2001`), since those need to be stable unique keys. Sales
  login: `sales1@example.com`..`sales50@example.com`, same `Demo@12345`/`SEED_DEMO_PASSWORD`. No
  Events/Expenses are generated for this bulk set (POD/master-data volume only) — it exists to
  stress-test list pages, search, and pickers at scale, not to add more transaction-status variety.

API is served under `/api/v1`. Login via `POST /api/v1/auth/login`, then send
`Authorization: Bearer <accessToken>` on subsequent requests.

## Module map

| Module | BRD section | Notes |
|---|---|---|
| `auth` | 34 | JWT access+refresh, bcryptjs password hashing |
| `users`, `roles` | 5.4, 26 | Admin manages Users + Role/Permission |
| `units`, `agencies`, `advertisers`, `brands`, `sales-assignments`, `activity-types`, `cost-centers`, `expense-categories`, `merchants` | 16 | Master Data CRUD. Agency → Advertiser → Brand is a strict ownership chain — see note below |
| `pods` | 6.2 | POD = a named coverage group for one Sales containing multiple Agency→Brand pairs — see note below |
| `events` | 7, 8 | Pre-Event request with its own submit/approve/reject — **mandatory**, see note below |
| `expenses` | 9, 28, BR-001..BR-015 | Core expense entity, item lines, expense-number generation, manual entry on behalf of a Sales (Admin/Finance) |
| `invoices` | 10-12, 15, 21, 29, 30 | Manual entry now (`final_*` fields); `ocr_*`/`matching_status` reserved for the OCR/LLM worker phase; file upload via local disk `StorageService` (swap for S3/MinIO later — only `storageKey` ever leaves that module) |
| `approvals` | 22, 23, 26, BR-013/014 | Configurable `ApprovalRule`s by amount/unit, ordered role sequence, `ApprovalRequest`/`ApprovalAction` audit chain |
| `audit-logs` | 24, 26 | Every mutating action across the API writes to `audit_logs` via the global `AuditService` |
| `dashboard` | 5.5, 37 | Summary + expense-by-unit/sales/advertiser/brand/pod/month, all filterable by `?from=&to=` date range |
| `import` | 17, 26 | Excel/CSV/PDF import for Agency, Advertiser, Brand, Merchant, **Expense**, plus a downloadable empty `.xlsx` template per entity — see below |

## Key flows

- **Agency → Advertiser → Brand** (business-rule clarification — Agency and Advertiser are
  deliberately distinct entities, not aliases of each other): an `Agency` (e.g. a media buying
  agency like GroupM) represents many `Advertiser`s; each `Advertiser` (e.g. PT Unilever
  Indonesia — this is what the BRD originally called "Client") owns many `Brand`s; each `Brand`
  belongs to **exactly one** `Advertiser` — never shared, so `brands.advertiserId` is a required
  1:N foreign key, not a link table. `Event`/`Expense` carry `advertiserId` + `brandId` directly
  (renamed from `clientId`, denormalized for historical accuracy even though `brandId` alone would
  technically determine the advertiser). This replaced the original BRD's single `Client` entity —
  see the `agency_advertiser_brand` migration.
- **POD structure** (BRD section 6.2, refined twice as Agency/Advertiser split out and the
  cascading picker UX landed): a POD is a named entity (`Pod`) — `name`, one `salesId`, optional
  `unitId` — containing multiple `PodAssignment` rows, each an `Agency` paired with one `Brand`.
  One Agency can now cover **many** Brands within a POD (pick the Agency, pick one or more of its
  Advertisers, pick one or more of their Brands) — uniqueness is `PodAssignment.@@unique([podId,
  brandId])` (a Brand can't appear twice in one POD), not per-Agency. `PodsService` still validates
  that every paired Brand's actual Advertiser/Agency ownership chain matches the selected Agency
  (rejected with 400 otherwise). `POST /pods` takes `{ name, salesIds: string[], unitId?,
  assignments: [{ agencyId, brandId }, ...] }` — since `Pod.salesId` is single-Sales, one `Pod` row
  is created per `salesIds` entry, all sharing the same name/assignments (so "POD 1" selected with
  5 Sales creates 5 rows, matching the seeded bulk dataset's shape). `POST /pods/:id/assignments` /
  `DELETE /pods/:id/assignments/:assignmentId` manage pairs on one existing row afterward.
- **Pre-Event is mandatory** (business-rule change on top of the BRD's optional BR-004/BR-005):
  Sales must `POST /events` + `/events/:id/submit`, and get it `APPROVED` by their Supervisor
  ("Head POD" — same role, no separate concept) before they can spend anything. `POST /expenses`
  requires `eventId` pointing at that Sales' own `APPROVED` event; `advertiserId`/`brandId`/
  `activityTypeId`/`unitId` are inherited from the event, not re-entered. `ExpenseSource` /
  "Create Expense Without Pre-Event" from the original BRD no longer exists in the schema.
  Admin/Finance can also `POST /events` (and `PATCH`/`:id/submit`) with an optional `salesId` in
  the body to manually create/edit/submit a Pre-Event on behalf of another Sales — same "on behalf
  of" pattern as manual Expense entry below, ignored for a plain Sales caller.
- **Submit requires an invoice attached** (BR-006): `POST /expenses/:id/submit` fails until at least one `POST /expenses/:expenseId/invoices` has been made.
- **Approval routing**: on submit, the amount/unit is matched against active `ApprovalRule`s (admin-configurable, no code change needed — BRD section 19/22) to build the required-role sequence; falls back to a single Supervisor step if no rule matches.
- **Rejection + resubmit** (section 23): `POST /approvals/:expenseId/reject` requires a reason; the expense flips to `REJECTED`, the Sales owner edits it (auto-moves to `REVISION`), then `POST /expenses/:id/submit` again re-runs approval routing from step 0.
- **Invoice data integrity** (section 21): `invoices` keeps `ocr_*` and `final_*` columns separate; this API only ever writes `final_*` + `modifiedBy`/`modifiedAt`.
- **Manual expense entry on behalf of a Sales**: Admin/Finance can `POST /expenses` (and `PATCH`/`:id/submit`) with an optional `salesId` in the body — the target Sales still needs their own `APPROVED` Pre-Event (ownership is checked against `salesId`, not the caller), used for historical/corrective entry. A plain Sales caller can never set `salesId`; it's silently ignored.
- **Import** (section 17): `GET /import/:entityType/template` downloads an empty `.xlsx` (header row + one example row) for the given entity. `POST /import/:entityType/preview` (multipart file, `entityType` = `AGENCY`|`ADVERTISER`|`BRAND`|`MERCHANT`|`EXPENSE`) parses + validates without persisting anything — returns each row tagged `VALID`/`INVALID`/`DUPLICATE` plus a totals summary. `ADVERTISER` rows need an `agencyCode` column, `BRAND` rows need an `advertiserCode` column (both resolved against existing Master Data, `INVALID` if not found — reflecting the Agency→Advertiser→Brand ownership chain). `EXPENSE` rows need `eventNo` (an existing `APPROVED` Pre-Event), `expenseDate`, `purpose`, `amount`, optional `costCenterCode` — every row is a distinct transaction (no duplicate detection, unlike the master-data types) and insertion delegates to the same `ExpensesService.create()` used by manual/on-behalf entry, with `salesId` taken from the Event's owner so the ownership check passes for the importing Admin/Finance. `POST /import/:entityType/commit` (JSON `{ rows }`, same rows sent back from preview) re-validates server-side and inserts only the `VALID` ones. Implemented as stateless calls rather than an async `import_jobs` worker, since these files are small enough to parse synchronously in-request. CSV and Excel (`exceljs`) parse exactly; **PDF is best-effort** — it assumes one simple table (e.g. exported from a spreadsheet) and splits lines on 2+ spaces/tab, so accuracy depends entirely on the source PDF's layout.
- **Search**: `GET /expenses`, `/events`, `/agencies`, `/advertisers`, `/brands`, `/pods` all accept `?search=` (case-insensitive `contains` across code/name, or expenseNo/purpose/sales/advertiser/brand for Expense/Event, or name for Pod). `/brands` additionally caps results at 200 and accepts `?advertiserIds=a,b,c` (comma-separated) to narrow by owning Advertiser — used by the POD page's cascading Agency→Advertiser→Brand picker, since Brand alone can run into the thousands.

## Security (BRD section 34)

Helmet, global rate limiting (`@nestjs/throttler`), JWT auth guard + role guard on every route,
class-validator input validation, invoice download gated by ownership/role (no public URLs),
file-type/size validation on upload. The Import module intentionally uses `exceljs` rather than
the popular `xlsx`/SheetJS package, which has an unpatched prototype-pollution advisory on the npm
registry; `multer` is pinned to `^2.2.0` via `overrides` to pick up a DoS fix past the version
`@nestjs/platform-express` pulls in by default.

**Known follow-up**: `web-admin` is pinned to `next@14.2.35` (latest 14.x patch) rather than the
current `next@16`, because upgrading to 16 is a breaking change (React 19, async dynamic route
params) that would need re-testing every page. `npm audit` in `web-admin/` still flags several
Next.js advisories whose stated affected range is broad and not all confirmed to still apply at
14.2.35 — acceptable for an internal admin tool behind auth in Phase 1, but worth a deliberate
Next 16 migration pass before wider/external exposure.
