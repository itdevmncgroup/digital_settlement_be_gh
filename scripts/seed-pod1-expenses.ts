// Seeds 3 Expenses for Department "POD 1" (created by `npm run seed`'s 10-POD
// generator) - 2 paid by POD 1's shared corporate card, 1 by Reimbursement.
//
// Goes through the real ExpensesService.create() (via a Nest application
// context), not raw Prisma inserts - so each Expense gets exactly the same
// approval chain (HEAD_POD -> CO-CSO-1 -> CO-CSO-2) a real submission from the
// app would produce, instead of a hand-rolled approximation that could drift
// from ApprovalsService's actual resolution logic. Requires an Approval Level
// already configured for DocumentStage.EXPENSES (Admin > Approval Levels) with
// a resolvable HEAD_POD approver - if none exists yet, this fails with the
// same "No Approval Level configured..." error the app itself would show.
//
// Usage: node -r ts-node/register scripts/seed-pod1-expenses.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ExpensesService } from '../src/expenses/expenses.service';
import { RoleName } from '../src/common/constants/role-name';

function dateOnly(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function must<T>(promise: Promise<T | null>, label: string): Promise<T> {
  const result = await promise;
  if (!result) throw new Error(`Required seed data missing: ${label} - run \`npm run seed\` first.`);
  return result;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const prisma = app.get(PrismaService);
    const expensesService = app.get(ExpensesService);

    const department = await must(prisma.department.findFirst({ where: { name: 'POD 1' } }), 'Department "POD 1"');
    const sales = await must(
      prisma.user.findFirst({
        where: { departments: { some: { departmentId: department.id, status: 'ACTIVE' } } },
        orderBy: { employeeId: 'asc' },
      }),
      'a Sales user assigned to "POD 1"',
    );
    if (!sales.unitId) throw new Error(`Sales user ${sales.email} has no unitId - fix master data before seeding.`);

    // 1 Department = 1 credit card (CreditCard.departmentId is unique) - reuse
    // POD 1's existing card if Admin already set one up, otherwise create one.
    let creditCard = await prisma.creditCard.findUnique({ where: { departmentId: department.id } });
    if (!creditCard) {
      creditCard = await prisma.creditCard.create({
        data: { bank: 'BCA', last4: '1234', cardHolderName: `${department.name} Card`, departmentId: department.id },
      });
      console.log(`Created credit card for ${department.name}: BCA ****1234`);
    }

    const advertiser = await must(prisma.advertiser.findFirst({ orderBy: { code: 'asc' } }), 'at least one Advertiser');
    const brand = await must(
      prisma.brand.findFirst({ where: { advertiserId: advertiser.id }, orderBy: { code: 'asc' } }),
      `a Brand under Advertiser ${advertiser.name}`,
    );
    const activityType = await must(prisma.activityType.findFirst({ orderBy: { name: 'asc' } }), 'at least one Activity Type');
    const costCenter = await prisma.costCenter.findFirst({ orderBy: { code: 'asc' } });

    const corporateCard = await must(prisma.paymentMethod.findUnique({ where: { code: 'CORPORATE_CARD' } }), 'PaymentMethod "CORPORATE_CARD"');
    const reimbursement = await must(prisma.paymentMethod.findUnique({ where: { code: 'REIMBURSEMENT' } }), 'PaymentMethod "REIMBURSEMENT"');

    const defs: {
      purpose: string;
      amount: number;
      days: number;
      paymentMethodId: string;
      creditCardId?: string;
      paymentMethodNote?: string;
    }[] = [
      { purpose: 'Dinner entertain client - POD 1', amount: 850_000, days: 2, paymentMethodId: corporateCard.id, creditCardId: creditCard.id },
      { purpose: 'Lunch meeting client - POD 1', amount: 420_000, days: 1, paymentMethodId: corporateCard.id, creditCardId: creditCard.id },
      { purpose: 'Coffee meeting client - POD 1', amount: 150_000, days: 0, paymentMethodId: reimbursement.id, paymentMethodNote: 'Reimburse via payroll' },
    ];

    for (const d of defs) {
      const expense = await expensesService.create(
        {
          departmentId: department.id,
          unitId: sales.unitId,
          advertiserId: advertiser.id,
          brandId: brand.id,
          activityTypeId: activityType.id,
          costCenterId: costCenter?.id,
          expenseDate: dateOnly(d.days),
          purpose: d.purpose,
          amount: d.amount,
          paymentMethodId: d.paymentMethodId,
          creditCardId: d.creditCardId,
          paymentMethodNote: d.paymentMethodNote,
        },
        sales.id,
        [RoleName.SALES],
        [],
      );
      console.log(`Created ${expense.expenseNo} (${expense.status}) - ${d.purpose}`);
    }

    console.log('\nDone. 3 Expenses seeded for POD 1.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
