import 'dotenv/config';
import { ApprovalScopeType, DocumentStage, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { RoleName } from '../src/common/constants/role-name';
import { seedMasterSnapshot } from './seed-master-snapshot';

const prisma = new PrismaClient();

// Renames a Unit's code/name in place if the old code still exists (keeps every FK
// that points at it intact), otherwise upserts the new code fresh. Lets us correct
// the demo Unit codes on an already-seeded DB without a destructive wipe.
async function renameUnitCode(oldCode: string, newCode: string, newName: string, revenueSharePercent?: number, unitCode?: string) {
  if (oldCode !== newCode) {
    const existing = await prisma.unit.findUnique({ where: { code: oldCode } });
    if (existing) {
      return prisma.unit.update({ where: { id: existing.id }, data: { code: newCode, name: newName, revenueSharePercent, unitCode } });
    }
  }
  return prisma.unit.upsert({
    where: { code: newCode },
    update: { revenueSharePercent, unitCode },
    create: { code: newCode, name: newName, revenueSharePercent, unitCode },
  });
}

// The Administrator role used to be called 'ADMIN' (renamed to RoleName.ADMIN by migration
// 20260924150000_rename_admin_role, which only touches rows that exist when it runs). On a DB
// seeded from an older snapshot the old row can still carry the admin user - and the code only
// recognises 'ADMINISTRATOR', so that user gets no role-based access at all. Rename it in place,
// or, if 'ADMINISTRATOR' already exists too, move its users/permissions across and drop it.
async function renameLegacyAdminRole() {
  const legacy = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
  if (!legacy) return;
  const current = await prisma.role.findUnique({ where: { name: RoleName.ADMIN } });
  if (!current) {
    await prisma.role.update({ where: { id: legacy.id }, data: { name: RoleName.ADMIN } });
    return;
  }
  const users = await prisma.userRole.findMany({ where: { roleId: legacy.id } });
  await prisma.userRole.createMany({ data: users.map((u) => ({ userId: u.userId, roleId: current.id })), skipDuplicates: true });
  const perms = await prisma.rolePermission.findMany({ where: { roleId: legacy.id } });
  await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: current.id, permissionId: p.permissionId })), skipDuplicates: true });
  await prisma.role.delete({ where: { id: legacy.id } });
}

async function main() {
  // Master-data snapshot first (fresh DB only, see seed-master-snapshot.ts); everything
  // below is idempotent upserts keyed by code/name, so it just tops that up.
  await seedMasterSnapshot(prisma);

  await renameLegacyAdminRole();

  // SUPERVISOR / FINANCE were dropped from RoleName (migration 20260923120501) - remove any
  // leftover Role rows (user_roles / role_permissions cascade) from older databases.
  await prisma.role.deleteMany({ where: { name: { in: ['SUPERVISOR', 'FINANCE'] } } });

  // Roles (BRD section 5). RoleName's 4 built-ins are backed by @Roles guards; the rest
  // are custom roles (see role-name.ts's comment) - just Role master-data rows an Admin
  // assigns permissions to via System > Permission, same as one created through the Role page.
  for (const name of [...Object.values(RoleName), ...CUSTOM_ROLES]) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Fine-grained overrides on top of RolesGuard's role checks - each code below is
  // read by name in a service/controller (see RequirePermission call sites), so
  // System > Permission (BRD section 26) has real rows an Admin can assign to a Role.
  const permissionCodes = [
    'expense.read.all',
    'expense.read.own',
    'expense.read.owndept',
    'expense.edit.own',
    'expense.edit.all',
    'expense.edit.owndept',
    'expense.approve.all',
    'expense.approve.owndept',
    'expense.automatch',
    'expense.match.all',
    'expense.match.owndept',
    'expense.match.ownpod',
    'expense.create.all',
    'expense.create.own',
    'expense.create.owndept',
    'request.expense.create.owndept',
    'request.expense.edit.owndept',
    'request.expense.read.owndept',
    'approval.read.all',
    'approval.read.owndept',
    'settlement.read.owndept',
    'settlement.read.all',
    'settlement.create.owndept',
    'settlement.send.odoo.owndept',
    'settlement.send.odoo.all',
    'dashboard.read.own',
    'dashboard.read.all',
    'dashboard.read.owndept',
    'webmobile.dashboard.read.own',
    'webmobile.dashboard.read.owndept',
    // Web mobile (digital_settlement_fe -> web mobile) page access + data scope.
    'webmobile.expense.create.own',
    'webmobile.expense.create.owndept',
    'webmobile.expense.read.own',
    'webmobile.expense.read.owndept',
    'webmobile.request.expense.create.own',
    'webmobile.request.expense.create.owndept',
    'webmobile.request.expense.read.own',
    'webmobile.request.expense.read.owndept',
    'webmobile.settlement.read.owndept',
    'webmobile.approval.read.own',
    'webmobile.approval.read.owndept',
    'webmobile.profile.read.own',
    'audit-report.read.all',
    'audit-report.read.owndept',
    'master.manage',
    'user.manage',
    'report.export',
  ];
  for (const code of permissionCodes) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }

  // Administrator always holds every permission, including ones added after the DB was first
  // seeded (a re-run picks them up).
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
  const allPermissions = await prisma.permission.findMany({ select: { id: true, code: true } });
  await prisma.rolePermission.createMany({
    data: allPermissions.map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  // Default permission set of every other role - additive only (skipDuplicates), so a
  // re-run never removes anything an Admin granted under System > Permission.
  const roleIds = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.name, r.id]));
  const permissionIds = Object.fromEntries(allPermissions.map((p) => [p.code, p.id]));
  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    await prisma.rolePermission.createMany({
      data: codes.map((code) => ({ roleId: roleIds[roleName], permissionId: permissionIds[code] })),
      skipDuplicates: true,
    });
  }

  // Position master data (approver basis for Approval Level chains, BRD section
  // 22-23) - the org-chart job titles behind the Expense chain (HEAD_POD -> CO-CSO,
  // see CLAUDE.md) and the Settlement chain (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV ->
  // CO_CFO_3TV), plus SLS/SLSADM front-line titles.
  const positionDefs = [
    { code: 'ADMIN', name: 'Administrator' },
    { code: 'SLS', name: 'Sales' },
    { code: 'HEAD-POD', name: 'Head POD' },
    { code: 'CO-CSO', name: 'Co-Chief Sales Officer (Ads) MNC Media' },
    { code: 'SLSADM', name: 'Sales Admin' },
    { code: 'SLS-MAR-DIR', name: 'Sales & Marketing Director (Ads) MNC Media' },
    { code: 'VP-ACC-BIL-TAX-3TV', name: 'VP Accounting, Billing & Tax 3TV' },
    { code: 'CO-CFO-3TV', name: 'Co-Chief Finance Officer 3FTA' },
    // Expense Request (Karangan Bunga): Div Head is the sole approver for e.g. HRD; SLS_CS/CORSEC are
    // the post-approval stages (budget entry, then verification).
    { code: 'DIV-HEAD', name: 'Division Head' },
    { code: 'SLS-CS', name: 'Sales Customer Service' },
    { code: 'CORSEC', name: 'Corporate Secretary (Corsec)' },
    { code: 'STAFF', name: 'Staff' },
    { code: 'SLS-PARTNER', name: 'Sales Partner' },
    { code: 'DEPT-HEAD', name: 'Department Head' },
  ];
  for (const p of positionDefs) {
    await prisma.position.upsert({ where: { code: p.code }, update: { name: p.name }, create: p });
  }

  // Units: MNC Group structure - Holding + the TV network Units Sales are assigned to
  // (BRD section 6.2 example: "Sales: Budi, Unit: RCTI"). renameUnitCode migrates an
  // already-seeded DB's old 'HO'/'JKT'/'SBY' codes in place rather than wiping data.
  // Default Settlement allocation split (Create Settlement popup's Unit/Persentase
  // rows prefill from this - see SettlementAllocation).
  await renameUnitCode('HO', 'HOLDING', 'Holding');
  await renameUnitCode('JKT', 'RCTI', 'RCTI', 48, '84');
  await renameUnitCode('SBY', 'MNCTV', 'MNCTV', 43, '86');
  await prisma.unit.upsert({
    where: { code: 'GTV' },
    update: { revenueSharePercent: 14, unitCode: '85' },
    create: { code: 'GTV', name: 'GTV', revenueSharePercent: 14, unitCode: '85' },
  });
  await prisma.unit.upsert({
    where: { code: 'INEWS' },
    update: { unitCode: '83' },
    create: { code: 'INEWS', name: 'INews', unitCode: '83' },
  });

  const activityNames = ['Karangan Bunga', 'Sumbangan', 'Parcel/Bingkisan', 'Souvenir', 'Ucapan Simpati', 'Makanan/Kue'];
  for (const name of activityNames) {
    await prisma.activityType.upsert({ where: { name }, update: {}, create: { name } });
  }

  await seedMasterData();
  await seedPodDepartments();
  await seedApprovalLevels();
  await seedCoreUsers();
}

// Agency -> Advertiser -> Brand master data (strict ownership chain - an Advertiser
// belongs to exactly one Agency, a Brand to exactly one Advertiser), Cost Centers,
// Expense Categories and Payment Methods. Fully
// idempotent (upserts only), safe to re-run.
async function seedMasterData() {
  const agencyDefs = [
    { code: 'GRPM', name: 'GroupM Indonesia' },
    { code: 'OMD', name: 'OMD Indonesia' },
  ];
  const agencies = Object.fromEntries(
    await Promise.all(
      agencyDefs.map(async (a) => [a.code, await prisma.agency.upsert({ where: { code: a.code }, update: {}, create: a })]),
    ),
  );

  const advertiserDefs = [
    { code: 'UNVR', name: 'PT Unilever Indonesia', agencyCode: 'GRPM' },
    { code: 'NESTLE', name: 'PT Nestle Indonesia', agencyCode: 'GRPM' },
    { code: 'INDF', name: 'PT Indofood Sukses Makmur', agencyCode: 'OMD' },
    { code: 'MYOR', name: 'PT Mayora Indah', agencyCode: 'OMD' },
  ];
  const advertisers = Object.fromEntries(
    await Promise.all(
      advertiserDefs.map(async (a) => [
        a.code,
        await prisma.advertiser.upsert({
          where: { code: a.code },
          update: {},
          create: { code: a.code, name: a.name, agencyId: agencies[a.agencyCode].id },
        }),
      ]),
    ),
  );

  const brandDefs = [
    { code: 'PEPSODENT', name: 'Pepsodent', advertiserCode: 'UNVR' },
    { code: 'LIFEBUOY', name: 'Lifebuoy', advertiserCode: 'UNVR' },
    { code: 'MILO', name: 'Milo', advertiserCode: 'NESTLE' },
    { code: 'INDOMIE', name: 'Indomie', advertiserCode: 'INDF' },
    { code: 'KOPIKO', name: 'Kopiko', advertiserCode: 'MYOR' },
    { code: 'BENGBENG', name: 'Beng-Beng', advertiserCode: 'MYOR' },
  ];
  await Promise.all(
    brandDefs.map((b) =>
      prisma.brand.upsert({
        where: { code: b.code },
        update: {},
        create: { code: b.code, name: b.name, advertiserId: advertisers[b.advertiserCode].id },
      }),
    ),
  );

  const [ccSales, ccOps] = await Promise.all([
    prisma.costCenter.upsert({ where: { code: 'CC-SALES' }, update: {}, create: { code: 'CC-SALES', name: 'Sales & Marketing' } }),
    prisma.costCenter.upsert({ where: { code: 'CC-OPS' }, update: {}, create: { code: 'CC-OPS', name: 'Operations' } }),
  ]);
  void ccSales;
  void ccOps;

  await Promise.all(
    [
      { code: 'MEAL', name: 'Meals & Entertainment' },
      { code: 'TRANSPORT', name: 'Transportation' },
      { code: 'GIFT', name: 'Client Gift' },
      { code: 'OTHER', name: 'Other' },
    ].map((c) => prisma.expenseCategory.upsert({ where: { code: c.code }, update: {}, create: c })),
  );

  await Promise.all(
    [
      { code: 'AP_DISBURSEMENT', name: 'AP Disbursement' },
      { code: 'CORPORATE_CARD', name: 'Corporate Card' },
      { code: 'PETTY_CASH', name: 'Petty Cash' },
      { code: 'REIMBURSEMENT', name: 'Reimbursement' },
    ].map((m) => prisma.paymentMethod.upsert({ where: { code: m.code }, update: {}, create: m })),
  );
}

// Department (coverage-group, BRD section 6.2) master data: POD1..POD7, plus a
// large Agency/Advertiser/Brand stress dataset (10 agencies x 10 advertisers x 10
// brands) so master-data pickers have real volume to page/search through. The
// bulk Agency/Advertiser/Brand generation is guarded on the AGY01 agency code so
// re-running seed is a no-op there; the 7 Departments upsert unconditionally
// (skipDuplicates) so they self-correct independent of that guard.
async function seedPodDepartments() {
  for (let i = 1; i <= 7; i++) {
    await prisma.department.upsert({ where: { name: `POD${i}` }, update: { code: `POD${i}` }, create: { code: `POD${i}`, name: `POD${i}` } });
  }

  const alreadySeeded = !!(await prisma.agency.findUnique({ where: { code: 'AGY01' } }));
  if (alreadySeeded) {
    // eslint-disable-next-line no-console
    console.log('Bulk Agency/Advertiser/Brand demo dataset already seeded, skipping.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Seeding bulk Agency/Advertiser/Brand demo dataset (10 agencies x 10 advertisers x 10 brands)...');

  const agencyData = Array.from({ length: 10 }, (_, i) => ({
    code: `AGY${String(i + 1).padStart(2, '0')}`,
    name: AGENCY_NAMES[i],
  }));
  await prisma.agency.createMany({ data: agencyData });
  const agencies = await prisma.agency.findMany({
    where: { code: { in: agencyData.map((a) => a.code) } },
    orderBy: { code: 'asc' },
  });

  const advertiserData = agencies.flatMap((agency, agencyIdx) =>
    Array.from({ length: 10 }, (_, j) => {
      const n = agencyIdx * 10 + j + 1;
      return {
        code: `ADV${String(n).padStart(4, '0')}`,
        name: `PT ${ADVERTISER_PREFIXES[agencyIdx]} ${ADVERTISER_SUFFIXES[j]}`,
        agencyId: agency.id,
      };
    }),
  );
  await prisma.advertiser.createMany({ data: advertiserData });
  const advertisers = await prisma.advertiser.findMany({
    where: { code: { in: advertiserData.map((a) => a.code) } },
    orderBy: { code: 'asc' },
  });

  // 1000 Brands (10 per Advertiser) - 3-word names via mixed-radix index over
  // 20x10x6=1200 combos (>1000, so all 1000 are guaranteed unique, no counting suffix).
  const brandData = advertisers.flatMap((advertiser, advIdx) =>
    Array.from({ length: 10 }, (_, k) => {
      const n = advIdx * 10 + k; // 0-based global brand index, 0..999
      const c = n % BRAND_WORDS_C.length;
      const b = Math.floor(n / BRAND_WORDS_C.length) % BRAND_WORDS_B.length;
      const a = Math.floor(n / (BRAND_WORDS_C.length * BRAND_WORDS_B.length)) % BRAND_WORDS_A.length;
      return {
        code: `BRD${String(n + 1).padStart(5, '0')}`,
        name: `${BRAND_WORDS_A[a]} ${BRAND_WORDS_B[b]} ${BRAND_WORDS_C[c]}`,
        advertiserId: advertiser.id,
      };
    }),
  );
  await prisma.brand.createMany({ data: brandData });

  // eslint-disable-next-line no-console
  console.log(`Seeded ${agencies.length} agencies, ${advertisers.length} advertisers, ${brandData.length} brands.`);
}

// Roles that are plain master data (no @Roles guard behind them) - see role-name.ts.
const CUSTOM_ROLES = ['HEAD DEPARTMENT', 'HEAD_POD', 'CO_CSO', 'SALES_CUSTOMER_SERVICE', 'CORSEC'];

// Default permissions per role (Administrator gets every permission separately).
// The webmobile.* page codes (other than the dashboard ones) mirror what each role already saw in
// Web Mobile before those pages were permission-gated, so seeding keeps every role's current tabs.
const ROLE_PERMISSIONS: Record<string, string[]> = {
  SALES: [
    'dashboard.read.own', 'expense.create.own', 'expense.read.own', 'request.expense.create.owndept', 'webmobile.dashboard.read.own',
    'webmobile.expense.create.own', 'webmobile.expense.read.own', 'webmobile.request.expense.create.own',
    'webmobile.request.expense.read.own', 'webmobile.approval.read.own', 'webmobile.profile.read.own',
  ],
  SALES_ADMIN: [
    'dashboard.read.owndept', 'expense.automatch', 'expense.create.owndept', 'expense.match.owndept',
    'expense.read.owndept', 'settlement.create.owndept', 'settlement.read.owndept', 'settlement.send.odoo.owndept',
    'webmobile.expense.create.owndept', 'webmobile.expense.read.owndept', 'webmobile.request.expense.create.owndept',
    'webmobile.request.expense.read.owndept', 'webmobile.settlement.read.owndept', 'webmobile.approval.read.own',
    'webmobile.profile.read.own',
  ],
  MANAGEMENT: [
    'approval.read.all', 'dashboard.read.owndept', 'expense.approve.all', 'expense.read.all', 'settlement.read.owndept',
    'webmobile.dashboard.read.owndept', 'webmobile.request.expense.read.owndept', 'webmobile.settlement.read.owndept',
    'webmobile.approval.read.own', 'webmobile.profile.read.own',
  ],
  HEAD_POD: [
    'approval.read.owndept', 'audit-report.read.owndept', 'dashboard.read.owndept',
    'expense.approve.owndept', 'expense.edit.owndept', 'expense.read.owndept', 'webmobile.dashboard.read.owndept',
    'webmobile.expense.read.owndept', 'webmobile.request.expense.read.owndept', 'webmobile.approval.read.own',
    'webmobile.profile.read.own',
  ],
  'HEAD DEPARTMENT': [
    'approval.read.owndept', 'audit-report.read.owndept', 'dashboard.read.owndept',
    'expense.approve.owndept', 'expense.edit.owndept', 'expense.read.owndept', 'webmobile.dashboard.read.owndept',
    'webmobile.expense.read.owndept', 'webmobile.request.expense.read.owndept', 'webmobile.approval.read.own',
    'webmobile.profile.read.own',
  ],
  CO_CSO: [
    'approval.read.owndept', 'audit-report.read.owndept', 'dashboard.read.all', 'dashboard.read.owndept',
    'expense.approve.owndept', 'expense.read.owndept', 'settlement.read.all', 'settlement.read.owndept',
    'webmobile.dashboard.read.owndept', 'webmobile.expense.read.owndept', 'webmobile.request.expense.read.owndept',
    'webmobile.settlement.read.owndept', 'webmobile.approval.read.own', 'webmobile.profile.read.own',
  ],
  // Expense Request stages: Sales Customer Service fills the budget, Corsec verifies and raises the
  // Expense from an approved Request (see CLAUDE.md "Expense from Expense Request").
  SALES_CUSTOMER_SERVICE: [
    'dashboard.read.owndept', 'request.expense.edit.owndept', 'webmobile.dashboard.read.owndept',
    'webmobile.expense.read.own', 'webmobile.request.expense.read.owndept', 'webmobile.approval.read.own',
    'webmobile.profile.read.own',
  ],
  CORSEC: [
    'dashboard.read.owndept', 'expense.create.owndept', 'request.expense.read.owndept',
    'webmobile.expense.create.owndept', 'webmobile.expense.read.owndept', 'webmobile.request.expense.read.owndept',
    'webmobile.approval.read.own', 'webmobile.profile.read.own',
  ],
};

const ALL_PODS = ['POD1', 'POD2', 'POD3', 'POD4', 'POD5', 'POD6', 'POD7'];

// Approval Levels (BRD section 22-23). Each is created only if no Level with that name exists,
// so a re-run never overrides a chain an Admin edited. `requestorPositions` / `activityTypes` are
// optional filters (empty = any); `steps` are Position codes in order. All are scoped to every POD.
// Only ever one SETTLEMENT Level: resolveApprovalLevel() breaks a tie between two same-scope,
// same-amount-range Levels by updatedAt, so a second one would let a re-run silently take over.
const APPROVAL_LEVELS: {
  name: string;
  documentStage: DocumentStage;
  steps: string[];
  requestorPositions?: string[];
  activityTypes?: string[];
}[] = [
  { name: 'Expense From Sales', documentStage: DocumentStage.EXPENSES, requestorPositions: ['SLS'], steps: ['HEAD-POD', 'CO-CSO'] },
  { name: 'Expense From Co CSO', documentStage: DocumentStage.EXPENSES, requestorPositions: ['CO-CSO'], steps: ['SLS-MAR-DIR'] },
  { name: 'Settlement - All', documentStage: DocumentStage.SETTLEMENT, steps: ['SLS-MAR-DIR', 'VP-ACC-BIL-TAX-3TV', 'CO-CFO-3TV'] },
  {
    name: 'Expense Request - Karangan Bunga',
    documentStage: DocumentStage.EXPENSE_REQUEST,
    activityTypes: ['Karangan Bunga'],
    steps: ['HEAD-POD', 'SLS-CS'],
  },
  // EXPENSES chain of an Expense raised from an approved Expense Request (see ExpensesService.createFromExpenseRequest).
  { name: 'Expense - Karangan Bunga', documentStage: DocumentStage.EXPENSES, activityTypes: ['Karangan Bunga'], steps: ['SLSADM', 'CO-CSO'] },
];

async function seedApprovalLevels() {
  const positions = Object.fromEntries((await prisma.position.findMany()).map((p) => [p.code, p.id]));
  const departments = await prisma.department.findMany({ where: { name: { in: ALL_PODS } } });
  const activityTypes = Object.fromEntries((await prisma.activityType.findMany()).map((a) => [a.name, a.id]));

  for (const def of APPROVAL_LEVELS) {
    if (await prisma.approvalLevel.findFirst({ where: { name: def.name } })) continue;
    // A Settlement Level under another name (e.g. legacy "Settlement - Standard") already covers the stage.
    if (def.documentStage === DocumentStage.SETTLEMENT && (await prisma.approvalLevel.findFirst({ where: { documentStage: def.documentStage } }))) continue;
    await prisma.approvalLevel.create({
      data: {
        name: def.name,
        documentStage: def.documentStage,
        scopeType: ApprovalScopeType.DEPARTMENT,
        minAmount: 0,
        steps: { create: def.steps.map((code, i) => ({ stepOrder: i, positionId: positions[code] })) },
        departments: { create: departments.map((d) => ({ departmentId: d.id })) },
        requestorPositions: { create: (def.requestorPositions ?? []).map((code) => ({ positionId: positions[code] })) },
        activityTypes: { create: (def.activityTypes ?? []).map((name) => ({ activityTypeId: activityTypes[name] })) },
      },
    });
  }
}

// Core users (BRD Expense/Settlement approval chain walkthrough): Admin, Sales POD1-3, Head POD1-7,
// 2x Co-CSO, the 3 Settlement approvers, Sales Admin / Sales Partner for POD1, Sales CS and Corsec (all PODs).
// Idempotent - re-running self-corrects employeeId/name/position/unit on an existing row and
// adds any missing role / Department membership, but never touches an existing password.
const CORE_USERS: {
  employeeId: string;
  name: string;
  email: string;
  position: string;
  role: string;
  unit?: string;
  departments: string[];
  admin?: boolean;
}[] = [
  { employeeId: '0000000001', name: 'System Administrator', email: 'admin@dev.local', position: 'ADMIN', role: RoleName.ADMIN, departments: ALL_PODS, admin: true },
  { employeeId: '2601010001', name: 'Sales POD 1 - 01', email: 'sales.pod1.1@dev.local', position: 'SLS', role: RoleName.SALES, departments: ['POD1'] },
  { employeeId: '2601010002', name: 'Head POD 1', email: 'head.pod1@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', departments: ['POD1'] },
  { employeeId: '2601010003', name: 'Dendy Alfajri Wijaya', email: 'co.cso.1@dev.local', position: 'CO-CSO', role: 'CO_CSO', departments: ['POD1', 'POD4', 'POD5', 'POD6'] },
  { employeeId: '2601010004', name: 'Pandhu Wiguna', email: 'co.cso.2@dev.local', position: 'CO-CSO', role: 'CO_CSO', departments: ['POD2', 'POD3', 'POD7'] },
  { employeeId: '2601010005', name: 'Kanti Mirdiati', email: 'sales.bod@dev.local', position: 'SLS-MAR-DIR', role: RoleName.MANAGEMENT, departments: ALL_PODS },
  { employeeId: '2601010006', name: 'Veronika Lawy', email: 'vp@dev.local', position: 'VP-ACC-BIL-TAX-3TV', role: RoleName.MANAGEMENT, departments: ALL_PODS },
  { employeeId: '2601010007', name: 'Jarod Suwahjo', email: 'co.cfo@dev.local', position: 'CO-CFO-3TV', role: RoleName.MANAGEMENT, departments: ALL_PODS },
  { employeeId: '2601010008', name: 'Head POD2', email: 'head.pod2@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', departments: ['POD2'] },
  { employeeId: '2601010009', name: 'Head POD3', email: 'head.pod3@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', departments: ['POD3'] },
  { employeeId: '2601010010', name: 'Head POD4', email: 'head.pod4@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', departments: ['POD4'] },
  { employeeId: '2601010011', name: 'Head POD5', email: 'head.pod5@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', unit: 'MNCTV', departments: ['POD5'] },
  { employeeId: '2601010012', name: 'Head POD6', email: 'head.pod6@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', departments: ['POD6'] },
  { employeeId: '2601010013', name: 'Head POD7', email: 'head.pod7@dev.local', position: 'HEAD-POD', role: 'HEAD_POD', departments: ['POD7'] },
  { employeeId: '2601010014', name: 'Sales Partner POD1', email: 'salespartner.pod1@dev.local', position: 'SLS-PARTNER', role: 'HEAD_POD', departments: ['POD1'] },
  { employeeId: '2601010015', name: 'Sales POD2 - 01', email: 'sales.pod2.1@dev.local', position: 'SLS', role: RoleName.SALES, departments: ['POD2'] },
  { employeeId: '2601010016', name: 'Sales POD3 - 01', email: 'sales.pod3.1@dev.local', position: 'SLS', role: RoleName.SALES, departments: ['POD3'] },
  { employeeId: '2601010017', name: 'Sales Admin POD1', email: 'salesadmin.pod1@dev.local', position: 'SLSADM', role: RoleName.SALES_ADMIN, departments: ['POD1'] },
  { employeeId: '2601010018', name: 'Sales CS', email: 'salescs@dev.local', position: 'SLS-CS', role: 'SALES_CUSTOMER_SERVICE', departments: ALL_PODS },
  { employeeId: '2601010019', name: 'Corsec', email: 'corsec@dev.local', position: 'CORSEC', role: 'CORSEC', departments: ALL_PODS },
];

// Department approvers (DepartmentPositionAssignment): [Department, Position code, user email].
// A Position with no row for a Department falls back to the first active holder (ANY scope).
const DEPARTMENT_APPROVERS: [string, string, string][] = [
  ['POD1', 'HEAD-POD', 'head.pod1@dev.local'],
  ['POD2', 'HEAD-POD', 'head.pod2@dev.local'],
  ['POD1', 'CO-CSO', 'co.cso.1@dev.local'],
  ['POD4', 'CO-CSO', 'co.cso.1@dev.local'],
  ['POD5', 'CO-CSO', 'co.cso.1@dev.local'],
  ['POD6', 'CO-CSO', 'co.cso.1@dev.local'],
  ['POD2', 'CO-CSO', 'co.cso.2@dev.local'],
  ['POD1', 'SLS-MAR-DIR', 'sales.bod@dev.local'],
  ['POD2', 'SLS-MAR-DIR', 'sales.bod@dev.local'],
  ['POD4', 'SLS-MAR-DIR', 'sales.bod@dev.local'],
  ['POD5', 'SLS-MAR-DIR', 'sales.bod@dev.local'],
  ['POD6', 'SLS-MAR-DIR', 'sales.bod@dev.local'],
  ['POD1', 'VP-ACC-BIL-TAX-3TV', 'vp@dev.local'],
  ['POD2', 'VP-ACC-BIL-TAX-3TV', 'vp@dev.local'],
  ['POD1', 'CO-CFO-3TV', 'co.cfo@dev.local'],
  ['POD2', 'CO-CFO-3TV', 'co.cfo@dev.local'],
  ['POD1', 'SLS-CS', 'salescs@dev.local'],
];

async function seedCoreUsers() {
  const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || '123456789';
  const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || '123456789';
  const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const demoPasswordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.name, r.id]));
  const positions = Object.fromEntries((await prisma.position.findMany()).map((p) => [p.code, p.id]));
  const units = Object.fromEntries((await prisma.unit.findMany()).map((u) => [u.code, u.id]));
  const departments = Object.fromEntries((await prisma.department.findMany()).map((d) => [d.name, d.id]));
  const userIds: Record<string, string> = {};

  for (const def of CORE_USERS) {
    const data = {
      employeeId: def.employeeId,
      name: def.name,
      positionId: positions[def.position],
      unitId: units[def.unit ?? 'RCTI'],
    };
    const existing = await prisma.user.findUnique({ where: { email: def.email } });
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data })
      : await prisma.user.create({
          data: { ...data, email: def.email, passwordHash: def.admin ? adminPasswordHash : demoPasswordHash },
        });
    userIds[def.email] = user.id;
    await prisma.userRole.createMany({ data: [{ userId: user.id, roleId: roles[def.role] }], skipDuplicates: true });
    await prisma.userDepartment.createMany({
      data: def.departments.map((d) => ({ userId: user.id, departmentId: departments[d] })),
      skipDuplicates: true,
    });
  }

  for (const [dept, position, email] of DEPARTMENT_APPROVERS) {
    const key = { departmentId: departments[dept], positionId: positions[position] };
    await prisma.departmentPositionAssignment.upsert({
      where: { departmentId_positionId: key },
      update: { userId: userIds[email] },
      create: { ...key, userId: userIds[email] },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${CORE_USERS.length} core users (admin password: ${ADMIN_PASSWORD}, others: ${DEMO_PASSWORD}):`);
  for (const u of CORE_USERS) {
    // eslint-disable-next-line no-console
    console.log(`  ${u.email} - ${u.name} (${u.position}, ${u.role})`);
  }
}

// Name pools so bulk-generated Agency/Advertiser/Brand names read as real names
// rather than "Thing 1, Thing 2, ..." - codes stay systematic (needed as stable
// unique keys), only the display `name` is drawn from these pools.
const AGENCY_NAMES = [
  'Zenith Media Indonesia', 'Mindshare Indonesia', 'Starcom Worldwide Indonesia', 'Carat Indonesia',
  'Initiative Media Indonesia', 'PHD Indonesia', 'Wavemaker Indonesia', 'UM Indonesia',
  'Havas Media Indonesia', 'Dentsu Indonesia',
];
const ADVERTISER_PREFIXES = ['Sinar', 'Nusantara', 'Cemerlang', 'Abadi', 'Mandiri', 'Sejahtera', 'Utama', 'Bahagia', 'Sentosa', 'Kencana'];
const ADVERTISER_SUFFIXES = ['Group', 'Corpora', 'Industri', 'Perkasa', 'Sejati', 'Mulia', 'Bersaudara', 'Internasional', 'Persada', 'Utama Jaya'];
const BRAND_WORDS_A = [
  'Sinar', 'Nusantara', 'Prima', 'Cemerlang', 'Abadi', 'Mandiri', 'Sejahtera', 'Utama', 'Bahagia', 'Sentosa',
  'Melati', 'Kencana', 'Permata', 'Zamrud', 'Cahaya', 'Harum', 'Jaya', 'Makmur', 'Bintang', 'Garuda',
];
const BRAND_WORDS_B = ['Emas', 'Perak', 'Berlian', 'Mutiara', 'Intan', 'Nirwana', 'Surya', 'Bumi', 'Langit', 'Samudra'];
const BRAND_WORDS_C = ['Prima', 'Plus', 'Gold', 'Fresh', 'Elite', 'Utama'];

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
