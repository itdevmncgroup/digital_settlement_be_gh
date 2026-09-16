// Seeds a realistic dataset spanning every Audit Report Dashboard finding type
// (MISSING_RECEIPT, UNMATCHED_TRANSACTION, OVERDUE_SETTLEMENT, DUPLICATE_CLAIM,
// POLICY_EXCEPTION) plus a majority of "clean" compliant expenses, spread
// across several PODs and the last ~5 months - so every widget on
// /dashboard/audit-report (KPI tiles, findings-by-type, risk donut, trend,
// compliance/exposure-by-POD, document completeness, settlement aging,
// director attention, priority findings table) has real, non-zero data.
//
// Reuses master data (Departments/Advertisers/Brands/ActivityTypes/CostCenters/
// PaymentMethods/ExpenseCategories/Users) already created by `npm run seed` -
// run that first if this is a brand new DB.
//
// Re-runnable: deletes only its own previously-seeded rows (expenseNo/
// settlementNo prefixed EXP-AUD-DEMO-/STL-AUD-DEMO-) before recreating them,
// and clears AuditFinding (harmless - AuditReportService resyncs that table
// from source data on the very next /audit-report/* request).
//
// Usage: node scripts/seed-audit-report-demo.js
const { PrismaClient, ExpenseStatus, SettlementStatus, MatchingStatus } = require('@prisma/client');

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
  const mealCategory = await must(prisma.expenseCategory.findUnique({ where: { code: 'MEAL' } }), 'ExpenseCategory MEAL');
  const giftCategory = await must(prisma.expenseCategory.findUnique({ where: { code: 'GIFT' } }), 'ExpenseCategory GIFT');

  // Policy ceiling for the POLICY_EXCEPTION finding type - Rp 1,000,000 per
  // Client Gift line item (Admin can change this later via Master > Expense Category).
  await prisma.expenseCategory.update({ where: { id: giftCategory.id }, data: { policyLimit: 1_000_000 } });

  const membersByDept = new Map();
  for (const dept of departments) {
    const members = await prisma.user.findMany({
      where: { departments: { some: { departmentId: dept.id, status: 'ACTIVE' } }, unitId: { not: null } },
      take: 5,
    });
    if (members.length > 0) membersByDept.set(dept.id, members);
  }
  const activeDepartments = departments.filter((d) => membersByDept.has(d.id)).slice(0, 10);
  if (activeDepartments.length < 3) throw new Error('Not enough PODs with active members - run `npm run seed` first.');
  console.log(`  Using ${activeDepartments.length} PODs: ${activeDepartments.map((d) => d.name).join(', ')}`);

  const merchantNames = ['Sushi Tei', 'Starbucks Coffee', 'The Ritz Carlton', 'Hotel Mulia', 'Din Tai Fung', 'Plaza Senayan Cafe', 'Grand Hyatt', 'Kopi Kenangan'];

  console.log('Deleting previous audit-report demo data...');
  await prisma.auditFinding.deleteMany({});
  await prisma.expense.deleteMany({ where: { expenseNo: { startsWith: 'EXP-AUD-DEMO-' } } });
  await prisma.settlement.deleteMany({ where: { settlementNo: { startsWith: 'STL-AUD-DEMO-' } } });

  let seq = 0;
  function nextExpenseNo() {
    seq += 1;
    return `EXP-AUD-DEMO-${String(seq).padStart(4, '0')}`;
  }

  function randomPick(dept) {
    const sales = pick(membersByDept.get(dept.id));
    const advertiser = pick(advertisersWithBrand);
    const brand = pick(brandsByAdvertiser.get(advertiser.id));
    const activityType = pick(activityTypes);
    const costCenter = pick(costCenters);
    const paymentMethod = pick(paymentMethods);
    const merchantName = pick(merchantNames);
    return { sales, advertiser, brand, activityType, costCenter, paymentMethod, merchantName };
  }

  async function createExpense({ dept, days, amount, status, isMatched = true, withReceipt = true, categoryId, merchantNameOverride, expenseDateOverride }) {
    const { sales, advertiser, brand, activityType, costCenter, paymentMethod, merchantName } = randomPick(dept);
    const expenseDate = expenseDateOverride ?? daysAgo(days);
    const expenseNo = nextExpenseNo();
    const finalMerchantName = merchantNameOverride ?? merchantName;
    const invoices = withReceipt
      ? {
          create: [
            {
              invoiceNumber: `INV-${expenseNo}`,
              invoiceDate: expenseDate,
              finalMerchantName,
              finalSubtotal: Math.round(amount * 0.9),
              finalTax: Math.round(amount * 0.1),
              finalTotal: amount,
              matchingStatus: MatchingStatus.MANUAL_MATCHED,
              modifiedById: sales.id,
              modifiedAt: new Date(),
              files: {
                create: [
                  { fileType: 'ORIGINAL', storageKey: `demo/${expenseNo}.jpg`, fileName: `${expenseNo}.jpg`, mimeType: 'image/jpeg', size: 102_400, checksum: `demo-${expenseNo}` },
                ],
              },
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
        merchantName: finalMerchantName,
        expenseDate,
        purpose: `${activityType.name} - ${finalMerchantName}`,
        amount,
        status,
        isMatched,
        items: { create: [{ description: finalMerchantName, amount, categoryId: categoryId ?? mealCategory.id }] },
        invoices,
      },
    });
  }

  console.log('Seeding compliant expenses...');
  const monthsSpread = [150, 120, 95, 70, 45, 25, 12, 5];
  let compliant = 0;
  for (const dept of activeDepartments) {
    for (const days of monthsSpread) {
      const amount = 200_000 + Math.floor(Math.random() * 2_500_000);
      await createExpense({ dept, days, amount, status: ExpenseStatus.COMPLETE, isMatched: true, withReceipt: true });
      compliant += 1;
    }
  }
  console.log(`  ${compliant} compliant expenses created.`);

  console.log('Seeding MISSING_RECEIPT candidates...');
  for (let i = 0; i < 14; i++) {
    const dept = pick(activeDepartments);
    const amount = i % 3 === 0 ? 12_000_000 : i % 3 === 1 ? 3_500_000 : 800_000;
    await createExpense({ dept, days: 5 + i * 4, amount, status: ExpenseStatus.SUBMITTED, isMatched: false, withReceipt: false });
  }

  console.log('Seeding UNMATCHED_TRANSACTION candidates...');
  for (let i = 0; i < 10; i++) {
    const dept = pick(activeDepartments);
    const days = i % 2 === 0 ? 45 : 20; // half > 30d (HIGH risk), half > 14d (MEDIUM risk)
    await createExpense({ dept, days, amount: 500_000 + i * 150_000, status: ExpenseStatus.READY_TO_MATCHING, isMatched: false, withReceipt: true });
  }

  console.log('Seeding DUPLICATE_CLAIM candidates...');
  for (let i = 0; i < 4; i++) {
    const dept = pick(activeDepartments);
    const dupDate = daysAgo(15 + i * 5);
    const amount = 1_000_000 + i * 300_000;
    const merchantName = pick(merchantNames);
    await createExpense({ dept, amount, status: ExpenseStatus.SUBMITTED, isMatched: false, withReceipt: true, expenseDateOverride: dupDate, merchantNameOverride: merchantName });
    await createExpense({ dept, amount, status: ExpenseStatus.SUBMITTED, isMatched: false, withReceipt: true, expenseDateOverride: dupDate, merchantNameOverride: merchantName });
  }

  console.log('Seeding POLICY_EXCEPTION candidates...');
  for (let i = 0; i < 8; i++) {
    const dept = pick(activeDepartments);
    const amount = i % 2 === 0 ? 2_600_000 : 1_400_000; // > 150% and > 100% of the Rp1,000,000 Gift limit
    await createExpense({ dept, days: 8 + i * 6, amount, status: ExpenseStatus.SUBMITTED, isMatched: true, withReceipt: true, categoryId: giftCategory.id });
  }

  console.log('Seeding Settlements (Settlement Aging / Overdue Settlement)...');
  async function createSettlement(dept, days, status, expenseCount) {
    const expenses = [];
    for (let i = 0; i < expenseCount; i++) {
      const amount = 400_000 + i * 250_000;
      expenses.push(await createExpense({ dept, days: days + i, amount, status: ExpenseStatus.READY_TO_SETTLED, isMatched: true, withReceipt: true }));
    }
    const totalAmount = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    seq += 1;
    const settlementNo = `STL-AUD-DEMO-${String(seq).padStart(4, '0')}`;
    const createdBy = pick(membersByDept.get(dept.id));
    const createdAt = daysAgo(days);
    const settlement = await prisma.settlement.create({
      data: {
        settlementNo,
        departmentId: dept.id,
        totalAmount,
        status,
        createdById: createdBy.id,
        createdAt,
        externalSyncedAt: status === SettlementStatus.COMPLETE ? daysAgo(Math.max(days - 2, 0)) : null,
      },
    });
    await prisma.expense.updateMany({
      where: { id: { in: expenses.map((e) => e.id) } },
      data: { settlementId: settlement.id, status: status === SettlementStatus.COMPLETE ? ExpenseStatus.COMPLETE : ExpenseStatus.READY_TO_SETTLED },
    });
    console.log(`  ${settlementNo} (${status}, ${days}d old) - ${expenseCount} expense(s), Rp ${totalAmount.toLocaleString('id-ID')}`);
    return settlement;
  }

  for (const dept of activeDepartments.slice(0, 3)) {
    await createSettlement(dept, 100, SettlementStatus.COMPLETE, 3);
    await createSettlement(dept, 60, SettlementStatus.COMPLETE, 2);
  }
  await createSettlement(activeDepartments[0], 3, SettlementStatus.DRAFT, 2); // 0-7 days - not overdue
  await createSettlement(activeDepartments[1 % activeDepartments.length], 10, SettlementStatus.APPROVAL_SLS_MAR_DIR, 2); // 8-14 days - not overdue yet
  await createSettlement(activeDepartments[2 % activeDepartments.length], 22, SettlementStatus.APPROVAL_VP_ACC_BIL_TAX_3TV, 2); // 15-30 days - MEDIUM overdue
  await createSettlement(activeDepartments[0], 45, SettlementStatus.APPROVAL_SLS_MAR_DIR, 2); // > 30 days - HIGH overdue

  console.log('\nDone. Open /dashboard/audit-report (logged in as ADMIN/FINANCE/MANAGEMENT) to see the populated dashboard.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
