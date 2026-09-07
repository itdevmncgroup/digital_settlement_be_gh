// Deletes all existing Expense and Settlement rows, then seeds a fresh,
// realistic dummy dataset spanning every Expense status and 2 Settlements -
// so Expenses/Approval/Settlement pages all have something current to show.
// Reuses master data (Units/Agencies/Advertisers/Brands/PODs/Positions/Users)
// already created by `npm run seed` - run that first if this is a brand new DB.
//
// Usage: node scripts/reset-and-seed-expenses.js
const { PrismaClient, ExpenseStatus, ApprovalStatus, ApprovalStepStatus, DocumentStage, ParticipantCategory, MatchingStatus, SettlementStatus } = require('@prisma/client');

const prisma = new PrismaClient();

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function must(promise, label) {
  const result = await promise;
  if (!result) throw new Error(`Required seed data missing: ${label} - run \`npm run seed\` first.`);
  return result;
}

async function generateSettlementNo(prefix) {
  const count = await prisma.settlement.count({ where: { settlementNo: { startsWith: prefix } } });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

async function main() {
  console.log('Deleting existing Settlement and Expense data...');
  const delSettlements = await prisma.settlement.deleteMany({});
  const delExpenses = await prisma.expense.deleteMany({});
  console.log(`  Deleted ${delSettlements.count} settlement(s), ${delExpenses.count} expense(s).`);

  const [budi, siti] = await Promise.all([
    must(prisma.user.findUnique({ where: { email: 'budi.santoso@example.com' } }), 'budi.santoso@example.com'),
    must(prisma.user.findUnique({ where: { email: 'siti.rahma@example.com' } }), 'siti.rahma@example.com'),
  ]);
  const [hendra, bambang, diana] = await Promise.all([
    must(prisma.user.findUnique({ where: { email: 'hendra.gunawan@example.com' } }), 'hendra.gunawan@example.com'),
    must(prisma.user.findUnique({ where: { email: 'bambang.hartono@example.com' } }), 'bambang.hartono@example.com'),
    must(prisma.user.findUnique({ where: { email: 'diana.puspita@example.com' } }), 'diana.puspita@example.com'),
  ]);
  const positions = Object.fromEntries((await prisma.position.findMany()).map((p) => [p.code, p]));
  const deptSalesMkt = await must(prisma.department.findUnique({ where: { code: 'SALES_MKT' } }), 'department SALES_MKT');
  const settlementLevel = await must(
    prisma.approvalLevel.findFirst({ where: { name: 'Settlement - Standard' } }),
    'approval level "Settlement - Standard"',
  );

  const podBudi = await must(prisma.pod.findUnique({ where: { name: 'RCTI - Budi Coverage' } }), 'POD "RCTI - Budi Coverage"');
  const podSiti = await must(prisma.pod.findUnique({ where: { name: 'MNCTV - Siti Coverage' } }), 'POD "MNCTV - Siti Coverage"');

  const agencies = Object.fromEntries((await prisma.agency.findMany({ where: { code: { in: ['GRPM', 'OMD'] } } })).map((a) => [a.code, a]));
  const advertisers = Object.fromEntries(
    (await prisma.advertiser.findMany({ where: { code: { in: ['UNVR', 'NESTLE', 'INDF', 'MYOR'] } } })).map((a) => [a.code, a]),
  );
  const brands = Object.fromEntries(
    (await prisma.brand.findMany({ where: { code: { in: ['PEPSODENT', 'LIFEBUOY', 'MILO', 'INDOMIE', 'KOPIKO', 'BENGBENG'] } } })).map((b) => [b.code, b]),
  );
  const activityTypes = Object.fromEntries((await prisma.activityType.findMany()).map((a) => [a.name, a]));
  const ccSales = await must(prisma.costCenter.findUnique({ where: { code: 'CC-SALES' } }), 'cost center CC-SALES');

  async function findOrCreateMerchant(name, alias) {
    const normalizedName = name.toUpperCase();
    const existing = await prisma.merchant.findFirst({ where: { normalizedName } });
    return existing ?? prisma.merchant.create({ data: { name, normalizedName, alias } });
  }
  const [sushiTei, starbucks, ritzCarlton] = await Promise.all([
    findOrCreateMerchant('Sushi Tei', ['SUSHITEI']),
    findOrCreateMerchant('Starbucks Coffee', ['STARBUCKS']),
    findOrCreateMerchant('The Ritz Carlton', ['RITZ CARLTON']),
  ]);

  // 1 POD = 1 credit card - give each demo POD its own card if it doesn't have one yet.
  async function findOrCreatePodCard(podId, bank, last4, cardHolderName) {
    const existing = await prisma.creditCard.findUnique({ where: { podId } });
    if (existing) return existing;
    return prisma.creditCard.create({ data: { bank, last4, cardHolderName, podId } });
  }
  const cardBudi = await findOrCreatePodCard(podBudi.id, 'BCA', '4113', 'Budi Santoso');
  const cardSiti = await findOrCreatePodCard(podSiti.id, 'Mandiri', '7788', 'Siti Rahma');

  // --- Expense definitions: a realistic spread across every status ---
  const defs = [
    // DRAFT - not submitted, no invoice required yet.
    { no: 1, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'PEPSODENT', activity: 'Lunch', purpose: 'Lunch meeting bahas renewal kontrak Q4', amount: 450_000, days: 2, payment: 'CASH', status: ExpenseStatus.DRAFT },
    { no: 2, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'LIFEBUOY', activity: 'Coffee Meeting', purpose: 'Coffee dengan tim brand Lifebuoy', amount: 220_000, days: 1, payment: 'GOPAY', status: ExpenseStatus.DRAFT },
    { no: 3, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'NESTLE', brand: 'MILO', activity: 'Dinner', purpose: 'Dinner follow-up campaign Milo sekolah', amount: 680_000, days: 3, payment: 'CREDIT_CARD', card: cardSiti, status: ExpenseStatus.DRAFT },
    { no: 4, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'MYOR', brand: 'KOPIKO', activity: 'Client Meeting', purpose: 'Meeting client Kopiko regional', amount: 350_000, days: 1, payment: 'OVO', status: ExpenseStatus.DRAFT },

    // PENDING_APPROVAL - submitted, waiting on Settlement step 0 (Dept Head).
    { no: 5, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'PEPSODENT', activity: 'Dinner', purpose: 'Dinner entertain tim marketing Unilever', amount: 950_000, days: 5, payment: 'CREDIT_CARD', card: cardBudi, status: ExpenseStatus.PENDING_APPROVAL, invoice: { merchant: sushiTei, subtotal: 870_000, tax: 80_000 } },
    { no: 6, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'NESTLE', brand: 'MILO', activity: 'Golf', purpose: 'Golf outing bersama distributor Milo', amount: 3_200_000, days: 6, payment: 'CREDIT_CARD', card: cardSiti, status: ExpenseStatus.PENDING_APPROVAL, invoice: { merchant: ritzCarlton, subtotal: 3_000_000, tax: 200_000 } },
    { no: 7, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'INDF', brand: 'INDOMIE', activity: 'Restaurant', purpose: 'Makan malam launching varian baru', amount: 780_000, days: 4, payment: 'BANK_TRANSFER', status: ExpenseStatus.PENDING_APPROVAL, invoice: { merchant: starbucks, subtotal: 720_000, tax: 60_000 } },

    // REVISION - was REJECTED, resubmit expected.
    { no: 8, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'MYOR', brand: 'BENGBENG', activity: 'Cinema', purpose: 'Nonton bareng client sambil bahas campaign', amount: 500_000, days: 7, payment: 'DANA', status: ExpenseStatus.REVISION, invoice: { merchant: starbucks, subtotal: 460_000, tax: 40_000 } },

    // REJECTED, with a Settlement-stage rejection at step 0.
    { no: 9, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'LIFEBUOY', activity: 'Recreation', purpose: 'Rekreasi tim sales bersama client', amount: 1_500_000, days: 9, payment: 'CREDIT_CARD', card: cardBudi, status: ExpenseStatus.REJECTED, rejectReason: 'Melebihi budget hiburan kuartal ini untuk client tersebut', invoice: { merchant: ritzCarlton, subtotal: 1_400_000, tax: 100_000 } },
    { no: 10, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'INDF', brand: 'INDOMIE', activity: 'Other', purpose: 'Entertainment lain-lain', amount: 300_000, days: 8, payment: 'SHOPEEPAY', status: ExpenseStatus.REJECTED, rejectReason: 'Invoice tidak jelas / duplikat dengan transaksi lain', invoice: { merchant: starbucks, subtotal: 280_000, tax: 20_000 } },
    { no: 11, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'INDF', brand: 'INDOMIE', activity: 'Client Meeting', purpose: 'Meeting client tambahan minggu ini', amount: 400_000, days: 10, payment: 'CASH', status: ExpenseStatus.REJECTED, rejectReason: 'Tidak sesuai dengan POD coverage yang disetujui', invoice: { merchant: sushiTei, subtotal: 370_000, tax: 30_000 } },

    // APPROVED, all 3 Settlement steps done, not yet grouped into a Settlement.
    { no: 12, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'PEPSODENT', activity: 'Dinner', purpose: 'Dinner client review kontrak tahunan', amount: 1_100_000, days: 12, payment: 'CREDIT_CARD', card: cardBudi, status: ExpenseStatus.APPROVED, invoice: { merchant: ritzCarlton, subtotal: 1_000_000, tax: 100_000 } },
    { no: 13, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'NESTLE', brand: 'MILO', activity: 'Coffee Meeting', purpose: 'Coffee meeting kickoff campaign baru', amount: 260_000, days: 13, payment: 'CREDIT_CARD', card: cardSiti, status: ExpenseStatus.APPROVED, invoice: { merchant: starbucks, subtotal: 240_000, tax: 20_000 } },

    // SETTLED, grouped into 2 dummy Settlements below (2 expenses each).
    { no: 14, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'PEPSODENT', activity: 'Lunch', purpose: 'Lunch quarterly business review', amount: 620_000, days: 20, payment: 'CREDIT_CARD', card: cardBudi, status: ExpenseStatus.SETTLED, invoice: { merchant: sushiTei, subtotal: 570_000, tax: 50_000 }, settleGroup: 'budi' },
    { no: 15, sales: budi, pod: podBudi, unitId: budi.unitId, advertiser: 'UNVR', brand: 'LIFEBUOY', activity: 'Dinner', purpose: 'Dinner penutupan deal tahunan', amount: 1_350_000, days: 22, payment: 'CREDIT_CARD', card: cardBudi, status: ExpenseStatus.SETTLED, invoice: { merchant: ritzCarlton, subtotal: 1_250_000, tax: 100_000 }, settleGroup: 'budi' },
    { no: 16, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'NESTLE', brand: 'MILO', activity: 'Dinner', purpose: 'Dinner apresiasi distributor', amount: 900_000, days: 18, payment: 'CREDIT_CARD', card: cardSiti, status: ExpenseStatus.SETTLED, invoice: { merchant: starbucks, subtotal: 830_000, tax: 70_000 }, settleGroup: 'siti' },
    { no: 17, sales: siti, pod: podSiti, unitId: siti.unitId, advertiser: 'MYOR', brand: 'KOPIKO', activity: 'Client Meeting', purpose: 'Meeting client tahunan Kopiko', amount: 410_000, days: 25, payment: 'BANK_TRANSFER', status: ExpenseStatus.SETTLED, invoice: { merchant: sushiTei, subtotal: 380_000, tax: 30_000 }, settleGroup: 'siti' },
  ];

  const settleGroups = { budi: [], siti: [] };

  for (const d of defs) {
    const expenseNo = `EXP-DEMO2-${String(d.no).padStart(4, '0')}`;
    const expense = await prisma.expense.create({
      data: {
        expenseNo,
        salesId: d.sales.id,
        unitId: d.unitId,
        podId: d.pod.id,
        departmentId: deptSalesMkt.id,
        advertiserId: advertisers[d.advertiser].id,
        brandId: brands[d.brand].id,
        activityTypeId: activityTypes[d.activity].id,
        costCenterId: ccSales.id,
        expenseDate: daysAgo(d.days),
        purpose: d.purpose,
        amount: d.amount,
        status: d.status,
        paymentMethodType: d.payment,
        creditCardId: d.card ? d.card.id : undefined,
        participants: {
          create: [
            { category: ParticipantCategory.ADVERTISER, name: 'Rudi Hartanto', position: 'Brand Manager' },
            { category: ParticipantCategory.EMPLOYEE, name: d.sales.name, position: 'Sales' },
          ],
        },
        invoices: d.invoice
          ? {
              create: [
                {
                  invoiceNumber: `INV-DEMO2-${String(d.no).padStart(4, '0')}`,
                  invoiceDate: daysAgo(d.days),
                  merchantId: d.invoice.merchant.id,
                  finalMerchantName: d.invoice.merchant.name,
                  finalSubtotal: d.invoice.subtotal,
                  finalTax: d.invoice.tax,
                  finalTotal: d.amount,
                  matchingStatus: MatchingStatus.MANUAL_MATCHED,
                  modifiedById: d.sales.id,
                  modifiedAt: new Date(),
                },
              ],
            }
          : undefined,
      },
    });

    // Settlement-stage ApprovalRequest, mirroring the real chain (Dept Head -> Div Head -> BOD),
    // in whatever state matches this Expense's status.
    if (d.status === ExpenseStatus.PENDING_APPROVAL) {
      await prisma.approvalRequest.create({
        data: {
          documentStage: DocumentStage.SETTLEMENT, expenseId: expense.id, approvalLevelId: settlementLevel.id,
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
    } else if (d.status === ExpenseStatus.REJECTED) {
      const ar = await prisma.approvalRequest.create({
        data: {
          documentStage: DocumentStage.SETTLEMENT, expenseId: expense.id, approvalLevelId: settlementLevel.id,
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
        data: { approvalRequestId: ar.id, actorId: hendra.id, positionId: positions.DEPT_HEAD.id, action: 'REJECT', reason: d.rejectReason },
      });
    } else if (d.status === ExpenseStatus.APPROVED || d.status === ExpenseStatus.SETTLED) {
      const ar = await prisma.approvalRequest.create({
        data: {
          documentStage: DocumentStage.SETTLEMENT, expenseId: expense.id, approvalLevelId: settlementLevel.id,
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
          { approvalRequestId: ar.id, actorId: hendra.id, positionId: positions.DEPT_HEAD.id, action: 'APPROVE' },
          { approvalRequestId: ar.id, actorId: bambang.id, positionId: positions.DIV_HEAD.id, action: 'APPROVE' },
          { approvalRequestId: ar.id, actorId: diana.id, positionId: positions.BOD.id, action: 'APPROVE' },
        ],
      });
    }

    if (d.settleGroup) settleGroups[d.settleGroup].push({ id: expense.id, amount: d.amount });
    console.log(`Created ${expenseNo} (${d.status}) - ${d.purpose}`);
  }

  // --- 2 dummy Settlements, one per POD, grouping the SETTLED expenses above ---
  async function createSettlement(podId, list, status) {
    const totalAmount = list.reduce((sum, e) => sum + e.amount, 0);
    const prefix = `STL-DEMO2-`;
    const settlementNo = await generateSettlementNo(prefix);
    const settlement = await prisma.settlement.create({
      data: { settlementNo, podId, departmentId: deptSalesMkt.id, totalAmount, status, createdById: budi.id },
    });
    await prisma.expense.updateMany({ where: { id: { in: list.map((e) => e.id) } }, data: { settlementId: settlement.id } });
    console.log(`Created Settlement ${settlementNo} (${status}) - ${list.length} expense(s), total Rp ${totalAmount.toLocaleString('id-ID')}`);
    return settlement;
  }

  await createSettlement(podBudi.id, settleGroups.budi, SettlementStatus.COMPLETE);
  await createSettlement(podSiti.id, settleGroups.siti, SettlementStatus.DRAFT);

  console.log('\nDone. Dummy Expense/Settlement data reset and reseeded.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
