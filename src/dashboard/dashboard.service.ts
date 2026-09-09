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
  // Management/Admin/Finance) - unlike summary()/expenseByDepartment() above,
  // this is scoped to what the caller's own approval Position entitles them
  // to see: HEAD_POD -> the Department(s) they're an explicit approver for
  // (DepartmentPositionAssignment), DEPT_HEAD/DIV_HEAD -> their own Department
  // (no separate Division table - see BRD discussion), BOD -> company-wide
  // (BOD approval steps are never Department-scoped, see ApprovalsService.
  // resolveApprover's ANY branch). "Total expense" here always means
  // SETTLED-only (money actually fully approved), not every in-flight status
  // like summary()'s unfiltered totalExpense.
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
      const assignments = await this.prisma.departmentPositionAssignment.findMany({
        where: { userId: actor.userId, position: { code: 'HEAD_POD' }, status: 'ACTIVE' },
        include: { department: true },
      });
      const departmentIds = assignments.map((a) => a.departmentId);
      const agg = await this.prisma.expense.aggregate({
        where: { departmentId: { in: departmentIds }, status: ExpenseStatus.SETTLED },
        _sum: { amount: true },
      });
      return {
        positionCode,
        pendingApprovalCount,
        departments: assignments.map((a) => ({ id: a.department.id, name: a.department.name })),
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

  // dashboard.read.all / dashboard.read.owndept (Role/Permission master) scope
  // every report below by Department: undefined = no restriction (back-office
  // role or the .all permission), otherwise the caller's own Department(s)
  // (their own User.departmentId + DepartmentPositionAssignment approver
  // coverage - same dual source canAccessExpenseOwnedRecord() already uses
  // for the equivalent expense.*.owndept permissions), or [] if the caller
  // somehow holds neither (guard should have already blocked that, this is
  // just a defensive "see nothing").
  private async resolveDepartmentScope(actor: AuthUser): Promise<string[] | undefined> {
    if (canViewAllRecords(actor) || actor.permissions?.includes('dashboard.read.all')) return undefined;
    if (actor.permissions?.includes('dashboard.read.owndept')) {
      const [user, assignments] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: actor.userId }, select: { departmentId: true } }),
        this.prisma.departmentPositionAssignment.findMany({ where: { userId: actor.userId, status: 'ACTIVE' }, select: { departmentId: true } }),
      ]);
      const ids = new Set(assignments.map((a) => a.departmentId));
      if (user?.departmentId) ids.add(user.departmentId);
      return Array.from(ids);
    }
    return [];
  }

  private buildWhere(filter: PeriodFilter, departmentIds?: string[]) {
    return {
      unitId: filter.unitId,
      departmentId: departmentIds ? { in: departmentIds } : undefined,
      expenseDate: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  async summary(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);

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

  // Department = an org department AND/OR a named coverage group covering one
  // or more Sales (BRD section 6.2) - grouped by Expense.departmentId,
  // matching the requested "DEPARTMENT | TRANSACTION | TOTAL" report shape.
  async expenseByDepartment(actor: AuthUser, filter: PeriodFilter) {
    const scopedDepartmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter);
    const grouped = await this.prisma.expense.groupBy({
      by: ['departmentId'],
      where: { ...where, departmentId: scopedDepartmentIds ? { in: scopedDepartmentIds } : { not: null } },
      _sum: { amount: true },
      _count: true,
    });

    const departmentIds = grouped.map((g) => g.departmentId).filter((id): id is string => !!id);
    const departments = await this.prisma.department.findMany({
      where: { id: { in: departmentIds } },
      include: { users: { select: { name: true } } },
    });
    const departmentMap = new Map(departments.map((d) => [d.id, d]));

    return grouped.map((g) => {
      const department = departmentMap.get(g.departmentId as string);
      return {
        id: g.departmentId,
        name: department?.name ?? '-',
        sales: department?.users.map((u) => u.name).join(', ') || '-',
        totalExpense: g._sum.amount ?? 0,
        transactionCount: g._count,
      };
    });
  }

  async expenseByMonth(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);
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
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);
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
