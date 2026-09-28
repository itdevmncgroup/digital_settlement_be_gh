import 'dotenv/config';
import { ApprovalScopeType, DocumentStage, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { RoleName } from '../src/common/constants/role-name';

const prisma = new PrismaClient();

// Renames a Unit's code/name in place if the old code still exists (keeps every FK
// that points at it intact), otherwise upserts the new code fresh. Lets us correct
// the demo Unit codes on an already-seeded DB without a destructive wipe.
async function renameUnitCode(oldCode: string, newCode: string, newName: string, revenueSharePercent?: number) {
  if (oldCode !== newCode) {
    const existing = await prisma.unit.findUnique({ where: { code: oldCode } });
    if (existing) {
      return prisma.unit.update({ where: { id: existing.id }, data: { code: newCode, name: newName, revenueSharePercent } });
    }
  }
  return prisma.unit.upsert({
    where: { code: newCode },
    update: { revenueSharePercent },
    create: { code: newCode, name: newName, revenueSharePercent },
  });
}

async function main() {
  // Roles (BRD section 5)
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Custom role (not backed by RoleName/any @Roles guard - see role-name.ts's
  // comment) - just a Role master-data row an Admin can assign permissions to
  // via System > Permission, same as one created by hand through the Role page.
  await prisma.role.upsert({
    where: { name: 'HEAD DEPARTMENT' },
    update: {},
    create: { name: 'HEAD DEPARTMENT' },
  });

  // Fine-grained overrides on top of RolesGuard's role checks - each code below is
  // read by name in a service/controller (see RequirePermission call sites), so
  // System > Permission (BRD section 26) has real rows an Admin can assign to a Role.
  const permissionCodes = [
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
    'expense.create.all',
    'expense.create.owndept',
    'approval.read.all',
    'approval.read.owndept',
    'settlement.read.owndept',
    'settlement.read.all',
    'settlement.create.owndept',
    'dashboard.read.own',
    'dashboard-sales.read.own',
    'dashboard.read.all',
    'dashboard.read.owndept',
    'audit-report.read.all',
    'audit-report.read.owndept',
    'master.manage',
    'user.manage',
    'report.export',
  ];
  for (const code of permissionCodes) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }

  // Position master data (approver basis for Approval Level chains, BRD section
  // 22-23) - the org-chart job titles behind the Expense chain (HEAD_POD -> CO-CSO,
  // see CLAUDE.md) and the Settlement chain (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV ->
  // CO_CFO_3TV), plus SLS/SLSADM front-line titles. DEPT_HEAD was removed - unused
  // by any live ApprovalLevel now that the coverage-Department demo data is gone.
  const positionDefs = [
    { code: 'SLS', name: 'Sales' },
    { code: 'HEAD_POD', name: 'Head POD' },
    { code: 'CO-CSO', name: 'Co-Chief Sales Officer (Ads) MNC Media' },
    { code: 'SLSADM', name: 'Sales Admin' },
    { code: 'SLS_MAR_DIR', name: 'Sales & Marketing Director (Ads) MNC Media' },
    { code: 'VP_ACC_BIL_TAX_3TV', name: 'VP Accounting, Billing & Tax 3TV' },
    { code: 'CO_CFO_3TV', name: 'Co-Chief Finance Officer 3FTA' },
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
  await renameUnitCode('JKT', 'RCTI', 'RCTI', 48);
  await renameUnitCode('SBY', 'MNCTV', 'MNCTV', 43);
  await prisma.unit.upsert({
    where: { code: 'GTV' },
    update: { revenueSharePercent: 14 },
    create: { code: 'GTV', name: 'GTV', revenueSharePercent: 14 },
  });

  const activityNames = ['Karangan Bunga', 'Sumbangan', 'Parcel/Bingkisan', 'Souvenir', 'Ucapan Simpati', 'Makanan/Kue'];
  for (const name of activityNames) {
    await prisma.activityType.upsert({ where: { name }, update: {}, create: { name } });
  }

  await seedMasterData();
  await seedPodDepartments();
  await seedCoreUsers();
}

// Agency -> Advertiser -> Brand master data (strict ownership chain - an Advertiser
// belongs to exactly one Agency, a Brand to exactly one Advertiser), Cost Centers,
// Expense Categories, Payment Methods, and the Settlement Approval Level
// (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV, BRD section 22-23). Fully
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

  // Approval Level master data (BRD section 22-23 example):
  //   Settlement (any Department): SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV
  // Only ever one SETTLEMENT Level: resolveApprovalLevel() breaks a tie between
  // two same-scope, same-amount-range Levels by updatedAt, so seeding a second
  // one would let a re-run silently take over the chain an Admin configured.
  const existingSettlementLevel = await prisma.approvalLevel.findFirst({ where: { documentStage: DocumentStage.SETTLEMENT } });
  if (!existingSettlementLevel) {
    const positions = Object.fromEntries((await prisma.position.findMany()).map((p) => [p.code, p]));
    await prisma.approvalLevel.create({
      data: {
        name: 'Settlement - Standard',
        documentStage: DocumentStage.SETTLEMENT,
        scopeType: ApprovalScopeType.ANY,
        minAmount: 0,
        steps: {
          create: ['SLS_MAR_DIR', 'VP_ACC_BIL_TAX_3TV', 'CO_CFO_3TV'].map((code, i) => ({ stepOrder: i, positionId: positions[code].id })),
        },
      },
    });
  }
}

// Department (coverage-group, BRD section 6.2) master data: POD 1..POD 7, plus a
// large Agency/Advertiser/Brand stress dataset (10 agencies x 10 advertisers x 10
// brands) so master-data pickers have real volume to page/search through. The
// bulk Agency/Advertiser/Brand generation is guarded on the AGY01 agency code so
// re-running seed is a no-op there; the 7 Departments upsert unconditionally
// (skipDuplicates) so they self-correct independent of that guard.
async function seedPodDepartments() {
  const deptDefs = Array.from({ length: 7 }, (_, i) => ({ name: `POD ${i + 1}` }));
  await prisma.department.createMany({ data: deptDefs, skipDuplicates: true });

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

// The app's core test roster (BRD Expense/Settlement approval chain walkthrough):
// 1 Admin, 1 Sales (POD 1), Head POD 1, 2x Co-Chief Sales Officer, and the 3
// Settlement-chain approvers (Sales & Marketing Director, VP Accounting Billing &
// Tax, Co-Chief Finance Officer). Idempotent - re-running self-corrects
// employeeId/name/positionId on an existing row rather than duplicating it.
async function seedCoreUsers() {
  const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo@12345';
  const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const demoPasswordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.name, r]));
  const positions = Object.fromEntries((await prisma.position.findMany()).map((p) => [p.code, p]));
  const pod1 = await prisma.department.findUniqueOrThrow({ where: { name: 'POD 1' } });

  async function upsertUser(input: {
    employeeId: string;
    name: string;
    email: string;
    passwordHash: string;
    roleName?: string;
    positionCode?: string;
  }) {
    const positionId = input.positionCode ? positions[input.positionCode].id : undefined;
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      return prisma.user.update({
        where: { id: existing.id },
        data: { employeeId: input.employeeId, name: input.name, positionId },
      });
    }
    return prisma.user.create({
      data: {
        employeeId: input.employeeId,
        name: input.name,
        email: input.email,
        positionId,
        passwordHash: input.passwordHash,
        roles: input.roleName ? { create: [{ roleId: roles[input.roleName].id }] } : undefined,
      },
    });
  }

  await upsertUser({
    employeeId: '0000000001', name: 'System Administrator', email: 'admin@dev.local',
    passwordHash: adminPasswordHash, roleName: RoleName.ADMIN,
  });

  const salesPod1 = await upsertUser({
    employeeId: '2601010001', name: 'Sales POD 1 - 01', email: 'sales.pod1.1@dev.local',
    passwordHash: demoPasswordHash, roleName: RoleName.SALES, positionCode: 'SLS',
  });
  await prisma.userDepartment.upsert({
    where: { userId_departmentId: { userId: salesPod1.id, departmentId: pod1.id } },
    update: {},
    create: { userId: salesPod1.id, departmentId: pod1.id },
  });

  const headPod1 = await upsertUser({
    employeeId: '2601010002', name: 'Head POD 1', email: 'head.pod1@dev.local',
    passwordHash: demoPasswordHash, positionCode: 'HEAD_POD',
  });
  // Head POD 1 is scoped specifically to POD 1's DepartmentPositionAssignment
  // (rather than left as an unassigned/ANY-scope holder), same pattern as the
  // old "Dept Head" demo approver this replaces.
  const existingHeadAssignment = await prisma.departmentPositionAssignment.findUnique({
    where: { departmentId_positionId: { departmentId: pod1.id, positionId: positions.HEAD_POD.id } },
  });
  if (!existingHeadAssignment) {
    await prisma.departmentPositionAssignment.create({
      data: { departmentId: pod1.id, positionId: positions.HEAD_POD.id, userId: headPod1.id },
    });
  } else if (existingHeadAssignment.userId !== headPod1.id) {
    await prisma.departmentPositionAssignment.update({ where: { id: existingHeadAssignment.id }, data: { userId: headPod1.id } });
  }

  // Co-Chief Sales Officer: 2 holders, company-wide (no Department scope) -
  // ApprovalScopeType.ANY resolves to whichever holds the lowest employeeId.
  await upsertUser({
    employeeId: '2601010003', name: 'Dendy Alfajri Wijaya', email: 'co.cso.1@dev.local',
    passwordHash: demoPasswordHash, positionCode: 'CO-CSO',
  });
  await upsertUser({
    employeeId: '2601010004', name: 'Pandhu Wiguna', email: 'co.cso.2@dev.local',
    passwordHash: demoPasswordHash, positionCode: 'CO-CSO',
  });

  // Settlement chain (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV), all
  // ApprovalScopeType.ANY / company-wide, same as seedMasterData's Approval Level.
  await upsertUser({
    employeeId: '2601010005', name: 'Kanti Mirdiati', email: 'sales.bod@dev.local',
    passwordHash: demoPasswordHash, positionCode: 'SLS_MAR_DIR',
  });
  await upsertUser({
    employeeId: '2601010006', name: 'Veronika Lawy', email: 'vp@dev.local',
    passwordHash: demoPasswordHash, positionCode: 'VP_ACC_BIL_TAX_3TV',
  });
  await upsertUser({
    employeeId: '2601010007', name: 'Jarod Suwahjo', email: 'co.cfo@dev.local',
    passwordHash: demoPasswordHash, positionCode: 'CO_CFO_3TV',
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded core users (admin password: ${ADMIN_PASSWORD}, others: ${DEMO_PASSWORD}):`);
  // eslint-disable-next-line no-console
  console.log('  admin@dev.local - System Administrator (Administrator role)');
  // eslint-disable-next-line no-console
  console.log('  sales.pod1.1@dev.local - Sales POD 1 - 01 (Sales, POD 1)');
  // eslint-disable-next-line no-console
  console.log('  head.pod1@dev.local - Head POD 1 (Head POD, POD 1)');
  // eslint-disable-next-line no-console
  console.log('  co.cso.1@dev.local / co.cso.2@dev.local - Dendy Alfajri Wijaya / Pandhu Wiguna (Co-Chief Sales Officer)');
  // eslint-disable-next-line no-console
  console.log('  sales.bod@dev.local - Kanti Mirdiati (Sales & Marketing Director)');
  // eslint-disable-next-line no-console
  console.log('  vp@dev.local - Veronika Lawy (VP Accounting, Billing & Tax)');
  // eslint-disable-next-line no-console
  console.log('  co.cfo@dev.local - Jarod Suwahjo (Co-Chief Finance Officer)');
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
