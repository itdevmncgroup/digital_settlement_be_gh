// Seeds a realistic dataset for the three read-only reporting dashboards that
// share the Expense/Settlement/ApprovalAction tables:
//   - Expense Dashboard          (/expense-dashboard)
//   - Settlement Dashboard       (/dashboard/settlement)
//   - Expense Analytics Dashboard (/dashboard/expense-analytics)
// (Executive Dashboard at /dashboard/executive is still an unbuilt stub with
// no API calls - nothing to seed for it.)
//
// Covers the full ExpenseStatus/SettlementStatus spectrum (draft through
// rejected/revision through fully settled) spread across several PODs,
// agencies/advertisers/categories and the last ~6 months, plus real
// ApprovalRequest/ApprovalRequestStep/ApprovalAction rows for the Settlement
// chain (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV) so the Settlement
// Dashboard's "Approval Progress" and "Processing Time by POD" widgets - the
// only two that read anything beyond a plain Expense/Settlement groupBy - have
// real numbers too.
//
// Reuses master data (Departments/Advertisers/Brands/ActivityTypes/CostCenters/
// PaymentMethods/ExpenseCategories/Users/the "Settlement - All" ApprovalLevel)
// already created by `npm run seed` - run that first if this is a brand new DB.
// Independent of scripts/seed-audit-report-demo.js (different expenseNo/
// settlementNo prefix) - both can be run together.
//
// Re-runnable: deletes only its own previously-seeded rows (expenseNo/
// settlementNo prefixed EXP-DASH-DEMO-/STL-DASH-DEMO-) before recreating them.
//
// Usage: node scripts/seed-dashboards-demo.js
const { PrismaClient, ExpenseStatus, SettlementStatus, MatchingStatus, ApprovalStatus, ApprovalStepStatus, DocumentStage } = require('@prisma/client');

const prisma = new PrismaClient();

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function must(promise, label) {
  const result = await promise;
  if (!result) throw new Error(`Required seed data missing: ${label} - run \`npm run seed\` first.`);
  return result;
}

async function main() {
  console.log('Loading master data...');
  const departments = await prisma.department.findMany();
  const advertisers = await prisma.advertiser.findMany();
  const brands = await prisma.brand.findMany({ where: { advertiserId: { in: advertisers.map((a) => a.id) } } });
  const brandsByAdvertiser = new Map();
  for (const b of brands) {
    const list = brandsByAdvertiser.get(b.advertiserId) ?? [];
    list.push(b);
    brandsByAdvertiser.set(b.advertiserId, list);
  }
  const advertisersWithBrand = advertisers.filter((a) => (brandsByAdvertiser.get(a.id) ?? []).length > 0);
  if (advertisersWithBrand.length === 0) throw new Error('No Advertiser with a Brand found - run `npm run seed` first.');

  const activityTypes = await prisma.activityType.findMany();
  const costCenters = await prisma.costCenter.findMany();
  const paymentMethods = await prisma.paymentMethod.findMany();
  const categories = await prisma.expenseCategory.findMany();

  const membersByDept = new Map();
  for (const dept of departments) {
    const members = await prisma.user.findMany({
      where: { departments: { some: { departmentId: dept.id, status: 'ACTIVE' } }, unitId: { not: null } },
      take: 5,
    });
    if (members.length > 0) membersByDept.set(dept.id, members);
  }
  const activeDepartments = departments.filter((d) => membersByDept.has(d.id)).slice(0, 8);
  if (activeDepartments.length < 3) throw new Error('Not enough PODs with active members - run `npm run seed` first.');
  console.log(`  Using ${activeDepartments.length} PODs: ${activeDepartments.map((d) => d.name).join(', ')}`);

  // "Settlement - All" (scope ANY) is the only Settlement-stage chain that
  // applies regardless of Department - see prisma/schema.prisma's
  // ApprovalScopeType.ANY comment. Its 3 tiers each resolve, in the real app,
  // to whichever User directly holds that Position (no per-Department
  // DepartmentPositionAssignment exists for VP_ACC_BIL_TAX_3TV/CO_CFO_3TV).
  const settlementLevel = await must(
    prisma.approvalLevel.findFirst({ where: { name: 'Settlement - All' }, include: { steps: { include: { position: true }, orderBy: { stepOrder: 'asc' } } } }),
    'ApprovalLevel "Settlement - All"',
  );
  const tierApprovers = {};
  for (const step of settlementLevel.steps) {
    tierApprovers[step.position.code] = await must(prisma.user.findFirst({ where: { position: { code: step.position.code } } }), `a User holding Position ${step.position.code}`);
  }
  const TIER_CODES = settlementLevel.steps.map((s) => s.position.code); // [SLS_MAR_DIR, VP_ACC_BIL_TAX_3TV, CO_CFO_3TV]

  const merchantNames = ['Sushi Tei', 'Starbucks Coffee', 'The Ritz Carlton', 'Hotel Mulia', 'Din Tai Fung', 'Plaza Senayan Cafe', 'Grand Hyatt', 'Kopi Kenangan'];

  console.log('Deleting previous dashboard demo data...');
  await prisma.approvalAction.deleteMany({ where: { approvalRequest: { settlement: { settlementNo: { startsWith: 'STL-DASH-DEMO-' } } } } });
  await prisma.approvalRequestStep.deleteMany({ where: { approvalRequest: { settlement: { settlementNo: { startsWith: 'STL-DASH-DEMO-' } } } } });
  await prisma.approvalRequest.deleteMany({ where: { settlement: { settlementNo: { startsWith: 'STL-DASH-DEMO-' } } } });
  await prisma.auditFinding.deleteMany({ where: { OR: [{ expense: { expenseNo: { startsWith: 'EXP-DASH-DEMO-' } } }, { settlement: { settlementNo: { startsWith: 'STL-DASH-DEMO-' } } }] } });
  await prisma.expense.deleteMany({ where: { expenseNo: { startsWith: 'EXP-DASH-DEMO-' } } });
  await prisma.settlement.deleteMany({ where: { settlementNo: { startsWith: 'STL-DASH-DEMO-' } } });

  let expSeq = 0;
  function nextExpenseNo() {
    expSeq += 1;
    return `EXP-DASH-DEMO-${String(expSeq).padStart(4, '0')}`;
  }
  let stlSeq = 0;
  function nextSettlementNo() {
    stlSeq += 1;
    return `STL-DASH-DEMO-${String(stlSeq).padStart(4, '0')}`;
  }

  function randomPick(dept) {
    const sales = pick(membersByDept.get(dept.id));
    const advertiser = pick(advertisersWithBrand);
    const brand = pick(brandsByAdvertiser.get(advertiser.id));
    const activityType = pick(activityTypes);
    const costCenter = pick(costCenters);
    const paymentMethod = pick(paymentMethods);
    const category = pick(categories);
    const merchantName = pick(merchantNames);
    return { sales, advertiser, brand, activityType, costCenter, paymentMethod, category, merchantName };
  }

  async function createExpense({ dept, days, amount, status, isMatched = false, withReceipt = true }) {
    const { sales, advertiser, brand, activityType, costCenter, paymentMethod, category, merchantName } = randomPick(dept);
    const expenseDate = daysAgo(days);
    const expenseNo = nextExpenseNo();
    const invoices = withReceipt
      ? {
          create: [
            {
              invoiceNumber: `INV-${expenseNo}`,
              invoiceDate: expenseDate,
              finalMerchantName: merchantName,
              finalSubtotal: Math.round(amount * 0.9),
              finalTax: Math.round(amount * 0.1),
              finalTotal: amount,
              matchingStatus: MatchingStatus.MANUAL_MATCHED,
              modifiedById: sales.id,
              modifiedAt: new Date(),
              files: { create: [{ fileType: 'ORIGINAL', storageKey: `demo/${expenseNo}.jpg`, fileName: `${expenseNo}.jpg`, mimeType: 'image/jpeg', size: 102_400, checksum: `demo-${expenseNo}` }] },
            },
          ],
        }
      : undefined;

    return prisma.expense.create({
      data: {
        expenseNo,
        salesId: sales.id,
        unitId: sales.unitId,
        departmentId: dept.id,
        advertiserId: advertiser.id,
        brandId: brand.id,
        activityTypeId: activityType.id,
        costCenterId: costCenter?.id,
        paymentMethodId: paymentMethod?.id,
        merchantName,
        expenseDate,
        purpose: `${activityType.name} - ${merchantName}`,
        amount,
        status,
        isMatched,
        items: { create: [{ description: merchantName, amount, categoryId: category?.id }] },
        invoices,
      },
    });
  }

  function randomAmount(min, max) {
    return min + Math.floor(Math.random() * (max - min));
  }

  // --- Part A: Expenses across the full status spectrum, spread over ~6 months ---
  // (Expense Dashboard's status donut / pending-approval / rejected stats and
  // Expense Analytics' category/agency/advertiser breakdowns all read straight
  // off Expense.status/expenseDate - no ApprovalRequest needed for these.)
  const nonTerminalStatusDefs = [
    { status: ExpenseStatus.DRAFT, count: 10 },
    { status: ExpenseStatus.SUBMITTED, count: 8 },
    { status: ExpenseStatus.PENDING_APPROVAL, count: 6 },
    { status: ExpenseStatus.APPROVAL_HEAD_POD, count: 6 },
    { status: ExpenseStatus.APPROVAL_KOORDINATOR, count: 4 },
    { status: ExpenseStatus.APPROVAL_SUPERVISOR, count: 4 },
    { status: ExpenseStatus.APPROVAL_DEPT_HEAD, count: 3 },
    { status: ExpenseStatus.APPROVAL_DIV_HEAD, count: 3 },
    { status: ExpenseStatus.APPROVAL_BOD, count: 3 },
    { status: ExpenseStatus.APPROVAL_CO_CSO_1, count: 4 },
    { status: ExpenseStatus.APPROVAL_CO_CSO_2, count: 4 },
    { status: ExpenseStatus.REJECTED, count: 8 },
    { status: ExpenseStatus.REVISION, count: 5 },
  ];

  console.log('Seeding Expenses across every status...');
  let created = 0;
  for (const def of nonTerminalStatusDefs) {
    for (let i = 0; i < def.count; i++) {
      const dept = pick(activeDepartments);
      const days = randomAmount(2, 175);
      const amount = randomAmount(150_000, 3_000_000);
      await createExpense({ dept, days, amount, status: def.status, isMatched: false, withReceipt: Math.random() > 0.3 });
      created += 1;
    }
  }

  // Standalone completed expenses not part of any Settlement below - keeps the
  // "Total Expenses" / "Completed" counts from being 100% tied to Settlements.
  for (let i = 0; i < 20; i++) {
    const dept = pick(activeDepartments);
    await createExpense({ dept, days: randomAmount(2, 175), amount: randomAmount(200_000, 2_500_000), status: ExpenseStatus.COMPLETE, isMatched: true, withReceipt: true });
    created += 1;
  }
  console.log(`  ${created} expenses created (draft through rejected/revision, plus 20 standalone completed).`);

  // --- Part B: Settlements across the full status spectrum, with a real
  // Settlement-chain ApprovalRequest/Step/Action trail so "Approval Progress"
  // and "Processing Time by POD" have real numbers. ---
  console.log('Seeding Settlements across every status...');

  async function buildSettlementExpenses(dept, days, count, matchedStatus) {
    const expenses = [];
    for (let i = 0; i < count; i++) {
      expenses.push(await createExpense({ dept, days: days + i, amount: randomAmount(300_000, 2_000_000), status: matchedStatus, isMatched: true, withReceipt: true }));
    }
    return expenses;
  }

  // targetTier: null = DRAFT (not yet submitted), 0/1/2 = currently waiting at
  // that tier, 'complete' = all 3 tiers approved, 'rejected' = rejected at a
  // random tier.
  async function createSettlementWithChain(dept, days, targetTier) {
    const expenseCount = randomAmount(2, 5);
    const expenses = await buildSettlementExpenses(dept, days + 3, expenseCount, ExpenseStatus.READY_TO_SETTLED);
    const totalAmount = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const createdBy = pick(membersByDept.get(dept.id));
    const createdAt = daysAgo(days);

    let status;
    let expenseStatus;
    if (targetTier === null) {
      status = SettlementStatus.DRAFT;
      expenseStatus = ExpenseStatus.READY_TO_SETTLED;
    } else if (targetTier === 'complete') {
      status = SettlementStatus.COMPLETE;
      expenseStatus = ExpenseStatus.COMPLETE;
    } else if (targetTier === 'rejected') {
      status = SettlementStatus.REJECTED;
      expenseStatus = ExpenseStatus.REJECTED;
    } else {
      status = SettlementStatus[`APPROVAL_${TIER_CODES[targetTier]}`];
      expenseStatus = ExpenseStatus[`APPROVAL_${TIER_CODES[targetTier]}`];
    }

    const settlementNo = nextSettlementNo();
    const processingDays = randomAmount(3, 14);
    const settlement = await prisma.settlement.create({
      data: {
        settlementNo,
        departmentId: dept.id,
        totalAmount,
        status,
        createdById: createdBy.id,
        createdAt,
        externalSyncedAt: targetTier === 'complete' ? daysAgo(Math.max(days - processingDays, 0)) : null,
      },
    });
    await prisma.expense.updateMany({ where: { id: { in: expenses.map((e) => e.id) } }, data: { settlementId: settlement.id, status: expenseStatus } });

    if (targetTier !== null) {
      const rejectAtTier = targetTier === 'rejected' ? randomAmount(0, TIER_CODES.length - 1) : null;
      const currentStep = targetTier === 'complete' ? TIER_CODES.length : targetTier === 'rejected' ? rejectAtTier : targetTier;

      const approvalRequest = await prisma.approvalRequest.create({
        data: {
          documentStage: DocumentStage.SETTLEMENT,
          settlementId: settlement.id,
          approvalLevelId: settlementLevel.id,
          currentStep,
          status: targetTier === 'rejected' ? ApprovalStatus.REJECTED : targetTier === 'complete' ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING,
        },
      });

      for (let stepOrder = 0; stepOrder < TIER_CODES.length; stepOrder++) {
        const positionCode = TIER_CODES[stepOrder];
        const approver = tierApprovers[positionCode];
        let stepStatus;
        if (targetTier === 'rejected' && stepOrder === rejectAtTier) stepStatus = ApprovalStepStatus.REJECTED;
        else if (stepOrder < currentStep) stepStatus = ApprovalStepStatus.APPROVED;
        else stepStatus = ApprovalStepStatus.PENDING;

        await prisma.approvalRequestStep.create({
          data: { approvalRequestId: approvalRequest.id, stepOrder, positionId: approver.positionId, resolvedApproverId: approver.id, status: stepStatus },
        });

        if (stepStatus === ApprovalStepStatus.APPROVED) {
          await prisma.approvalAction.create({
            data: { approvalRequestId: approvalRequest.id, actorId: approver.id, positionId: approver.positionId, action: 'APPROVE', actedAt: daysAgo(days - stepOrder * 2) },
          });
        } else if (stepStatus === ApprovalStepStatus.REJECTED) {
          await prisma.approvalAction.create({
            data: {
              approvalRequestId: approvalRequest.id,
              actorId: approver.id,
              positionId: approver.positionId,
              action: 'REJECT',
              reason: 'Bukti pendukung tidak lengkap / melebihi anggaran hiburan client',
              actedAt: daysAgo(days - stepOrder * 2),
            },
          });
        }
      }
    }

    console.log(`  ${settlementNo} (${status}, ${days}d old) - ${expenseCount} expense(s), Rp ${totalAmount.toLocaleString('id-ID')}`);
    return settlement;
  }

  const monthsSpread = [160, 130, 100, 70, 45, 20];
  let si = 0;
  for (const days of monthsSpread) {
    await createSettlementWithChain(activeDepartments[si % activeDepartments.length], days, 'complete');
    si += 1;
  }
  for (let i = 0; i < 3; i++) await createSettlementWithChain(pick(activeDepartments), randomAmount(5, 12), null); // DRAFT
  for (let i = 0; i < 3; i++) await createSettlementWithChain(pick(activeDepartments), randomAmount(5, 12), 0); // waiting at SLS_MAR_DIR
  for (let i = 0; i < 3; i++) await createSettlementWithChain(pick(activeDepartments), randomAmount(10, 20), 1); // waiting at VP_ACC_BIL_TAX_3TV
  for (let i = 0; i < 2; i++) await createSettlementWithChain(pick(activeDepartments), randomAmount(15, 25), 2); // waiting at CO_CFO_3TV
  for (let i = 0; i < 2; i++) await createSettlementWithChain(pick(activeDepartments), randomAmount(15, 40), 'rejected');

  console.log('\nDone. Open /expense-dashboard, /dashboard/settlement and /dashboard/expense-analytics (logged in as ADMIN/FINANCE/MANAGEMENT) to see them populated.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
