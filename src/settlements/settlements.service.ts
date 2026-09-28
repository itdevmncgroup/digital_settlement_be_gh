import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExpenseStatus, Prisma, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords } from '../common/rbac/scope.util';
import { ApprovalsService } from '../approvals/approvals.service';
import { PaymentMethodGroup, SettlementAllocationRowDto } from './dto/settlement.dto';

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
      // Who approved/rejected each tier and when - the Settlement's own
      // approval history (SLS_MAR_DIR -> VP -> CO_CFO), separate from each
      // member Expense's own trail under expenses[].approvalRequest below.
      actions: {
        select: {
          id: true,
          action: true,
          reason: true,
          actedAt: true,
          actor: { select: { id: true, name: true } },
          position: { select: { name: true } },
        },
        orderBy: { actedAt: 'asc' as const },
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
      // isMatched is the source of truth for the Matched/Not Matched badge on the
      // Settlement detail's expense list - also true for a manual match with no
      // billing-statement transaction at all (e-wallet/personal reimbursement),
      // which bankTransactions alone wouldn't show.
      isMatched: true,
      // Lets the edit page derive the settlement's Corporate Card / Non Corporate Card group.
      paymentMethod: { select: { code: true } },
      bankTransactions: { select: { id: true, status: true } },
      // The Expense's own chain (HEAD_POD -> CO-CSO), already
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
  allocations: {
    select: {
      id: true,
      percentage: true,
      description: true,
      analyticAcc: true,
      account: true,
      wilayah: true,
      linePr: true,
      qty: true,
      curr: true,
      originalPrice: true,
      rate: true,
      unitPrice: true,
      totalPrice: true,
      unit: { select: { id: true, code: true, name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
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
      // No Department on the actor's own profile means their position sits above
      // Department level (e.g. Co-Chief Sales Officer) - they see every Department.
      const memberships = await this.getUserDepartmentIds(actor.userId);
      if (memberships.length > 0) departmentIds = memberships;
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

    const departmentIds = await this.getUserDepartmentIds(targetSalesId);
    if (departmentIds.length === 0) return [];

    const eligible = await this.prisma.expense.findMany({
      where: {
        salesId: targetSalesId,
        departmentId: { in: departmentIds },
        settlementId: null,
        status: ExpenseStatus.READY_TO_SETTLED,
        isMatched: true,
      },
      select: { id: true, departmentId: true, amount: true, paymentMethod: { select: { code: true } } },
    });
    if (eligible.length === 0) return [];

    // One Settlement per Department AND per Corporate Card / Non Corporate Card
    // group - never mix the two (see groupOf).
    const byDepartment = new Map<string, typeof eligible>();
    for (const exp of eligible) {
      const key = `${exp.departmentId}:${this.groupOf(exp.paymentMethod?.code)}`;
      const list = byDepartment.get(key) ?? [];
      list.push(exp);
      byDepartment.set(key, list);
    }

    const created = [];
    for (const [key, list] of byDepartment) {
      const departmentId = key.slice(0, key.lastIndexOf(':'));
      const totalAmount = list.reduce((sum, e) => sum + Number(e.amount), 0);
      const settlementNo = await this.generateSettlementNo();

      const settlement = await this.prisma.$transaction(async (tx) => {
        const s = await tx.settlement.create({
          data: { settlementNo, departmentId, totalAmount, createdById: actorId, status: SettlementStatus.DRAFT_SETTLEMENT },
        });
        await tx.expense.updateMany({
          where: { id: { in: list.map((e) => e.id) } },
          data: { settlementId: s.id },
        });
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
  // chain maxed out at CO-CSO) and not yet grouped into a settlement, plus the
  // picked departmentId/date range (matches createFromSelection()/eligibleExpenses()/
  // addExpenses()). Nothing is persisted here; the web page's Submit step
  // commits the user's checked subset via createFromSelection() or
  // addExpenses() (see the "Buat baru"/"Tambahkan" choice when an open DRAFT
  // settlement already covers this Department). A plain Sales caller may only
  // target a Department they belong to; ADMIN/FINANCE may target any Department.
  async generate(
    departmentId: string,
    fromDate: string,
    toDate: string,
    paymentMethodGroup: PaymentMethodGroup,
    actorId: string,
    actorRoles: string[],
  ) {
    if (!this.isBackOffice(actorRoles)) {
      await this.assertMemberOfDepartment(actorId, departmentId);
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
          ...(paymentMethodGroup === 'CORPORATE_CARD'
            ? { paymentMethod: { code: 'CORPORATE_CARD' } }
            : { OR: [{ paymentMethodId: null }, { paymentMethod: { code: { not: 'CORPORATE_CARD' } } }] }),
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
      // Scoped to the same payment method group too - a draft settlement built
      // from Corporate Card expenses must never be offered as the "add to
      // existing" target for a Non Corporate Card search, and vice versa.
      // DRAFT_SETTLEMENT, not the legacy DRAFT: that is what create()/
      // createFromSelection() write and the only status addExpenses() accepts.
      this.prisma.settlement.findFirst({
        where: {
          departmentId,
          status: SettlementStatus.DRAFT_SETTLEMENT,
          expenses:
            paymentMethodGroup === 'CORPORATE_CARD'
              ? { some: { paymentMethod: { code: 'CORPORATE_CARD' } } }
              : { some: { OR: [{ paymentMethodId: null }, { paymentMethod: { code: { not: 'CORPORATE_CARD' } } }] } },
        },
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
  async createFromSelection(
    departmentId: string,
    expenseIds: string[],
    paymentMethodGroup: PaymentMethodGroup,
    actorId: string,
    actorRoles: string[],
    allocations: SettlementAllocationRowDto[] = [],
  ) {
    if (!this.isBackOffice(actorRoles)) {
      await this.assertMemberOfDepartment(actorId, departmentId);
    }

    const expenses = await this.prisma.expense.findMany({
      where: { id: { in: expenseIds } },
      select: {
        id: true,
        expenseNo: true,
        departmentId: true,
        settlementId: true,
        status: true,
        isMatched: true,
        amount: true,
        paymentMethod: { select: { code: true } },
      },
    });
    const found = new Set(expenses.map((e) => e.id));
    const missing = expenseIds.filter((eid) => !found.has(eid));
    // SETTLED is required, not cosmetic: joining a Settlement resets the
    // Expense's ApprovalRequest onto the SETTLEMENT chain, which would silently
    // abandon an Expense-stage chain that hasn't finished yet. A Settlement may
    // never mix Corporate Card and Non Corporate Card expenses (groupOf).
    const ineligible = expenses.filter(
      (e) =>
        e.departmentId !== departmentId ||
        e.settlementId !== null ||
        !e.isMatched ||
        e.status !== ExpenseStatus.READY_TO_SETTLED ||
        this.groupOf(e.paymentMethod?.code) !== paymentMethodGroup,
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
        data: { settlementNo, departmentId, totalAmount, createdById: actorId, status: SettlementStatus.DRAFT_SETTLEMENT },
      });
      await tx.expense.updateMany({
        where: { id: { in: expenseIds } },
        data: { settlementId: s.id },
      });
      if (allocations.length > 0) {
        await tx.settlementAllocation.createMany({
          data: allocations.map((row) => this.buildAllocationRow(s.id, totalAmount, row)),
        });
      }
      return tx.settlement.findUniqueOrThrow({ where: { id: s.id }, include });
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Settlement', objectId: settlement.id, newValue: settlement });

    return settlement;
  }

  // Same eligibility rule as generate()/createFromSelection() (matched +
  // ungrouped, regardless of approval status), scoped to one Settlement's
  // Department AND its existing payment method group (Corporate Card / Non
  // Corporate Card - never mixed) - backs the web admin "Add Expenses" picker.
  async eligibleExpenses(id: string) {
    const settlement = await this.findOne(id);
    const group = await this.settlementGroup(id);
    return this.prisma.expense.findMany({
      where: {
        departmentId: settlement.departmentId,
        settlementId: null,
        isMatched: true,
        status: ExpenseStatus.READY_TO_SETTLED,
        ...(group === 'CORPORATE_CARD'
          ? { paymentMethod: { code: 'CORPORATE_CARD' } }
          : group === 'NON_CORPORATE_CARD'
            ? { OR: [{ paymentMethodId: null }, { paymentMethod: { code: { not: 'CORPORATE_CARD' } } }] }
            : {}),
      },
      select: { id: true, expenseNo: true, amount: true, expenseDate: true, purpose: true, sales: { select: { id: true, name: true } } },
      orderBy: { expenseDate: 'desc' },
    });
  }

  // Adds Expenses to an already-existing Settlement instead of only ever
  // creating a new one - a DRAFT Settlement can keep growing as more of a
  // Department's Expenses become matched.
  async addExpenses(id: string, expenseIds: string[], actorId: string, actorRoles: string[]) {
    const settlement = await this.findOne(id);
    // Status leaves DRAFT_SETTLEMENT the moment Submit (submitDraft) is
    // pressed and the chain starts - joining is only safe while still a
    // draft, since new Expenses added after Submit would otherwise slip in
    // unreviewed by whichever tier already started on the batch.
    if (settlement.status !== SettlementStatus.DRAFT_SETTLEMENT) {
      throw new BadRequestException('Expenses can no longer be added - this settlement has already been submitted');
    }
    if (!this.isBackOffice(actorRoles)) {
      await this.assertMemberOfDepartment(actorId, settlement.departmentId);
    }

    const group = await this.settlementGroup(id);
    const expenses = await this.prisma.expense.findMany({
      where: { id: { in: expenseIds } },
      select: {
        id: true,
        expenseNo: true,
        departmentId: true,
        settlementId: true,
        status: true,
        isMatched: true,
        amount: true,
        paymentMethod: { select: { code: true } },
      },
    });
    const found = new Set(expenses.map((e) => e.id));
    const missing = expenseIds.filter((eid) => !found.has(eid));
    const ineligible = expenses.filter(
      (e) =>
        e.departmentId !== settlement.departmentId ||
        e.settlementId !== null ||
        !e.isMatched ||
        e.status !== ExpenseStatus.READY_TO_SETTLED ||
        // Not yet started (no member expenses) means this settlement has no group
        // yet, so anything else eligible sets it - otherwise it must match.
        (group !== null && this.groupOf(e.paymentMethod?.code) !== group),
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
      // tier's approver signs off on them too). A batch still DRAFT_SETTLEMENT
      // has no approval request yet, so there's no tier to sync onto - it stays
      // a draft until submitDraft() is called.
      await this.syncMidChainTier(tx, id);
      return tx.settlement.update({
        where: { id },
        data: { totalAmount: newTotal },
        include,
      });
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Settlement', objectId: id, oldValue: settlement, newValue: updated });
    return updated;
  }

  // Settlement list's "Edit" action on a DRAFT_SETTLEMENT: swaps the member
  // Expenses for exactly `expenseIds` (dropped ones go back to the eligible
  // pool, new ones must pass the same eligibility rule as addExpenses()) and
  // rewrites the allocation rows. Department/payment group never change.
  async update(
    id: string,
    expenseIds: string[],
    allocations: SettlementAllocationRowDto[] | undefined,
    actorId: string,
    actorRoles: string[],
  ) {
    const before = await this.findOne(id);
    if (before.status !== SettlementStatus.DRAFT_SETTLEMENT) {
      throw new BadRequestException('Only a draft settlement can be edited');
    }
    if (!this.isBackOffice(actorRoles)) {
      await this.assertMemberOfDepartment(actorId, before.departmentId);
    }

    const group = await this.settlementGroup(id);
    const currentIds = new Set(before.expenses.map((e) => e.id));
    const newIds = [...new Set(expenseIds)];
    const addedIds = newIds.filter((eid) => !currentIds.has(eid));
    const removedIds = [...currentIds].filter((eid) => !newIds.includes(eid));

    const added = await this.prisma.expense.findMany({
      where: { id: { in: addedIds } },
      select: {
        id: true,
        expenseNo: true,
        departmentId: true,
        settlementId: true,
        status: true,
        isMatched: true,
        amount: true,
        paymentMethod: { select: { code: true } },
      },
    });
    const found = new Set(added.map((e) => e.id));
    const missing = addedIds.filter((eid) => !found.has(eid));
    const ineligible = added.filter(
      (e) =>
        e.departmentId !== before.departmentId ||
        e.settlementId !== null ||
        !e.isMatched ||
        e.status !== ExpenseStatus.READY_TO_SETTLED ||
        (group !== null && this.groupOf(e.paymentMethod?.code) !== group),
    );
    if (missing.length > 0 || ineligible.length > 0) {
      const bad = [...missing, ...ineligible.map((e) => e.expenseNo)];
      throw new BadRequestException(`Not eligible to add to this settlement: ${bad.join(', ')}`);
    }

    const keptTotal = before.expenses.filter((e) => !removedIds.includes(e.id)).reduce((sum, e) => sum + Number(e.amount), 0);
    const totalAmount = keptTotal + added.reduce((sum, e) => sum + Number(e.amount), 0);
    const allocationRows: SettlementAllocationRowDto[] =
      allocations ??
      before.allocations.map((a) => ({
        unitId: a.unit.id,
        percentage: Number(a.percentage),
        description: a.description ?? undefined,
        analyticAcc: a.analyticAcc ?? undefined,
        account: a.account ?? undefined,
        wilayah: a.wilayah ?? undefined,
        linePr: a.linePr ?? undefined,
        qty: Number(a.qty),
        curr: a.curr,
        rate: Number(a.rate),
      }));

    const updated = await this.prisma.$transaction(async (tx) => {
      if (removedIds.length > 0) {
        await tx.expense.updateMany({ where: { id: { in: removedIds }, settlementId: id }, data: { settlementId: null } });
      }
      if (addedIds.length > 0) {
        await tx.expense.updateMany({ where: { id: { in: addedIds } }, data: { settlementId: id } });
      }
      await tx.settlementAllocation.deleteMany({ where: { settlementId: id } });
      if (allocationRows.length > 0) {
        await tx.settlementAllocation.createMany({
          data: allocationRows.map((row) => this.buildAllocationRow(id, totalAmount, row)),
        });
      }
      return tx.settlement.update({ where: { id }, data: { totalAmount }, include });
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Settlement', objectId: id, oldValue: before, newValue: updated });
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

  // Settlement list's "Submit" action: leaves DRAFT_SETTLEMENT and starts the
  // batch's own approval chain (SLS_MAR_DIR -> VP -> CO_CFO) - both the
  // Settlement and every member Expense take on the first tier's status.
  async submitDraft(id: string, actorId: string, actorRoles: string[]) {
    const before = await this.findOne(id);
    if (before.status !== SettlementStatus.DRAFT_SETTLEMENT) {
      throw new BadRequestException('Only a draft settlement can be submitted');
    }
    if (!this.isBackOffice(actorRoles)) {
      await this.assertMemberOfDepartment(actorId, before.departmentId);
    }

    const settlement = await this.prisma.$transaction(async (tx) => {
      await this.approvals.enterSettlementApproval(tx, { settlementId: id, amount: before.totalAmount });
      return tx.settlement.findUniqueOrThrow({ where: { id }, include });
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Settlement', objectId: id, oldValue: before.status, newValue: settlement.status });
    return settlement;
  }

  // Safety net for addExpenses(): now unreachable in practice since joining
  // is only allowed while still DRAFT_SETTLEMENT, which never has a request
  // yet - kept in case a future caller re-opens joining on an in-chain batch.
  private async syncMidChainTier(tx: Prisma.TransactionClient, settlementId: string): Promise<void> {
    const existing = await tx.approvalRequest.findFirst({ where: { settlementId } });
    if (!existing) return;
    if (existing.status !== 'PENDING') {
      throw new BadRequestException('This settlement has already finished its approval - create a new one instead');
    }
    await this.approvals.applySettlementTierStatus(tx, settlementId, existing.currentStep);
  }

  // Original Price / Unit Price / Total Price are always the Settlement's total
  // (sum of its member Expenses) * this row's percentage - never taken from the
  // client, so a tampered payload can't inflate a Unit's allocated amount.
  private buildAllocationRow(settlementId: string, settlementTotal: number, row: SettlementAllocationRowDto): Prisma.SettlementAllocationCreateManyInput {
    const amount = Math.round(settlementTotal * (row.percentage / 100) * 100) / 100;
    return {
      settlementId,
      unitId: row.unitId,
      percentage: row.percentage,
      description: row.description,
      analyticAcc: row.analyticAcc,
      account: row.account,
      wilayah: row.wilayah,
      linePr: row.linePr,
      qty: row.qty ?? 1,
      curr: row.curr ?? 'IDR',
      rate: row.rate ?? 1,
      originalPrice: amount,
      unitPrice: amount,
      totalPrice: amount,
    };
  }

  // Corporate Card vs everything else (AP Disbursement, Petty Cash,
  // Reimbursement, or no payment method at all) - the two may never share a
  // Settlement.
  private groupOf(paymentMethodCode: string | undefined | null): PaymentMethodGroup {
    return paymentMethodCode === 'CORPORATE_CARD' ? 'CORPORATE_CARD' : 'NON_CORPORATE_CARD';
  }

  // The payment method group already committed to a Settlement, taken from
  // one of its current member Expenses - null for a Settlement with no
  // members yet (addExpenses() then lets the first addition set the group).
  private async settlementGroup(settlementId: string): Promise<PaymentMethodGroup | null> {
    const member = await this.prisma.expense.findFirst({
      where: { settlementId },
      select: { paymentMethod: { select: { code: true } } },
    });
    return member ? this.groupOf(member.paymentMethod?.code) : null;
  }

  private isBackOffice(actorRoles: string[]): boolean {
    return actorRoles.includes('ADMINISTRATOR');
  }

  private async getUserDepartmentIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.userDepartment.findMany({ where: { userId, status: 'ACTIVE' }, select: { departmentId: true } });
    return memberships.map((m) => m.departmentId);
  }

  private async assertMemberOfDepartment(userId: string, departmentId: string): Promise<void> {
    const departmentIds = await this.getUserDepartmentIds(userId);
    if (!departmentIds.includes(departmentId)) throw new ForbiddenException('You are not a member of this Department');
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
