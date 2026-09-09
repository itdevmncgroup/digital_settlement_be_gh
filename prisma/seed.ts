import 'dotenv/config';
import {
  ApprovalActionType,
  ApprovalScopeType,
  ApprovalStatus,
  ApprovalStepStatus,
  DocumentStage,
  EventStatus,
  ExpenseStatus,
  MatchingStatus,
  PrismaClient,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { RoleName } from '../src/common/constants/role-name';

const prisma = new PrismaClient();

// Renames a Unit's code/name in place if the old code still exists (keeps every FK
// that points at it intact), otherwise upserts the new code fresh. Lets us correct
// the demo Unit codes on an already-seeded DB without a destructive wipe.
async function renameUnitCode(oldCode: string, newCode: string, newName: string) {
  if (oldCode !== newCode) {
    const existing = await prisma.unit.findUnique({ where: { code: oldCode } });
    if (existing) {
      return prisma.unit.update({ where: { id: existing.id }, data: { code: newCode, name: newName } });
    }
  }
  return prisma.unit.upsert({ where: { code: newCode }, update: {}, create: { code: newCode, name: newName } });
}

async function main() {
  // Roles (BRD section 5)
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Fine-grained overrides on top of RolesGuard's role checks - each code below is
  // read by name in a service/controller (see RequirePermission call sites), so
  // System > Permission (BRD section 26) has real rows an Admin can assign to a Role.
  const permissionCodes = [
    'expense.read.owndept',
    'expense.edit.all',
    'expense.edit.owndept',
    'expense.approve.all',
    'expense.approve.owndept',
    'expense.automatch',
    'expense.create.all',
    'expense.create.owndept',
    'approval.read.all',
    'approval.read.owndept',
    'settlement.read.owndept',
    'settlement.read.all',
    'settlement.create.owndept',
    'dashboard.read.all',
    'dashboard.read.owndept',
    'master.manage',
    'user.manage',
    'report.export',
  ];
  for (const code of permissionCodes) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }

  // Position master data (approver basis for Approval Level chains, BRD section 22-23).
  const positionDefs = [
    { code: 'HEAD_POD', name: 'Head POD' },
    { code: 'KOORDINATOR', name: 'Koordinator' },
    { code: 'SUPERVISOR', name: 'Supervisor' },
    { code: 'DEPT_HEAD', name: 'Department Head' },
    { code: 'DIV_HEAD', name: 'Division Head' },
    { code: 'BOD', name: 'BOD' },
  ];
  for (const p of positionDefs) {
    await prisma.position.upsert({ where: { code: p.code }, update: { name: p.name }, create: p });
  }

  // Department master data.
  await prisma.department.upsert({
    where: { code: 'SALES_MKT' },
    update: {},
    create: { code: 'SALES_MKT', name: 'Sales & Marketing' },
  });

  // Units: MNC Group structure - Holding + the TV network Units Sales are assigned to
  // (BRD section 6.2 example: "Sales: Budi, Unit: RCTI"). renameUnitCode migrates an
  // already-seeded DB's old 'HO'/'JKT'/'SBY' codes in place rather than wiping data.
  const unitHolding = await renameUnitCode('HO', 'HOLDING', 'Holding');
  const unitRcti = await renameUnitCode('JKT', 'RCTI', 'RCTI');
  const unitMnctv = await renameUnitCode('SBY', 'MNCTV', 'MNCTV');
  const unitGtv = await prisma.unit.upsert({ where: { code: 'GTV' }, update: {}, create: { code: 'GTV', name: 'GTV' } });

  const activityNames = ['Lunch', 'Dinner', 'Coffee Meeting', 'Restaurant', 'Golf', 'Cinema', 'Recreation', 'Client Meeting', 'Other'];
  for (const name of activityNames) {
    await prisma.activityType.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Bootstrap Admin user
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.create({
      data: {
        employeeId: 'ADM-0001',
        name: 'System Administrator',
        email: adminEmail,
        unitId: unitHolding.id,
        passwordHash,
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded admin user: ${adminEmail} / ${adminPassword}`);
  }

  await seedDemoData(unitHolding.id, unitRcti.id, unitMnctv.id);
  await seedBulkPodDemo(unitRcti.id, unitMnctv.id, unitGtv.id);
}

// Realistic demo dataset: units/agencies/advertisers/brands/merchants, a Sales/Supervisor/Finance/
// Management user each, POD assignments, and Pre-Event + Expense records walking
// through every status (DRAFT/SUBMITTED/PENDING_APPROVAL/APPROVED/REJECTED/SETTLED)
// so the dashboard, approvals inbox, and reports all have something to show.
// Guarded on a marker user so re-running `npm run seed` doesn't duplicate it.
async function seedDemoData(unitHoldingId: string, unitRctiId: string, unitMnctvId: string) {
  // Transactional demo content (events/expenses/approvals/audit log) is only ever
  // created once, guarded on this marker. Master data (agencies/advertisers/brands/pods/users)
  // stays idempotent below so schema-driven fixes (e.g. Unit codes, POD shape) can
  // still self-correct on a re-run without duplicating or wiping transactional data.
  const alreadySeeded = !!(await prisma.user.findUnique({ where: { email: 'budi.santoso@example.com' } }));

  const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo@12345';
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // Agency -> Advertiser -> Brand (strict ownership chain, business rule clarified:
  // Agency and Advertiser are distinct; an Advertiser belongs to exactly one Agency,
  // a Brand belongs to exactly one Advertiser - never shared).
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
  const brands = Object.fromEntries(
    await Promise.all(
      brandDefs.map(async (b) => [
        b.code,
        await prisma.brand.upsert({
          where: { code: b.code },
          update: {},
          create: { code: b.code, name: b.name, advertiserId: advertisers[b.advertiserCode].id },
        }),
      ]),
    ),
  );

  const [ccSales, ccOps] = await Promise.all([
    prisma.costCenter.upsert({ where: { code: 'CC-SALES' }, update: {}, create: { code: 'CC-SALES', name: 'Sales & Marketing' } }),
    prisma.costCenter.upsert({ where: { code: 'CC-OPS' }, update: {}, create: { code: 'CC-OPS', name: 'Operations' } }),
  ]);
  void ccOps;

  await Promise.all(
    [
      { code: 'MEAL', name: 'Meals & Entertainment' },
      { code: 'TRANSPORT', name: 'Transportation' },
      { code: 'GIFT', name: 'Client Gift' },
      { code: 'OTHER', name: 'Other' },
    ].map((c) => prisma.expenseCategory.upsert({ where: { code: c.code }, update: {}, create: c })),
  );

  async function findOrCreateMerchant(name: string, alias: string[]) {
    const normalizedName = name.toUpperCase();
    const existing = await prisma.merchant.findFirst({ where: { normalizedName } });
    return existing ?? prisma.merchant.create({ data: { name, normalizedName, alias } });
  }

  const [sushiTei, starbucks] = await Promise.all([
    findOrCreateMerchant('Sushi Tei', ['SUSHITEI']),
    findOrCreateMerchant('Starbucks Coffee', ['STARBUCKS']),
    findOrCreateMerchant('Din Tai Fung', ['DTF']),
  ]);

  const roles = Object.fromEntries(
    (await prisma.role.findMany()).map((r) => [r.name, r]),
  ) as unknown as Record<RoleName, { id: string }>;

  async function createUser(input: {
    employeeId: string;
    name: string;
    email: string;
    unitId: string;
    role: RoleName;
    positionId?: string;
    departmentId?: string;
  }) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      if (input.positionId || input.departmentId) {
        return prisma.user.update({
          where: { id: existing.id },
          data: { positionId: input.positionId, departmentId: input.departmentId },
        });
      }
      return existing;
    }
    return prisma.user.create({
      data: {
        employeeId: input.employeeId,
        name: input.name,
        email: input.email,
        unitId: input.unitId,
        positionId: input.positionId,
        departmentId: input.departmentId,
        passwordHash,
        roles: { create: [{ roleId: roles[input.role].id }] },
      },
    });
  }

  const positions = Object.fromEntries((await prisma.position.findMany()).map((p) => [p.code, p]));
  const deptSalesMkt = await prisma.department.findUniqueOrThrow({ where: { code: 'SALES_MKT' } });

  const budi = await createUser({ employeeId: 'SLS-0001', name: 'Budi Santoso', email: 'budi.santoso@example.com', unitId: unitRctiId, role: RoleName.SALES });
  const siti = await createUser({ employeeId: 'SLS-0002', name: 'Siti Rahma', email: 'siti.rahma@example.com', unitId: unitMnctvId, role: RoleName.SALES });
  const andi = await createUser({
    employeeId: 'SPV-0001', name: 'Andi Wijaya', email: 'andi.wijaya@example.com', unitId: unitRctiId, role: RoleName.SUPERVISOR,
    positionId: positions.SUPERVISOR.id, departmentId: deptSalesMkt.id,
  });
  const rina = await createUser({ employeeId: 'FIN-0001', name: 'Rina Kartika', email: 'rina.kartika@example.com', unitId: unitHoldingId, role: RoleName.FINANCE });
  const bambang = await createUser({
    employeeId: 'MGT-0001', name: 'Bambang Hartono', email: 'bambang.hartono@example.com', unitId: unitHoldingId, role: RoleName.MANAGEMENT,
    positionId: positions.DIV_HEAD.id, departmentId: deptSalesMkt.id,
  });
  // Approval-chain-only Position holders (BRD section 22 example): Head POD/Koordinator
  // for the two demo PODs below, plus Department Head/BOD for the Settlement chain.
  const yusuf = await createUser({
    employeeId: 'POS-0001', name: 'Yusuf Pratama', email: 'yusuf.pratama@example.com', unitId: unitRctiId, role: RoleName.SUPERVISOR,
    positionId: positions.HEAD_POD.id, departmentId: deptSalesMkt.id,
  });
  const dewi = await createUser({
    employeeId: 'POS-0002', name: 'Dewi Anggraini', email: 'dewi.anggraini@example.com', unitId: unitMnctvId, role: RoleName.SUPERVISOR,
    positionId: positions.KOORDINATOR.id, departmentId: deptSalesMkt.id,
  });
  const hendra = await createUser({
    employeeId: 'POS-0003', name: 'Hendra Gunawan', email: 'hendra.gunawan@example.com', unitId: unitHoldingId, role: RoleName.MANAGEMENT,
    positionId: positions.DEPT_HEAD.id, departmentId: deptSalesMkt.id,
  });
  const diana = await createUser({
    employeeId: 'POS-0004', name: 'Diana Puspita', email: 'diana.puspita@example.com', unitId: unitHoldingId, role: RoleName.MANAGEMENT,
    positionId: positions.BOD.id, departmentId: deptSalesMkt.id,
  });

  const effectiveDate = new Date('2026-01-01');
  if (!alreadySeeded) {
    await prisma.salesAssignment.createMany({
      data: [
        { salesId: budi.id, unitId: unitRctiId, effectiveDate },
        { salesId: siti.id, unitId: unitMnctvId, effectiveDate },
      ],
    });
  }

  // Department (coverage-group flavor) = a named coverage group covering one
  // or more Sales (via User.departmentId), containing Agency<->Brand pairs
  // (BRD section 6.2, formerly the separate "Pod" concept). find-or-create by
  // name so re-running seed doesn't duplicate rows; the given salesId's own
  // departmentId is (re)pointed at it if not already (idempotent).
  async function findOrCreateCoverageDepartment(input: {
    name: string;
    salesId: string;
    assignments: { agencyId: string; brandId: string }[];
  }) {
    const existing = await prisma.department.findUnique({ where: { name: input.name } });
    const department =
      existing ??
      (await prisma.department.create({
        data: {
          name: input.name,
          assignments: { create: input.assignments.map((a) => ({ ...a, effectiveDate })) },
        },
      }));
    const sales = await prisma.user.findUniqueOrThrow({ where: { id: input.salesId } });
    if (sales.departmentId !== department.id) {
      await prisma.user.update({ where: { id: input.salesId }, data: { departmentId: department.id } });
    }
    return department;
  }

  const deptBudi = await findOrCreateCoverageDepartment({
    name: 'RCTI - Budi Coverage',
    salesId: budi.id,
    assignments: [
      { agencyId: agencies.GRPM.id, brandId: brands.PEPSODENT.id },
      { agencyId: agencies.OMD.id, brandId: brands.INDOMIE.id },
    ],
  });
  const deptSiti = await findOrCreateCoverageDepartment({
    name: 'MNCTV - Siti Coverage',
    salesId: siti.id,
    assignments: [
      { agencyId: agencies.GRPM.id, brandId: brands.MILO.id },
      { agencyId: agencies.OMD.id, brandId: brands.KOPIKO.id },
    ],
  });

  // Department-scoped approvers (who holds "Head POD"/"Koordinator"/"Supervisor"/
  // "Department Head" for these specific coverage Departments) - idempotent,
  // always self-corrected on re-run like the Departments above.
  async function findOrCreateDepartmentApprover(departmentId: string, positionCode: string, userId: string) {
    const positionId = positions[positionCode].id;
    const existing = await prisma.departmentPositionAssignment.findUnique({ where: { departmentId_positionId: { departmentId, positionId } } });
    if (existing) return existing.userId === userId ? existing : prisma.departmentPositionAssignment.update({ where: { id: existing.id }, data: { userId } });
    return prisma.departmentPositionAssignment.create({ data: { departmentId, positionId, userId } });
  }
  await findOrCreateDepartmentApprover(deptBudi.id, 'HEAD_POD', yusuf.id);
  await findOrCreateDepartmentApprover(deptBudi.id, 'SUPERVISOR', andi.id);
  await findOrCreateDepartmentApprover(deptSiti.id, 'KOORDINATOR', dewi.id);
  await findOrCreateDepartmentApprover(deptSiti.id, 'SUPERVISOR', andi.id);
  await findOrCreateDepartmentApprover(deptSiti.id, 'DEPT_HEAD', hendra.id);

  // Approval Level master data (BRD section 22-23 example):
  //   Pre-Event, Sales Department 1 (Budi): Head POD -> Supervisor
  //   Pre-Event, Sales Department 2 (Siti): Koordinator -> Supervisor -> Department Head
  //   Settlement (any Department): Department Head -> Division Head -> BOD
  async function findOrCreateApprovalLevel(input: {
    name: string;
    documentStage: DocumentStage;
    scopeType: ApprovalScopeType;
    departmentId?: string;
    stepPositionCodes: string[];
  }) {
    const existing = await prisma.approvalLevel.findFirst({ where: { name: input.name } });
    if (existing) return existing;
    return prisma.approvalLevel.create({
      data: {
        name: input.name,
        documentStage: input.documentStage,
        scopeType: input.scopeType,
        departmentId: input.departmentId,
        minAmount: 0,
        steps: {
          create: input.stepPositionCodes.map((code, i) => ({ stepOrder: i, positionId: positions[code].id })),
        },
      },
    });
  }
  const preEventPod1Level = await findOrCreateApprovalLevel({
    name: 'Pre-Event - POD 1 (Budi)', documentStage: DocumentStage.PRE_EVENT, scopeType: ApprovalScopeType.DEPARTMENT,
    departmentId: deptBudi.id, stepPositionCodes: ['HEAD_POD', 'SUPERVISOR'],
  });
  await findOrCreateApprovalLevel({
    name: 'Pre-Event - POD 2 (Siti)', documentStage: DocumentStage.PRE_EVENT, scopeType: ApprovalScopeType.DEPARTMENT,
    departmentId: deptSiti.id, stepPositionCodes: ['KOORDINATOR', 'SUPERVISOR', 'DEPT_HEAD'],
  });
  const settlementLevel = await findOrCreateApprovalLevel({
    name: 'Settlement - Standard', documentStage: DocumentStage.SETTLEMENT, scopeType: ApprovalScopeType.ANY,
    stepPositionCodes: ['DEPT_HEAD', 'DIV_HEAD', 'BOD'],
  });

  if (alreadySeeded) {
    // eslint-disable-next-line no-console
    console.log('Demo events/expenses already seeded, skipping (Units/Agencies/Advertisers/Brands/PODs/Approval Levels still self-corrected above).');
    return;
  }

  const activityTypes = Object.fromEntries((await prisma.activityType.findMany()).map((a) => [a.name, a]));

  // --- Pre-Event requests, one of each status ---
  const evDraft = await prisma.event.create({
    data: {
      eventNo: 'EVT-DEMO-0001', salesId: budi.id, unitId: unitRctiId, departmentId: deptBudi.id,
      advertiserId: advertisers.UNVR.id, brandId: brands.PEPSODENT.id,
      activityTypeId: activityTypes['Lunch'].id, date: new Date('2026-08-25'), purpose: 'Discuss Q3 campaign', estimatedAmount: 600_000,
      status: EventStatus.DRAFT,
    },
  });
  // SUBMITTED, awaiting Pre-Event POD 1 chain step 0 (Head POD = Yusuf).
  const evSubmitted = await prisma.event.create({
    data: {
      eventNo: 'EVT-DEMO-0002', salesId: budi.id, unitId: unitRctiId, departmentId: deptBudi.id,
      advertiserId: advertisers.UNVR.id, brandId: brands.LIFEBUOY.id,
      activityTypeId: activityTypes['Client Meeting'].id, date: new Date('2026-08-28'), purpose: 'Review distribution plan', estimatedAmount: 750_000,
      status: EventStatus.SUBMITTED,
    },
  });
  await prisma.approvalRequest.create({
    data: {
      documentStage: DocumentStage.PRE_EVENT, eventId: evSubmitted.id, approvalLevelId: preEventPod1Level.id,
      currentStep: 0, status: ApprovalStatus.PENDING,
      steps: {
        create: [
          { stepOrder: 0, positionId: positions.HEAD_POD.id, resolvedApproverId: yusuf.id, status: ApprovalStepStatus.PENDING },
          { stepOrder: 1, positionId: positions.SUPERVISOR.id, resolvedApproverId: andi.id, status: ApprovalStepStatus.PENDING },
        ],
      },
    },
  });
  const evApproved1 = await prisma.event.create({
    data: {
      eventNo: 'EVT-DEMO-0003', salesId: budi.id, unitId: unitRctiId, departmentId: deptBudi.id,
      advertiserId: advertisers.UNVR.id, brandId: brands.PEPSODENT.id,
      activityTypeId: activityTypes['Dinner'].id, date: new Date('2026-08-15'), purpose: 'Entertain marketing team', estimatedAmount: 900_000,
      status: EventStatus.APPROVED,
    },
  });
  const evApproved2 = await prisma.event.create({
    data: {
      eventNo: 'EVT-DEMO-0004', salesId: siti.id, unitId: unitMnctvId, departmentId: deptSiti.id,
      advertiserId: advertisers.NESTLE.id, brandId: brands.MILO.id,
      activityTypeId: activityTypes['Coffee Meeting'].id, date: new Date('2026-08-18'), purpose: 'Discuss new SKU launch', estimatedAmount: 2_500_000,
      status: EventStatus.APPROVED,
    },
  });
  const evRejected = await prisma.event.create({
    data: {
      eventNo: 'EVT-DEMO-0005', salesId: siti.id, unitId: unitMnctvId, departmentId: deptSiti.id,
      advertiserId: advertisers.MYOR.id, brandId: brands.KOPIKO.id,
      activityTypeId: activityTypes['Golf'].id, date: new Date('2026-08-10'), purpose: 'Client relationship building', estimatedAmount: 3_000_000,
      status: EventStatus.REJECTED, rejectReason: 'Golf entertainment exceeds this quarter\'s recreation budget for the client',
    },
  });
  void evDraft;
  void evRejected;

  // --- Expenses walking through every status, tied to the approved events above.
  // Settlement chain (BRD section 22-23 example) is the same 3-step Department Head ->
  // Division Head -> BOD for every Expense regardless of amount/POD (scopeType ANY). ---

  // A: PENDING_APPROVAL, still waiting on step 0 (Department Head = Hendra).
  const expA = await prisma.expense.create({
    data: {
      expenseNo: 'EXP-DEMO-0001', salesId: budi.id, unitId: unitRctiId, departmentId: deptBudi.id,
      advertiserId: advertisers.UNVR.id, brandId: brands.PEPSODENT.id, eventId: evApproved1.id, activityTypeId: activityTypes['Dinner'].id,
      costCenterId: ccSales.id, expenseDate: new Date('2026-08-15'), purpose: 'Dinner with Unilever marketing team',
      amount: 850_000, status: ExpenseStatus.PENDING_APPROVAL,
      invoices: {
        create: [{
          invoiceNumber: 'INV-2026-08-1102', invoiceDate: new Date('2026-08-15'), merchantId: sushiTei.id,
          finalMerchantName: sushiTei.name, finalSubtotal: 780_000, finalTax: 70_000, finalTotal: 850_000,
          matchingStatus: MatchingStatus.MANUAL_MATCHED, modifiedById: budi.id, modifiedAt: new Date(),
        }],
      },
    },
  });
  await prisma.approvalRequest.create({
    data: {
      documentStage: DocumentStage.SETTLEMENT, expenseId: expA.id, approvalLevelId: settlementLevel.id,
      currentStep: 0, status: ApprovalStatus.PENDING,
      steps: {
        create: [
          { stepOrder: 0, positionId: positions.DEPT_HEAD.id, resolvedApproverId: hendra.id, status: ApprovalStepStatus.PENDING },
          { stepOrder: 1, positionId: positions.DIV_HEAD.id, resolvedApproverId: bambang.id, status: ApprovalStepStatus.PENDING },
          { stepOrder: 2, positionId: positions.BOD.id, resolvedApproverId: diana.id, status: ApprovalStepStatus.PENDING },
        ],
      },
    },
  });

  // B: fully APPROVED, all 3 Settlement steps done.
  const expB = await prisma.expense.create({
    data: {
      expenseNo: 'EXP-DEMO-0002', salesId: siti.id, unitId: unitMnctvId, departmentId: deptSiti.id,
      advertiserId: advertisers.NESTLE.id, brandId: brands.MILO.id, eventId: evApproved2.id, activityTypeId: activityTypes['Coffee Meeting'].id,
      costCenterId: ccSales.id, expenseDate: new Date('2026-08-18'), purpose: 'Coffee meeting to discuss new SKU launch',
      amount: 2_450_000, status: ExpenseStatus.APPROVED,
      items: { create: [{ description: 'Venue rental', amount: 1_500_000 }, { description: 'Catering', amount: 950_000 }] },
      invoices: {
        create: [{
          invoiceNumber: 'INV-2026-08-3391', invoiceDate: new Date('2026-08-18'), merchantId: starbucks.id,
          finalMerchantName: starbucks.name, finalSubtotal: 2_250_000, finalTax: 200_000, finalTotal: 2_450_000,
          matchingStatus: MatchingStatus.MANUAL_MATCHED, modifiedById: siti.id, modifiedAt: new Date(),
        }],
      },
    },
  });
  const arB = await prisma.approvalRequest.create({
    data: {
      documentStage: DocumentStage.SETTLEMENT, expenseId: expB.id, approvalLevelId: settlementLevel.id,
      currentStep: 3, status: ApprovalStatus.APPROVED,
      steps: {
        create: [
          { stepOrder: 0, positionId: positions.DEPT_HEAD.id, resolvedApproverId: hendra.id, status: ApprovalStepStatus.APPROVED },
          { stepOrder: 1, positionId: positions.DIV_HEAD.id, resolvedApproverId: bambang.id, status: ApprovalStepStatus.APPROVED },
          { stepOrder: 2, positionId: positions.BOD.id, resolvedApproverId: diana.id, status: ApprovalStepStatus.APPROVED },
        ],
      },
    },
  });
  await prisma.approvalAction.createMany({
    data: [
      { approvalRequestId: arB.id, actorId: hendra.id, positionId: positions.DEPT_HEAD.id, action: ApprovalActionType.APPROVE },
      { approvalRequestId: arB.id, actorId: bambang.id, positionId: positions.DIV_HEAD.id, action: ApprovalActionType.APPROVE },
      { approvalRequestId: arB.id, actorId: diana.id, positionId: positions.BOD.id, action: ApprovalActionType.APPROVE },
    ],
  });

  // C: DRAFT, not submitted yet - no invoice.
  await prisma.expense.create({
    data: {
      expenseNo: 'EXP-DEMO-0003', salesId: siti.id, unitId: unitMnctvId, departmentId: deptSiti.id,
      advertiserId: advertisers.NESTLE.id, brandId: brands.MILO.id, eventId: evApproved2.id, activityTypeId: activityTypes['Coffee Meeting'].id,
      costCenterId: ccSales.id, expenseDate: new Date('2026-08-20'), purpose: 'Follow-up coffee with client', amount: 300_000, status: ExpenseStatus.DRAFT,
    },
  });

  // D: REJECTED at step 0 (Department Head).
  const expD = await prisma.expense.create({
    data: {
      expenseNo: 'EXP-DEMO-0004', salesId: budi.id, unitId: unitRctiId, departmentId: deptBudi.id,
      advertiserId: advertisers.UNVR.id, brandId: brands.PEPSODENT.id, eventId: evApproved1.id, activityTypeId: activityTypes['Dinner'].id,
      costCenterId: ccSales.id, expenseDate: new Date('2026-08-16'), purpose: 'Additional client dinner',
      amount: 1_200_000, status: ExpenseStatus.REJECTED,
      invoices: {
        create: [{
          invoiceNumber: 'INV-2026-08-1103', invoiceDate: new Date('2026-08-16'), finalMerchantName: 'Unknown Restaurant',
          finalTotal: 1_200_000, matchingStatus: MatchingStatus.UNMATCHED, modifiedById: budi.id, modifiedAt: new Date(),
        }],
      },
    },
  });
  const arD = await prisma.approvalRequest.create({
    data: {
      documentStage: DocumentStage.SETTLEMENT, expenseId: expD.id, approvalLevelId: settlementLevel.id,
      currentStep: 0, status: ApprovalStatus.REJECTED,
      steps: {
        create: [
          { stepOrder: 0, positionId: positions.DEPT_HEAD.id, resolvedApproverId: hendra.id, status: ApprovalStepStatus.REJECTED },
          { stepOrder: 1, positionId: positions.DIV_HEAD.id, resolvedApproverId: bambang.id, status: ApprovalStepStatus.PENDING },
          { stepOrder: 2, positionId: positions.BOD.id, resolvedApproverId: diana.id, status: ApprovalStepStatus.PENDING },
        ],
      },
    },
  });
  await prisma.approvalAction.create({
    data: {
      approvalRequestId: arD.id, actorId: hendra.id, positionId: positions.DEPT_HEAD.id, action: ApprovalActionType.REJECT,
      reason: 'Duplicate invoice with an existing entertainment record for the same date',
    },
  });

  // E: SETTLED - fully approved (all 3 Settlement steps) and closed out by Finance.
  const expE = await prisma.expense.create({
    data: {
      expenseNo: 'EXP-DEMO-0005', salesId: siti.id, unitId: unitMnctvId, departmentId: deptSiti.id,
      advertiserId: advertisers.NESTLE.id, brandId: brands.MILO.id, eventId: evApproved2.id, activityTypeId: activityTypes['Coffee Meeting'].id,
      costCenterId: ccSales.id, expenseDate: new Date('2026-08-05'), purpose: 'Initial product briefing over coffee',
      amount: 500_000, status: ExpenseStatus.SETTLED,
      invoices: {
        create: [{
          invoiceNumber: 'INV-2026-08-0901', invoiceDate: new Date('2026-08-05'), merchantId: starbucks.id,
          finalMerchantName: starbucks.name, finalSubtotal: 460_000, finalTax: 40_000, finalTotal: 500_000,
          matchingStatus: MatchingStatus.MANUAL_MATCHED, modifiedById: siti.id, modifiedAt: new Date(),
        }],
      },
    },
  });
  const arE = await prisma.approvalRequest.create({
    data: {
      documentStage: DocumentStage.SETTLEMENT, expenseId: expE.id, approvalLevelId: settlementLevel.id,
      currentStep: 3, status: ApprovalStatus.APPROVED,
      steps: {
        create: [
          { stepOrder: 0, positionId: positions.DEPT_HEAD.id, resolvedApproverId: hendra.id, status: ApprovalStepStatus.APPROVED },
          { stepOrder: 1, positionId: positions.DIV_HEAD.id, resolvedApproverId: bambang.id, status: ApprovalStepStatus.APPROVED },
          { stepOrder: 2, positionId: positions.BOD.id, resolvedApproverId: diana.id, status: ApprovalStepStatus.APPROVED },
        ],
      },
    },
  });
  await prisma.approvalAction.createMany({
    data: [
      { approvalRequestId: arE.id, actorId: hendra.id, positionId: positions.DEPT_HEAD.id, action: ApprovalActionType.APPROVE },
      { approvalRequestId: arE.id, actorId: bambang.id, positionId: positions.DIV_HEAD.id, action: ApprovalActionType.APPROVE },
      { approvalRequestId: arE.id, actorId: diana.id, positionId: positions.BOD.id, action: ApprovalActionType.APPROVE },
    ],
  });

  await prisma.auditLog.createMany({
    data: [
      { userId: hendra.id, action: 'APPROVE', objectType: 'Expense', objectId: expB.id, newValue: { note: 'seed demo data' } },
      { userId: bambang.id, action: 'APPROVE', objectType: 'Expense', objectId: expB.id, newValue: { note: 'seed demo data' } },
      { userId: diana.id, action: 'APPROVE', objectType: 'Expense', objectId: expB.id, newValue: { note: 'seed demo data' } },
      { userId: hendra.id, action: 'REJECT', objectType: 'Expense', objectId: expD.id, newValue: { reason: 'Duplicate invoice' } },
      { userId: hendra.id, action: 'APPROVE', objectType: 'Expense', objectId: expE.id, newValue: { note: 'seed demo data' } },
      { userId: rina.id, action: 'UPDATE', objectType: 'Expense', objectId: expE.id, newValue: { status: 'SETTLED' } },
    ],
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded demo users (password: ${DEMO_PASSWORD}):`);
  // eslint-disable-next-line no-console
  console.log('  Sales:      budi.santoso@example.com, siti.rahma@example.com');
  // eslint-disable-next-line no-console
  console.log('  Supervisor: andi.wijaya@example.com');
  // eslint-disable-next-line no-console
  console.log('  Finance:    rina.kartika@example.com');
  // eslint-disable-next-line no-console
  console.log('  Management: bambang.hartono@example.com');
  // eslint-disable-next-line no-console
  console.log('  Approval-chain positions: yusuf.pratama@example.com (Head POD), dewi.anggraini@example.com (Koordinator),');
  // eslint-disable-next-line no-console
  console.log('    hendra.gunawan@example.com (Dept Head), diana.puspita@example.com (BOD), andi.wijaya@example.com (Supervisor), bambang.hartono@example.com (Division Head)');
}

// Name pools so bulk-generated Sales/Agency/Advertiser/Brand names read as real
// names rather than "Thing 1, Thing 2, ..." - codes stay systematic (needed as
// stable unique keys), only the display `name` is drawn from these pools.
const SALES_FIRST_NAMES = ['Agus', 'Dedi', 'Eka', 'Fajar', 'Gita', 'Hana', 'Indra', 'Kartika', 'Lukman', 'Maya'];
const SALES_LAST_NAMES = ['Saputra', 'Wardhani', 'Pratama', 'Lestari', 'Nugroho', 'Handayani', 'Setiawan', 'Wibowo', 'Ramadhan', 'Purnama'];
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

// Large-scale Department/master-data stress dataset, separate from the
// curated seedDemoData() walkthrough above: 10 Agencies, each with 10
// Advertisers (100 total), each with 10 Brands (1000 total); 50 Sales users
// split 5-per-Department across 10 Departments named "POD 1".."POD 10" (each
// Sales' own User.departmentId points at their Department - formerly a
// separate "Pod"/PodMember concept). Guarded on the AGY01 agency code so
// re-running seed is a no-op.
async function seedBulkPodDemo(unitRctiId: string, unitMnctvId: string, unitGtvId: string) {
  const alreadySeeded = !!(await prisma.agency.findUnique({ where: { code: 'AGY01' } }));
  if (alreadySeeded) {
    // eslint-disable-next-line no-console
    console.log('Bulk POD demo dataset already seeded, skipping.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Seeding bulk POD demo dataset (10 agencies x 10 advertisers x 10 brands, 10 PODs x 5 sales)...');

  // --- 10 Agencies ---
  const agencyData = Array.from({ length: 10 }, (_, i) => ({
    code: `AGY${String(i + 1).padStart(2, '0')}`,
    name: AGENCY_NAMES[i],
  }));
  await prisma.agency.createMany({ data: agencyData });
  const agencies = await prisma.agency.findMany({
    where: { code: { in: agencyData.map((a) => a.code) } },
    orderBy: { code: 'asc' },
  });

  // --- 100 Advertisers (10 per Agency) - all 10x10 prefix/suffix combos, one per Advertiser ---
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

  // --- 1000 Brands (10 per Advertiser) - 3-word names via mixed-radix index over
  // 20x10x6=1200 combos (>1000, so all 1000 are guaranteed unique, no counting suffix). ---
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
  const brands = await prisma.brand.findMany({
    where: { code: { in: brandData.map((b) => b.code) } },
    orderBy: { code: 'asc' },
  });

  const advertisersByAgencyId = new Map<string, typeof advertisers>();
  for (const a of advertisers) {
    advertisersByAgencyId.set(a.agencyId, [...(advertisersByAgencyId.get(a.agencyId) ?? []), a]);
  }
  const brandsByAdvertiserId = new Map<string, typeof brands>();
  for (const b of brands) {
    brandsByAdvertiserId.set(b.advertiserId, [...(brandsByAdvertiserId.get(b.advertiserId) ?? []), b]);
  }

  // --- 10 Departments ("POD 1".."POD 10"), created up front so each Sales'
  // own User.departmentId can point straight at theirs. ---
  const deptDefs = Array.from({ length: 10 }, (_, i) => ({ name: `POD ${i + 1}` }));
  await prisma.department.createMany({ data: deptDefs, skipDuplicates: true });
  const departments = await prisma.department.findMany({ where: { name: { in: deptDefs.map((d) => d.name) } } });
  const departmentByName = new Map(departments.map((d) => [d.name, d]));

  // --- 50 Sales users (5 per Department x 10 Departments), split across
  // RCTI/MNCTV/GTV - first x last name pools (10x10=100 combos) give 50
  // unique real-looking names. ---
  const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo@12345';
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const salesRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.SALES } });
  const units = [unitRctiId, unitMnctvId, unitGtvId];
  const effectiveDate = new Date('2026-01-01');

  const salesUsersData = Array.from({ length: 50 }, (_, i) => {
    const n = i + 1;
    const firstIdx = Math.floor(i / SALES_LAST_NAMES.length) % SALES_FIRST_NAMES.length;
    const lastIdx = i % SALES_LAST_NAMES.length;
    return {
      employeeId: `SLS-2${String(n).padStart(3, '0')}`,
      name: `${SALES_FIRST_NAMES[firstIdx]} ${SALES_LAST_NAMES[lastIdx]}`,
      email: `sales${n}@example.com`,
      unitId: units[i % units.length],
      departmentId: departmentByName.get(`POD ${Math.floor(i / 5) + 1}`)!.id,
      passwordHash,
    };
  });
  await prisma.user.createMany({ data: salesUsersData });
  const salesUsers = await prisma.user.findMany({
    where: { email: { in: salesUsersData.map((s) => s.email) } },
    orderBy: { employeeId: 'asc' },
  });

  await prisma.userRole.createMany({ data: salesUsers.map((u) => ({ userId: u.id, roleId: salesRole.id })) });
  await prisma.salesAssignment.createMany({
    data: salesUsers.map((u) => ({ salesId: u.id, unitId: u.unitId as string, effectiveDate })),
  });

  // Each Sales' original index still deterministically offsets 2 Agency -> Brand
  // pairs, now attached to their Department's single canonical row (deduped by
  // brandId since a Brand can only appear once per Department).
  const assignmentsData: { departmentId: string; agencyId: string; brandId: string; effectiveDate: Date }[] = [];
  const seenBrandsPerDepartment = new Map<string, Set<string>>();
  salesUsers.forEach((u, i) => {
    const department = departmentByName.get(`POD ${Math.floor(i / 5) + 1}`)!;
    const agencyIdxs = [i % agencies.length, (i + 3) % agencies.length];
    const uniqueAgencyIdxs = Array.from(new Set(agencyIdxs));
    const seenBrands = seenBrandsPerDepartment.get(department.id) ?? new Set<string>();
    for (const aIdx of uniqueAgencyIdxs) {
      const agency = agencies[aIdx];
      const advertisersForAgency = advertisersByAgencyId.get(agency.id)!;
      const advertiser = advertisersForAgency[i % advertisersForAgency.length];
      const brandsForAdvertiser = brandsByAdvertiserId.get(advertiser.id)!;
      const brand = brandsForAdvertiser[i % brandsForAdvertiser.length];
      if (seenBrands.has(brand.id)) continue;
      seenBrands.add(brand.id);
      assignmentsData.push({ departmentId: department.id, agencyId: agency.id, brandId: brand.id, effectiveDate });
    }
    seenBrandsPerDepartment.set(department.id, seenBrands);
  });
  await prisma.departmentAssignment.createMany({ data: assignmentsData });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${agencies.length} agencies, ${advertisers.length} advertisers, ${brands.length} brands, ` +
      `${salesUsers.length} sales users across 10 Departments (5 sales each), ${assignmentsData.length} Department assignments.`,
  );
  // eslint-disable-next-line no-console
  console.log(`Bulk demo sales login: sales1@example.com .. sales50@example.com / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
