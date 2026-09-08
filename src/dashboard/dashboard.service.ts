import { Injectable } from '@nestjs/common';
import { ExpenseStatus, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords } from '../common/rbac/scope.util';

export interface PeriodFilter {
  from?: string;
  to?: string;
  unitId?: string;
}

// Management Dashboard (BRD section 37)
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
  ) {}

  // Personal landing-page dashboard (any authenticated user, not just
  // Management/Admin/Finance) - unlike summary()/expenseByPod() above, this is
  // scoped to what the caller's own approval Position entitles them to see:
  // HEAD_POD -> their POD(s) (PodPositionAssignment), DEPT_HEAD/DIV_HEAD ->
  // their own Department (no separate Division table - see BRD discussion),
  // BOD -> company-wide (BOD approval steps are never POD/Department-scoped,
  // see ApprovalsService.resolveApprover's ANY branch). "Total expense" here
  // always means SETTLED-only (money actually fully approved), not every
  // in-flight status like summary()'s unfiltered totalExpense.
  async getMyDashboard(actor: AuthUser) {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      include: { position: true, department: true },
    });
    const positionCode = user?.position?.code ?? null;
    const pending = await this.approvals.findPendingFor(actor.userId, actor.permissions);
    // For BOD, findPendingFor also includes requests still waiting on an
    // earlier approver (read-only lookahead - see its isMyTurn flag) - the
    // dashboard count must stay "actionable right now", so filter those out.
    const pendingApprovalCount = pending.filter((p) => p.isMyTurn).length;

    if (positionCode === 'HEAD_POD') {
      const assignments = await this.prisma.podPositionAssignment.findMany({
        where: { userId: actor.userId, position: { code: 'HEAD_POD' }, status: 'ACTIVE' },
        include: { pod: true },
      });
      const podIds = assignments.map((a) => a.podId);
      const agg = await this.prisma.expense.aggregate({
        where: { podId: { in: podIds }, status: ExpenseStatus.SETTLED },
        _sum: { amount: true },
      });
      return {
        positionCode,
        pendingApprovalCount,
        pods: assignments.map((a) => ({ id: a.pod.id, name: a.pod.name })),
        totalSettledAmount: agg._sum.amount ?? 0,
      };
    }

    if (positionCode === 'DEPT_HEAD' || positionCode === 'DIV_HEAD') {
      const agg = await this.prisma.expense.aggregate({
        where: { departmentId: user?.departmentId ?? undefined, status: ExpenseStatus.SETTLED },
        _sum: { amount: true },
      });
      return {
        positionCode,
        pendingApprovalCount,
        department: user?.department ? { id: user.department.id, name: user.department.name } : null,
        totalSettledAmount: agg._sum.amount ?? 0,
      };
    }

    if (positionCode === 'BOD') {
      const [expenseAgg, approvedSettlementCount] = await Promise.all([
        this.prisma.expense.aggregate({ where: { status: ExpenseStatus.SETTLED }, _sum: { amount: true }, _count: true }),
        this.prisma.settlement.count({ where: { status: SettlementStatus.COMPLETE } }),
      ]);
      return {
        positionCode,
        pendingApprovalCount,
        totalSettledAmount: expenseAgg._sum.amount ?? 0,
        approvedExpenseCount: expenseAgg._count,
        approvedSettlementCount,
      };
    }

    return { positionCode, pendingApprovalCount };
  }

  // dashboard.read.all / dashboard.read.ownpod (Role/Permission master) scope
  // every report below by POD: undefined = no restriction (back-office role or
  // the .all permission), otherwise the caller's own PODs (PodMember team
  // coverage + PodPositionAssignment approver coverage - same dual source
  // canAccessExpenseOwnedRecord() already uses for the equivalent expense.*.ownpod
  // permissions), or [] if the caller somehow holds neither (guard should have
  // already blocked that, this is just a defensive "see nothing").
  private async resolvePodScope(actor: AuthUser): Promise<string[] | undefined> {
    if (canViewAllRecords(actor) || actor.permissions?.includes('dashboard.read.all')) return undefined;
    if (actor.permissions?.includes('dashboard.read.ownpod')) {
      const [memberships, assignments] = await Promise.all([
        this.prisma.podMember.findMany({ where: { salesId: actor.userId }, select: { podId: true } }),
        this.prisma.podPositionAssignment.findMany({ where: { userId: actor.userId, status: 'ACTIVE' }, select: { podId: true } }),
      ]);
      return Array.from(new Set([...memberships.map((m) => m.podId), ...assignments.map((a) => a.podId)]));
    }
    return [];
  }

  private buildWhere(filter: PeriodFilter, podIds?: string[]) {
    return {
      unitId: filter.unitId,
      podId: podIds ? { in: podIds } : undefined,
      expenseDate: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  async summary(actor: AuthUser, filter: PeriodFilter) {
    const podIds = await this.resolvePodScope(actor);
    const where = this.buildWhere(filter, podIds);

    const [totalAgg, statusCounts] = await Promise.all([
      this.prisma.expense.aggregate({ where, _sum: { amount: true }, _count: true, _avg: { amount: true } }),
      this.prisma.expense.groupBy({ by: ['status'], where, _count: true }),
    ]);

    const countByStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count])) as Record<ExpenseStatus, number>;
    // "Pending" spans every per-tier APPROVAL_<position> status (see ApprovalsService.
    // pendingStatusForPosition) plus the generic PENDING_APPROVAL fallback - status is
    // no longer ever a single fixed value while an Expense is mid-chain.
    const pendingCount = Object.entries(countByStatus).reduce(
      (sum, [status, count]) => (status === 'PENDING_APPROVAL' || status.startsWith('APPROVAL_') ? sum + count : sum),
      0,
    );

    return {
      totalExpense: totalAgg._sum.amount ?? 0,
      totalTransaction: totalAgg._count,
      averageExpense: totalAgg._avg.amount ?? 0,
      approved: (countByStatus.APPROVED ?? 0) + (countByStatus.SETTLED ?? 0),
      pending: pendingCount,
      rejected: countByStatus.REJECTED ?? 0,
      draft: countByStatus.DRAFT ?? 0,
    };
  }

  async expenseByUnit(actor: AuthUser, filter: PeriodFilter) {
    return this.groupByRelation(actor, filter, 'unitId', 'unit');
  }

  async expenseBySales(actor: AuthUser, filter: PeriodFilter) {
    return this.groupByRelation(actor, filter, 'salesId', 'sales');
  }

  async expenseByAdvertiser(actor: AuthUser, filter: PeriodFilter) {
    return this.groupByRelation(actor, filter, 'advertiserId', 'advertiser');
  }

  async expenseByBrand(actor: AuthUser, filter: PeriodFilter) {
    return this.groupByRelation(actor, filter, 'brandId', 'brand');
  }

  // POD = a named coverage group covering one or more Sales (BRD section 6.2) -
  // grouped by Expense.podId, matching the requested "POD | TRANSACTION | TOTAL" report shape.
  async expenseByPod(actor: AuthUser, filter: PeriodFilter) {
    const scopedPodIds = await this.resolvePodScope(actor);
    const where = this.buildWhere(filter);
    const grouped = await this.prisma.expense.groupBy({
      by: ['podId'],
      where: { ...where, podId: scopedPodIds ? { in: scopedPodIds } : { not: null } },
      _sum: { amount: true },
      _count: true,
    });

    const podIds = grouped.map((g) => g.podId).filter((id): id is string => !!id);
    const pods = await this.prisma.pod.findMany({
      where: { id: { in: podIds } },
      include: { members: { include: { sales: { select: { name: true } } } } },
    });
    const podMap = new Map(pods.map((p) => [p.id, p]));

    return grouped.map((g) => {
      const pod = podMap.get(g.podId as string);
      return {
        id: g.podId,
        name: pod?.name ?? '-',
        sales: pod?.members.map((m) => m.sales.name).join(', ') || '-',
        totalExpense: g._sum.amount ?? 0,
        transactionCount: g._count,
      };
    });
  }

  async expenseByMonth(actor: AuthUser, filter: PeriodFilter) {
    const podIds = await this.resolvePodScope(actor);
    const where = this.buildWhere(filter, podIds);
    const expenses = await this.prisma.expense.findMany({ where, select: { expenseDate: true, amount: true } });
    const byMonth = new Map<string, { total: number; count: number }>();
    for (const e of expenses) {
      const key = `${e.expenseDate.getFullYear()}-${String(e.expenseDate.getMonth() + 1).padStart(2, '0')}`;
      const bucket = byMonth.get(key) ?? { total: 0, count: 0 };
      bucket.total += Number(e.amount);
      bucket.count += 1;
      byMonth.set(key, bucket);
    }
    return Array.from(byMonth.entries())
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  private async groupByRelation(
    actor: AuthUser,
    filter: PeriodFilter,
    fkField: 'unitId' | 'salesId' | 'advertiserId' | 'brandId',
    label: string,
  ) {
    const podIds = await this.resolvePodScope(actor);
    const where = this.buildWhere(filter, podIds);
    const grouped = await this.prisma.expense.groupBy({
      by: [fkField],
      where,
      _sum: { amount: true },
      _count: true,
    });

    const ids = grouped.map((g) => g[fkField]).filter((id): id is string => !!id);
    const nameMap = await this.resolveNames(label, ids);

    return grouped.map((g) => ({
      id: g[fkField],
      name: nameMap.get(g[fkField] as string) ?? g[fkField],
      totalExpense: g._sum.amount ?? 0,
      transactionCount: g._count,
    }));
  }

  private async resolveNames(label: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    switch (label) {
      case 'unit': {
        const rows = await this.prisma.unit.findMany({ where: { id: { in: ids } } });
        return new Map(rows.map((r) => [r.id, r.name]));
      }
      case 'sales': {
        const rows = await this.prisma.user.findMany({ where: { id: { in: ids } } });
        return new Map(rows.map((r) => [r.id, r.name]));
      }
      case 'advertiser': {
        const rows = await this.prisma.advertiser.findMany({ where: { id: { in: ids } } });
        return new Map(rows.map((r) => [r.id, r.name]));
      }
      case 'brand': {
        const rows = await this.prisma.brand.findMany({ where: { id: { in: ids } } });
        return new Map(rows.map((r) => [r.id, r.name]));
      }
      default:
        return new Map();
    }
  }
}
