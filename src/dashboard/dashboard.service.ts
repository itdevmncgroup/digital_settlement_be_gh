import { Injectable } from '@nestjs/common';
import { ExpenseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface PeriodFilter {
  from?: string;
  to?: string;
  unitId?: string;
}

// Management Dashboard (BRD section 37)
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: PeriodFilter) {
    return {
      unitId: filter.unitId,
      expenseDate: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  async summary(filter: PeriodFilter) {
    const where = this.buildWhere(filter);

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

  async expenseByUnit(filter: PeriodFilter) {
    return this.groupByRelation(filter, 'unitId', 'unit');
  }

  async expenseBySales(filter: PeriodFilter) {
    return this.groupByRelation(filter, 'salesId', 'sales');
  }

  async expenseByAdvertiser(filter: PeriodFilter) {
    return this.groupByRelation(filter, 'advertiserId', 'advertiser');
  }

  async expenseByBrand(filter: PeriodFilter) {
    return this.groupByRelation(filter, 'brandId', 'brand');
  }

  // POD = a named coverage group covering one or more Sales (BRD section 6.2) -
  // grouped by Expense.podId, matching the requested "POD | TRANSACTION | TOTAL" report shape.
  async expenseByPod(filter: PeriodFilter) {
    const where = this.buildWhere(filter);
    const grouped = await this.prisma.expense.groupBy({
      by: ['podId'],
      where: { ...where, podId: { not: null } },
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

  async expenseByMonth(filter: PeriodFilter) {
    const where = this.buildWhere(filter);
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

  private async groupByRelation(filter: PeriodFilter, fkField: 'unitId' | 'salesId' | 'advertiserId' | 'brandId', label: string) {
    const where = this.buildWhere(filter);
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
