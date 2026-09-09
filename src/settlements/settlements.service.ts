import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExpenseStatus, Prisma, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords } from '../common/rbac/scope.util';
import { ApprovalsService } from '../approvals/approvals.service';

const include = {
  department: true,
  createdBy: { select: { id: true, name: true } },
  // The batch's own chain (SLS_MAR_DIR -> VP -> CO_CFO). Its current step names
  // who may review the member Expenses and press Submit to close the tier.
  approvalRequest: {
    select: {
      status: true,
      currentStep: true,
      steps: {
        select: {
          stepOrder: true,
          status: true,
          position: { select: { name: true } },
          resolvedApprover: { select: { id: true, name: true } },
        },
        orderBy: { stepOrder: 'asc' as const },
      },
    },
  },
  expenses: {
    select: {
      id: true,
      expenseNo: true,
      amount: true,
      expenseDate: true,
      purpose: true,
      status: true,
      sales: { select: { id: true, name: true } },
      advertiser: { select: { name: true } },
      brand: { select: { name: true } },
      // Backs the Settlement detail's per-transaction Approve/Reject (re-affirm
      // the match / unmatch) - reuses BankMatchingService's existing endpoints.
      bankTransactions: { select: { id: true, status: true } },
      // The Expense's own chain (HEAD_POD -> CO-CSO-1 -> CO-CSO-2), already
      // finished by the time it can join a batch - shown for history. The tier
      // being reviewed here belongs to the Settlement's own request below.
      settlementApprovedStep: true,
      approvalRequest: {
        select: {
          status: true,
          currentStep: true,
          documentStage: true,
          steps: {
            select: {
              stepOrder: true,
              status: true,
              position: { select: { name: true } },
              resolvedApprover: { select: { id: true, name: true } },
            },
            orderBy: { stepOrder: 'asc' as const },
          },
        },
      },
    },
  },
} as const;

// Groups a Department's READY_TO_SETTLED Expenses (approval chain finished,
// then bank-matched) into one Settlement, which immediately starts the batch's
// own approval chain: SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV. Each
// tier's approver reviews the member Expenses one by one and then presses
// Submit to close the tier (ApprovalsService.reviewSettlementExpense /
// submitSettlementTier); the final Submit marks everything COMPLETE and pushes
// the batch to the external system. One Settlement per Department per click.
@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async findAll(actor: AuthUser, departmentId?: string) {
    let departmentIds: string[] | undefined;
    if (!canViewAllRecords(actor) && !actor.permissions?.includes('settlement.read.all')) {
      const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { departmentId: true } });
      // No Department on the actor's own profile means their position sits above
      // Department level (e.g. Co-Chief Sales Officer) - they see every Department.
      if (user?.departmentId) departmentIds = [user.departmentId];
    }
    return this.prisma.settlement.findMany({
      where: { departmentId: departmentId ?? (departmentIds ? { in: departmentIds } : undefined) },
      include,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id }, include });
    if (!settlement) throw new NotFoundException('Settlement not found');
    return settlement;
  }

  // Eligible = already SETTLED (fully approved on its own) and bank-matched, not
  // already part of an earlier Settlement.
  async create(actorId: string, actorRoles: string[], dtoSalesId?: string) {
    const targetSalesId = this.isBackOffice(actorRoles) && dtoSalesId ? dtoSalesId : actorId;

    const targetUser = await this.prisma.user.findUnique({ where: { id: targetSalesId }, select: { departmentId: true } });
    if (!targetUser?.departmentId) return [];

    const eligible = await this.prisma.expense.findMany({
      where: {
        salesId: targetSalesId,
        departmentId: targetUser.departmentId,
        settlementId: null,
        status: ExpenseStatus.READY_TO_SETTLED,
        isMatched: true,
      },
      select: { id: true, departmentId: true, amount: true },
    });
    if (eligible.length === 0) return [];

    const byDepartment = new Map<string, typeof eligible>();
    for (const exp of eligible) {
      const list = byDepartment.get(exp.departmentId as string) ?? [];
      list.push(exp);
      byDepartment.set(exp.departmentId as string, list);
    }

    const created = [];
    for (const [departmentId, list] of byDepartment) {
      const totalAmount = list.reduce((sum, e) => sum + Number(e.amount), 0);
      const settlementNo = await this.generateSettlementNo();

      const settlement = await this.prisma.$transaction(async (tx) => {
        const s = await tx.settlement.create({
          data: { settlementNo, departmentId, totalAmount, createdById: actorId },
        });
        await tx.expense.updateMany({
          where: { id: { in: list.map((e) => e.id) } },
          data: { settlementId: s.id },
        });
        await this.enterSettlementStage(tx, s.id, totalAmount);
        return tx.settlement.findUniqueOrThrow({ where: { id: s.id }, include });
      });

      await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Settlement', objectId: settlement.id, newValue: settlement });
      created.push(settlement);
    }

    return created;
  }

  // Backs the Settlement page's "Create Settlement" popup: preview-only,
  // scoped to one Department + one date range (instead of create()'s "every
  // eligible Department for this actor") - matched, SETTLED (its Expense-stage
  // chain maxed out at CO-CSO-2) and not yet grouped into a settlement, plus the
  // picked departmentId/date range (matches createFromSelection()/eligibleExpenses()/
  // addExpenses()). Nothing is persisted here; the web page's Submit step
  // commits the user's checked subset via createFromSelection() or
  // addExpenses() (see the "Buat baru"/"Tambahkan" choice when an open DRAFT
  // settlement already covers this Department). A plain Sales caller may only
  // target a Department they belong to; ADMIN/FINANCE may target any Department.
  async generate(departmentId: string, fromDate: string, toDate: string, actorId: string, actorRoles: string[]) {
    if (!this.isBackOffice(actorRoles)) {
      const user = await this.prisma.user.findUnique({ where: { id: actorId }, select: { departmentId: true } });
      if (user?.departmentId !== departmentId) throw new ForbiddenException('You are not a member of this Department');
    }

    const from = new Date(fromDate);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    if (from > to) throw new BadRequestException('"From" date must be before or equal to "To" date');

    const [expenses, existingDraftSettlement] = await Promise.all([
      this.prisma.expense.findMany({
        where: {
          departmentId,
          settlementId: null,
          expenseDate: { gte: from, lte: to },
          isMatched: true,
          status: ExpenseStatus.READY_TO_SETTLED,
        },
        select: {
          id: true,
          expenseNo: true,
          expenseDate: true,
          purpose: true,
          amount: true,
          status: true,
          sales: { select: { id: true, name: true } },
        },
        orderBy: { expenseDate: 'asc' },
      }),
      this.prisma.settlement.findFirst({
        where: { departmentId, status: SettlementStatus.DRAFT },
        select: { id: true, settlementNo: true },
      }),
    ]);

    return { expenses, existingDraftSettlement };
  }

  // "Buat baru" - creates a brand-new Settlement from exactly the expenses the
  // user checked in the preview table (instead of generate()'s old behaviour
  // of auto-grabbing every eligible Expense in the date range). Same
  // eligibility validation as addExpenses() so a stale/tampered selection is
  // still rejected server-side.
  async createFromSelection(departmentId: string, expenseIds: string[], actorId: string, actorRoles: string[]) {
    if (!this.isBackOffice(actorRoles)) {
      const user = await this.prisma.user.findUnique({ where: { id: actorId }, select: { departmentId: true } });
      if (user?.departmentId !== departmentId) throw new ForbiddenException('You are not a member of this Department');
    }

    const expenses = await this.prisma.expense.findMany({
      where: { id: { in: expenseIds } },
      select: { id: true, expenseNo: true, departmentId: true, settlementId: true, status: true, isMatched: true, amount: true },
    });
    const found = new Set(expenses.map((e) => e.id));
    const missing = expenseIds.filter((eid) => !found.has(eid));
    // SETTLED is required, not cosmetic: joining a Settlement resets the
    // Expense's ApprovalRequest onto the SETTLEMENT chain, which would silently
    // abandon an Expense-stage chain that hasn't finished yet.
    const ineligible = expenses.filter(
      (e) => e.departmentId !== departmentId || e.settlementId !== null || !e.isMatched || e.status !== ExpenseStatus.READY_TO_SETTLED,
    );
    if (missing.length > 0 || ineligible.length > 0) {
      const bad = [...missing, ...ineligible.map((e) => e.expenseNo)];
      throw new BadRequestException(`Not eligible for a new settlement: ${bad.join(', ')}`);
    }
    if (expenses.length === 0) throw new BadRequestException('Select at least one expense');

    const totalAmount = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const settlementNo = await this.generateSettlementNo();

    const settlement = await this.prisma.$transaction(async (tx) => {
      const s = await tx.settlement.create({
        data: { settlementNo, departmentId, totalAmount, createdById: actorId },
      });
      await tx.expense.updateMany({
        where: { id: { in: expenseIds } },
        data: { settlementId: s.id },
      });
      await this.enterSettlementStage(tx, s.id, totalAmount);
      return tx.settlement.findUniqueOrThrow({ where: { id: s.id }, include });
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Settlement', objectId: settlement.id, newValue: settlement });

    return settlement;
  }

  // Same eligibility rule as generate()/createFromSelection() (matched +
  // ungrouped, regardless of approval status), scoped to one Settlement's
  // Department - backs the web admin "Add Expenses" picker.
  async eligibleExpenses(id: string) {
    const settlement = await this.findOne(id);
    return this.prisma.expense.findMany({
      where: { departmentId: settlement.departmentId, settlementId: null, isMatched: true, status: ExpenseStatus.READY_TO_SETTLED },
      select: { id: true, expenseNo: true, amount: true, expenseDate: true, purpose: true, sales: { select: { id: true, name: true } } },
      orderBy: { expenseDate: 'desc' },
    });
  }

  // Adds Expenses to an already-existing Settlement instead of only ever
  // creating a new one - a DRAFT Settlement can keep growing as more of a
  // Department's Expenses become matched.
  async addExpenses(id: string, expenseIds: string[], actorId: string, actorRoles: string[]) {
    const settlement = await this.findOne(id);
    if (settlement.status !== SettlementStatus.DRAFT) {
      throw new BadRequestException('Only a DRAFT settlement can have expenses added to it');
    }
    if (!this.isBackOffice(actorRoles)) {
      const user = await this.prisma.user.findUnique({ where: { id: actorId }, select: { departmentId: true } });
      if (user?.departmentId !== settlement.departmentId) throw new ForbiddenException('You are not a member of this Department');
    }

    const expenses = await this.prisma.expense.findMany({
      where: { id: { in: expenseIds } },
      select: { id: true, expenseNo: true, departmentId: true, settlementId: true, status: true, isMatched: true, amount: true },
    });
    const found = new Set(expenses.map((e) => e.id));
    const missing = expenseIds.filter((eid) => !found.has(eid));
    const ineligible = expenses.filter(
      (e) => e.departmentId !== settlement.departmentId || e.settlementId !== null || !e.isMatched || e.status !== ExpenseStatus.READY_TO_SETTLED,
    );
    if (missing.length > 0 || ineligible.length > 0) {
      const bad = [...missing, ...ineligible.map((e) => e.expenseNo)];
      throw new BadRequestException(`Not eligible to add to this settlement: ${bad.join(', ')}`);
    }

    const addedTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const newTotal = Number(settlement.totalAmount) + addedTotal;
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.expense.updateMany({ where: { id: { in: expenseIds } }, data: { settlementId: id } });
      // A batch already part-way through its chain keeps its tier - the added
      // Expenses simply join it (unreviewed, so they hold Submit until this
      // tier's approver signs off on them too). Only a batch that hasn't
      // started yet enters the chain here.
      await this.enterSettlementStage(tx, id, newTotal);
      return tx.settlement.update({
        where: { id },
        data: { totalAmount: newTotal },
        include,
      });
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Settlement', objectId: id, oldValue: settlement, newValue: updated });
    return updated;
  }

  // Marks a Settlement's bookkeeping as reconciled/closed. Purely a flag on the
  // batch itself - member Expenses are already SETTLED by the time they're
  // eligible to join a Settlement at all, so there's nothing left to gate or
  // flip on them here.
  async complete(id: string, actorId: string) {
    const before = await this.findOne(id);
    if (before.status === SettlementStatus.COMPLETE) return before;

    const settlement = await this.prisma.settlement.update({ where: { id }, data: { status: SettlementStatus.COMPLETE }, include });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Settlement', objectId: id, oldValue: before.status, newValue: settlement.status });
    return settlement;
  }

  // Creating a Settlement starts the batch's own approval chain (SLS_MAR_DIR ->
  // VP -> CO_CFO) - both the Settlement and every member Expense take on the
  // first tier's status. Runs inside the caller's transaction, so a Settlement
  // is never created without entering the chain. Adding Expenses to a batch
  // that already has a request leaves it on its current tier; the new Expenses
  // just have to be reviewed there like the rest (settlementApprovedStep).
  private async enterSettlementStage(tx: Prisma.TransactionClient, settlementId: string, totalAmount: number): Promise<void> {
    const existing = await tx.approvalRequest.findFirst({ where: { settlementId } });
    if (!existing) {
      await this.approvals.enterSettlementApproval(tx, { settlementId, amount: totalAmount });
      return;
    }
    if (existing.status !== 'PENDING') {
      throw new BadRequestException('This settlement has already finished its approval - create a new one instead');
    }
    // Mid-chain: pull the just-added Expenses onto the tier the batch is on.
    await this.approvals.applySettlementTierStatus(tx, settlementId, existing.currentStep);
  }

  private isBackOffice(actorRoles: string[]): boolean {
    return actorRoles.some((r) => r === 'ADMIN' || r === 'FINANCE');
  }

  private async generateSettlementNo(): Promise<string> {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const prefix = `STL-${yy}${mm}${dd}`;
    const count = await this.prisma.settlement.count({ where: { settlementNo: { startsWith: prefix } } });
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }
}
