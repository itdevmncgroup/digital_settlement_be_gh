import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExpenseStatus, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords } from '../common/rbac/scope.util';

const include = {
  pod: true,
  department: true,
  createdBy: { select: { id: true, name: true } },
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
      // Backs the Settlement detail's per-Expense Approve/Reject - an Expense can
      // enter a draft Settlement as soon as it's bank-matched, still carrying
      // whatever ApprovalRequest step it's on; approving it here is the same
      // ApprovalsService.approve() flow used on the Expense detail page.
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
    },
  },
} as const;

// Groups a POD's already-SETTLED, bank-matched Expenses into one Settlement (BRD
// "Create Settlement") for POD-level bookkeeping/reporting. This is a passive
// report, not a gate: an Expense reaches SETTLED entirely on its own (its last
// approval step sets it directly - see ApprovalsService.approve()), independent
// of ever being grouped into a Settlement batch. One Settlement per POD per
// click - a Sales/back-office covering several PODs gets one Settlement per POD
// that actually has eligible Expenses.
@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(actor: AuthUser, podId?: string) {
    let podIds: string[] | undefined;
    if (!canViewAllRecords(actor) && !actor.permissions?.includes('settlement.read.all')) {
      const memberships = await this.prisma.podMember.findMany({ where: { salesId: actor.userId }, select: { podId: true } });
      podIds = memberships.map((m) => m.podId);
    }
    return this.prisma.settlement.findMany({
      where: { podId: podId ?? (podIds ? { in: podIds } : undefined) },
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

    const memberships = await this.prisma.podMember.findMany({ where: { salesId: targetSalesId }, select: { podId: true } });
    const podIds = memberships.map((m) => m.podId);
    if (podIds.length === 0) return [];

    const eligible = await this.prisma.expense.findMany({
      where: {
        salesId: targetSalesId,
        podId: { in: podIds },
        settlementId: null,
        status: ExpenseStatus.SETTLED,
        isMatched: true,
      },
      select: { id: true, podId: true, departmentId: true, amount: true },
    });
    if (eligible.length === 0) return [];

    const byPod = new Map<string, typeof eligible>();
    for (const exp of eligible) {
      const list = byPod.get(exp.podId as string) ?? [];
      list.push(exp);
      byPod.set(exp.podId as string, list);
    }

    const created = [];
    for (const [podId, list] of byPod) {
      const deptIds = new Set(list.map((e) => e.departmentId));
      const departmentId = deptIds.size === 1 ? list[0].departmentId ?? undefined : undefined;
      const totalAmount = list.reduce((sum, e) => sum + Number(e.amount), 0);
      const settlementNo = await this.generateSettlementNo();

      const settlement = await this.prisma.$transaction(async (tx) => {
        const s = await tx.settlement.create({
          data: { settlementNo, podId, departmentId, totalAmount, createdById: actorId },
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

  // Backs the Settlement page's "Create Settlement" popup: scoped to one POD +
  // one date range (instead of create()'s "every eligible POD for this actor").
  // Same eligibility rule as create() - SETTLED and matched - plus the picked
  // podId/date range. A plain Sales caller may only target a POD they belong
  // to; ADMIN/FINANCE may target any POD.
  async generate(podId: string, fromDate: string, toDate: string, actorId: string, actorRoles: string[]) {
    if (!this.isBackOffice(actorRoles)) {
      const membership = await this.prisma.podMember.findFirst({ where: { salesId: actorId, podId } });
      if (!membership) throw new ForbiddenException('You are not a member of this POD');
    }

    const from = new Date(fromDate);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    if (from > to) throw new BadRequestException('"From" date must be before or equal to "To" date');

    const eligible = await this.prisma.expense.findMany({
      where: {
        podId,
        settlementId: null,
        status: ExpenseStatus.SETTLED,
        expenseDate: { gte: from, lte: to },
        isMatched: true,
      },
      select: { id: true, podId: true, departmentId: true, amount: true },
    });
    if (eligible.length === 0) return { settlement: null, expenses: [] };

    const deptIds = new Set(eligible.map((e) => e.departmentId));
    const departmentId = deptIds.size === 1 ? eligible[0].departmentId ?? undefined : undefined;
    const totalAmount = eligible.reduce((sum, e) => sum + Number(e.amount), 0);
    const settlementNo = await this.generateSettlementNo();

    const settlement = await this.prisma.$transaction(async (tx) => {
      const s = await tx.settlement.create({
        data: { settlementNo, podId, departmentId, totalAmount, createdById: actorId },
      });
      await tx.expense.updateMany({
        where: { id: { in: eligible.map((e) => e.id) } },
        data: { settlementId: s.id },
      });
      return tx.settlement.findUniqueOrThrow({ where: { id: s.id }, include });
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Settlement', objectId: settlement.id, newValue: settlement });

    return { settlement, expenses: settlement.expenses };
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
