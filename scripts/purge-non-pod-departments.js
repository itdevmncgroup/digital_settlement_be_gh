// Deletes all data belonging to Departments other than "POD 1".."POD 7":
// their Expenses, Events and Settlements (and everything that cascades from
// those - ExpenseItem/Invoice/ApprovalRequest/etc), then the Department rows
// themselves, then any User left with zero remaining Department membership.
// A candidate user is only deleted if nothing else still references them
// (sales owner, department approver, resolved approver, action actor,
// uploader, settlement creator) - otherwise they're left in place and listed
// at the end so a human can decide (e.g. reassign, then re-run).
//
// Usage: node scripts/purge-non-pod-departments.js [--dry-run]
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const KEEP_DEPARTMENTS = Array.from({ length: 7 }, (_, i) => `POD ${i + 1}`);
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const keepDepts = await prisma.department.findMany({ where: { name: { in: KEEP_DEPARTMENTS } } });
  const missing = KEEP_DEPARTMENTS.filter((n) => !keepDepts.some((d) => d.name === n));
  if (missing.length) console.warn(`Warning: expected department(s) not found, nothing to keep for: ${missing.join(', ')}`);

  const keepIds = keepDepts.map((d) => d.id);
  const purgeDepts = await prisma.department.findMany({ where: { id: { notIn: keepIds } } });
  const purgeIds = purgeDepts.map((d) => d.id);

  console.log(`Keeping: ${keepDepts.map((d) => d.name).join(', ') || '(none found)'}`);
  console.log(`Purging (${purgeDepts.length}): ${purgeDepts.map((d) => d.name).join(', ') || '(none)'}`);
  if (purgeIds.length === 0) {
    console.log('Nothing to purge.');
    return;
  }

  const [expenseCount, eventCount, settlementCount, creditCardCount, auditFindingCount] = await Promise.all([
    prisma.expense.count({ where: { departmentId: { in: purgeIds } } }),
    prisma.event.count({ where: { departmentId: { in: purgeIds } } }),
    prisma.settlement.count({ where: { departmentId: { in: purgeIds } } }),
    prisma.creditCard.count({ where: { departmentId: { in: purgeIds } } }),
    prisma.auditFinding.count({ where: { departmentId: { in: purgeIds } } }),
  ]);
  console.log(
    `Will delete ${expenseCount} expense(s), ${eventCount} event(s), ${settlementCount} settlement(s). ` +
      `${creditCardCount} credit card(s) and ${auditFindingCount} audit finding(s) will be kept but unlinked (departmentId set null).`,
  );

  if (dryRun) {
    console.log('Dry run - no changes made.');
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      const delExpenses = await tx.expense.deleteMany({ where: { departmentId: { in: purgeIds } } });
      const delEvents = await tx.event.deleteMany({ where: { departmentId: { in: purgeIds } } });
      const delSettlements = await tx.settlement.deleteMany({ where: { departmentId: { in: purgeIds } } });
      console.log(`Deleted ${delExpenses.count} expense(s), ${delEvents.count} event(s), ${delSettlements.count} settlement(s).`);

      const delDepartments = await tx.department.deleteMany({ where: { id: { in: purgeIds } } });
      console.log(`Deleted ${delDepartments.count} department(s).`);

      const candidateUsers = await tx.user.findMany({ where: { departments: { none: {} } }, select: { id: true, email: true } });
      let deletedUsers = 0;
      const skipped = [];
      for (const user of candidateUsers) {
        const [salesAssignments, eventsAsSales, expensesAsSales, deptPositions, approvalSteps, approvalActions, batchesUploaded, settlementsCreated] =
          await Promise.all([
            tx.salesAssignment.count({ where: { salesId: user.id } }),
            tx.event.count({ where: { salesId: user.id } }),
            tx.expense.count({ where: { salesId: user.id } }),
            tx.departmentPositionAssignment.count({ where: { userId: user.id } }),
            tx.approvalRequestStep.count({ where: { resolvedApproverId: user.id } }),
            tx.approvalAction.count({ where: { actorId: user.id } }),
            tx.bankSettlementBatch.count({ where: { uploadedById: user.id } }),
            tx.settlement.count({ where: { createdById: user.id } }),
          ]);
        const blockers =
          salesAssignments + eventsAsSales + expensesAsSales + deptPositions + approvalSteps + approvalActions + batchesUploaded + settlementsCreated;
        if (blockers > 0) {
          skipped.push(`${user.email} (${blockers} referencing row(s) elsewhere)`);
          continue;
        }
        await tx.user.delete({ where: { id: user.id } });
        deletedUsers++;
      }

      console.log(`Deleted ${deletedUsers} orphaned user(s) with no remaining department membership.`);
      if (skipped.length) console.log(`Skipped ${skipped.length} user(s) still referenced elsewhere:\n  ${skipped.join('\n  ')}`);
    },
    { timeout: 60000 },
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
