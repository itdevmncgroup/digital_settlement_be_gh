import { Injectable } from '@nestjs/common';
import { ExpenseStatus, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords, getActorDepartmentIds } from '../common/rbac/scope.util';
import { RoleName } from '../common/constants/role-name';

export interface PeriodFilter {
  from?: string;
  to?: string;
  unitId?: string;
  departmentId?: string;
  categoryId?: string;
  status?: string;
}

export interface SettlementPeriodFilter {
  from?: string;
  to?: string;
  departmentId?: string;
  submitterId?: string;
  status?: string;
}

const SETTLEMENT_WAITING_STATUSES: SettlementStatus[] = [
  SettlementStatus.APPROVAL_SLS_MAR_DIR,
  SettlementStatus.APPROVAL_VP_ACC_BIL_TAX_3TV,
  SettlementStatus.APPROVAL_CO_CFO_3TV,
];

// One entry per Settlement-chain tier (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV ->
// CO_CFO_3TV, see CLAUDE.md) - order here is display/level order (Level 1..3).
const SETTLEMENT_TIER_KEYS = ['APPROVAL_SLS_MAR_DIR', 'APPROVAL_VP_ACC_BIL_TAX_3TV', 'APPROVAL_CO_CFO_3TV'] as const;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Shared by expenseByAgency()/expenseByAdvertiser(): whichever Sales
// contributed the most amount within a bucket, used as that bucket's "PIC"
// subtitle.
function topContributorName(sales: Map<string, { name: string; amount: number }>): string | undefined {
  return Array.from(sales.values()).sort((a, b) => b.amount - a.amount)[0]?.name;
}

// Same set summary()'s pendingCount reduce already treats as "mid approval
// chain" (PENDING_APPROVAL generic fallback + every per-tier APPROVAL_<code>
// value) - lifted out so the Pending Approval stat card's count+amount
// aggregate can filter on it directly instead of re-deriving from groupBy.
const PENDING_APPROVAL_STATUSES: ExpenseStatus[] = [
  ExpenseStatus.PENDING_APPROVAL,
  ExpenseStatus.APPROVAL_HEAD_POD,
  ExpenseStatus.APPROVAL_KOORDINATOR,
  ExpenseStatus.APPROVAL_SUPERVISOR,
  ExpenseStatus.APPROVAL_DEPT_HEAD,
  ExpenseStatus.APPROVAL_DIV_HEAD,
  ExpenseStatus.APPROVAL_BOD,
  ExpenseStatus.APPROVAL_CO_CSO_1,
  ExpenseStatus.APPROVAL_CO_CSO_2,
  ExpenseStatus.APPROVAL_SLS_MAR_DIR,
  ExpenseStatus.APPROVAL_VP_ACC_BIL_TAX_3TV,
  ExpenseStatus.APPROVAL_CO_CFO_3TV,
];

// Every ExpenseStatus that means "actively moving through a review chain" -
// used for the mobile dashboard's "Total Expense Pending" count. Deliberately
// excludes DRAFT/REVISION (= "incomplete", still with Sales) and every
// terminal value (COMPLETE/REJECTED/APPROVED/SETTLED - the last two legacy).
const PENDING_REVIEW_STATUSES: ExpenseStatus[] = [
  ExpenseStatus.SUBMITTED,
  ExpenseStatus.PENDING_APPROVAL,
  ExpenseStatus.PROCESSING,
  ExpenseStatus.OCR_COMPLETED,
  ExpenseStatus.MATCHING,
  ExpenseStatus.NEEDS_REVIEW,
  ExpenseStatus.READY_TO_SUBMIT,
  ExpenseStatus.READY_TO_MATCHING,
  ExpenseStatus.READY_TO_SETTLED,
  ExpenseStatus.APPROVAL_HEAD_POD,
  ExpenseStatus.APPROVAL_KOORDINATOR,
  ExpenseStatus.APPROVAL_SUPERVISOR,
  ExpenseStatus.APPROVAL_DEPT_HEAD,
  ExpenseStatus.APPROVAL_DIV_HEAD,
  ExpenseStatus.APPROVAL_BOD,
  ExpenseStatus.APPROVAL_CO_CSO_1,
  ExpenseStatus.APPROVAL_CO_CSO_2,
  ExpenseStatus.APPROVAL_SLS_MAR_DIR,
  ExpenseStatus.APPROVAL_VP_ACC_BIL_TAX_3TV,
  ExpenseStatus.APPROVAL_CO_CFO_3TV,
];

// Statuses shown as "Review Expense" in the recent-activity feed - still with
// Sales/Finance before it ever reaches an approval tier proper.
const IN_REVIEW_STATUSES: ExpenseStatus[] = [
  ExpenseStatus.SUBMITTED,
  ExpenseStatus.PROCESSING,
  ExpenseStatus.OCR_COMPLETED,
  ExpenseStatus.MATCHING,
  ExpenseStatus.NEEDS_REVIEW,
  ExpenseStatus.READY_TO_SUBMIT,
];

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
      include: { position: true, departments: { where: { status: 'ACTIVE' }, include: { department: true } } },
    });
    const positionCode = user?.position?.code ?? null;
    const userDepartmentIds = user?.departments.map((d) => d.departmentId) ?? [];
    const pending = await this.approvals.findPendingFor(actor.userId, actor.permissions);
    // For BOD, findPendingFor also includes requests still waiting on an
    // earlier approver (read-only lookahead - see its isMyTurn flag) - the
    // dashboard count must stay "actionable right now", so filter those out.
    const pendingApprovalCount = pending.filter((p) => p.isMyTurn).length;

    // "jumlah expense" dashboard stat: sum of Expense.amount whose Settlement has
    // reached COMPLETE. SALES/SALES_ADMIN and HEAD_POD only see their own pod(s)
    // (Department); every other role (ADMIN etc.) sees the company-wide total.
    const isPodRestricted =
      positionCode === 'HEAD_POD' ||
      (actor.roles ?? []).some((r) => r === RoleName.SALES || r === RoleName.SALES_ADMIN);

    let headPodAssignments: { departmentId: string; department: { id: string; name: string } }[] = [];
    let podDepartmentIds: string[] = [];
    if (positionCode === 'HEAD_POD') {
      headPodAssignments = await this.prisma.departmentPositionAssignment.findMany({
        where: { userId: actor.userId, position: { code: 'HEAD_POD' }, status: 'ACTIVE' },
        include: { department: true },
      });
      podDepartmentIds = headPodAssignments.map((a) => a.departmentId);
    } else if (isPodRestricted) {
      podDepartmentIds = userDepartmentIds;
    }

    const expenseAmountAgg = await this.prisma.expense.aggregate({
      where: {
        departmentId: isPodRestricted ? { in: podDepartmentIds } : undefined,
        settlement: { status: SettlementStatus.COMPLETE },
      },
      _sum: { amount: true },
    });
    const totalExpenseAmount = expenseAmountAgg._sum.amount ?? 0;

    // Home-screen stat cards + charts (BRD "Dashboard Keuangan" mock): same
    // department scope as the "jumlah expense" stat above, computed once and
    // merged into every position branch below so the shape stays uniform
    // regardless of positionCode.
    const departmentScopeIds = isPodRestricted ? podDepartmentIds : undefined;
    const departmentScopeWhere = departmentScopeIds ? { in: departmentScopeIds } : undefined;
    const [incompleteAgg, completeAgg, pendingReviewCount, expenseByDepartment, recentActivity] = await Promise.all([
      this.prisma.expense.aggregate({
        where: { departmentId: departmentScopeWhere, status: { in: [ExpenseStatus.DRAFT, ExpenseStatus.REVISION] } },
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: { departmentId: departmentScopeWhere, status: ExpenseStatus.COMPLETE },
        _sum: { amount: true },
      }),
      this.prisma.expense.count({ where: { departmentId: departmentScopeWhere, status: { in: PENDING_REVIEW_STATUSES } } }),
      this.getExpenseByDepartment(departmentScopeIds),
      this.getRecentActivity(departmentScopeIds),
    ]);
    const dashboardExtras = {
      totalExpenseIncompleteAmount: incompleteAgg._sum.amount ?? 0,
      totalExpenseCompleteAmount: completeAgg._sum.amount ?? 0,
      totalExpensePendingCount: pendingReviewCount,
      expenseByDepartment,
      recentActivity,
    };

    if (positionCode === 'HEAD_POD') {
      const agg = await this.prisma.expense.aggregate({
        where: { departmentId: { in: podDepartmentIds }, status: ExpenseStatus.SETTLED },
        _sum: { amount: true },
      });
      return {
        positionCode,
        pendingApprovalCount,
        departments: headPodAssignments.map((a) => ({ id: a.department.id, name: a.department.name })),
        totalSettledAmount: agg._sum.amount ?? 0,
        totalExpenseAmount,
        ...dashboardExtras,
      };
    }

    if (positionCode === 'DEPT_HEAD' || positionCode === 'DIV_HEAD') {
      const agg = await this.prisma.expense.aggregate({
        where: { departmentId: { in: userDepartmentIds }, status: ExpenseStatus.SETTLED },
        _sum: { amount: true },
      });
      return {
        positionCode,
        pendingApprovalCount,
        departments: (user?.departments ?? []).map((d) => ({ id: d.department.id, name: d.department.name })),
        totalSettledAmount: agg._sum.amount ?? 0,
        totalExpenseAmount,
        ...dashboardExtras,
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
        totalExpenseAmount,
        ...dashboardExtras,
      };
    }

    return { positionCode, pendingApprovalCount, totalExpenseAmount, ...dashboardExtras };
  }

  // Two department-count breakdowns for the mobile dashboard's bar charts:
  // "incomplete" (DRAFT/REVISION, still with Sales) vs "complete" (COMPLETE,
  // fully settled) - scoped the same way as the caller's other stats.
  private async getExpenseByDepartment(departmentIds?: string[]) {
    const scopeWhere = departmentIds ? { in: departmentIds } : { not: null };
    const [incomplete, complete] = await Promise.all([
      this.prisma.expense.groupBy({
        by: ['departmentId'],
        where: { departmentId: scopeWhere, status: { in: [ExpenseStatus.DRAFT, ExpenseStatus.REVISION] } },
        _count: true,
      }),
      this.prisma.expense.groupBy({
        by: ['departmentId'],
        where: { departmentId: scopeWhere, status: ExpenseStatus.COMPLETE },
        _count: true,
      }),
    ]);

    const ids = [...new Set([...incomplete, ...complete].map((g) => g.departmentId).filter((id): id is string => !!id))];
    if (ids.length === 0) return [];
    const departments = await this.prisma.department.findMany({ where: { id: { in: ids } } });
    const nameMap = new Map(departments.map((d) => [d.id, d.name]));
    const incompleteMap = new Map(incomplete.map((g) => [g.departmentId as string, g._count]));
    const completeMap = new Map(complete.map((g) => [g.departmentId as string, g._count]));

    return ids
      .map((id) => ({
        departmentId: id,
        departmentName: nameMap.get(id) ?? '-',
        incompleteCount: incompleteMap.get(id) ?? 0,
        completeCount: completeMap.get(id) ?? 0,
      }))
      .sort((a, b) => b.incompleteCount + b.completeCount - (a.incompleteCount + a.completeCount));
  }

  // "Aktivitas Terkini" feed: latest CREATE/UPDATE/APPROVE/REJECT AuditLog
  // entries on Expense, hydrated against the *current* Expense row (the log's
  // own newValue snapshot doesn't always carry amount/department - e.g. the
  // APPROVE/REJECT actions in ApprovalsService only log step metadata) and
  // filtered to the caller's department scope. One entry per Expense (its
  // most recent action only), newest first.
  private async getRecentActivity(departmentIds?: string[], limit = 10) {
    const logs = await this.prisma.auditLog.findMany({
      where: { objectType: 'Expense', objectId: { not: null }, action: { in: ['CREATE', 'UPDATE', 'APPROVE', 'REJECT'] } },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });
    if (logs.length === 0) return [];

    const expenseIds = [...new Set(logs.map((l) => l.objectId as string))];
    const expenses = await this.prisma.expense.findMany({
      where: { id: { in: expenseIds }, departmentId: departmentIds ? { in: departmentIds } : undefined },
      select: { id: true, purpose: true, amount: true, status: true, department: { select: { name: true } } },
    });
    const expenseMap = new Map(expenses.map((e) => [e.id, e]));

    const seen = new Set<string>();
    const result: {
      id: string;
      expenseId: string;
      title: string;
      purpose: string;
      amount: number;
      departmentName: string | null;
      status: ExpenseStatus;
      timestamp: Date;
    }[] = [];
    for (const log of logs) {
      const expense = expenseMap.get(log.objectId as string);
      if (!expense || seen.has(expense.id)) continue;
      seen.add(expense.id);
      result.push({
        id: log.id,
        expenseId: expense.id,
        title: this.activityTitle(log.action, expense.status),
        purpose: expense.purpose,
        amount: Number(expense.amount),
        departmentName: expense.department?.name ?? null,
        status: expense.status,
        timestamp: log.timestamp,
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  private activityTitle(action: string, status: ExpenseStatus): string {
    if (status === ExpenseStatus.REVISION) return 'Revisi Expense';
    if (status === ExpenseStatus.REJECTED) return 'Expense Ditolak';
    if (status === ExpenseStatus.COMPLETE) return 'Persetujuan Final';
    if (action === 'APPROVE') return 'Persetujuan';
    if (IN_REVIEW_STATUSES.includes(status)) return 'Review Expense';
    if (status === ExpenseStatus.DRAFT) return 'Expense Baru';
    return 'Update Expense';
  }

  // dashboard.read.all / dashboard.read.owndept (Role/Permission master) scope
  // every report below by Department: undefined = no restriction (back-office
  // role or the .all permission), otherwise the caller's own Department(s)
  // (their own UserDepartment membership(s) + DepartmentPositionAssignment approver
  // coverage - same dual source canAccessExpenseOwnedRecord() already uses
  // for the equivalent expense.*.owndept permissions), or [] if the caller
  // somehow holds neither (guard should have already blocked that, this is
  // just a defensive "see nothing").
  private async resolveDepartmentScope(actor: AuthUser): Promise<string[] | undefined> {
    if (canViewAllRecords(actor) || actor.permissions?.includes('dashboard.read.all')) return undefined;
    if (actor.permissions?.includes('dashboard.read.owndept')) {
      return getActorDepartmentIds(this.prisma, actor.userId);
    }
    return [];
  }

  // filter.departmentId (the dashboard's own POD picker) intersects with the
  // caller's permission-derived departmentIds scope (dashboard.read.owndept) -
  // picking a POD outside that scope must yield zero rows, never fall back to
  // "unscoped".
  private buildWhere(filter: PeriodFilter, departmentIds?: string[]) {
    let departmentWhere: string | { in: string[] } | undefined;
    if (filter.departmentId) {
      departmentWhere = departmentIds && !departmentIds.includes(filter.departmentId) ? { in: [] } : filter.departmentId;
    } else {
      departmentWhere = departmentIds ? { in: departmentIds } : undefined;
    }

    return {
      unitId: filter.unitId,
      departmentId: departmentWhere,
      status: filter.status ? (filter.status as ExpenseStatus) : undefined,
      // Category lives on ExpenseItem, not Expense - "an Expense in this
      // category" means it has at least one item tagged with it.
      items: filter.categoryId ? { some: { categoryId: filter.categoryId } } : undefined,
      expenseDate: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  async summary(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);
    // Status-breakdown cards (approved/pending/rejected/draft counts + the new
    // Pending Approval/Rejected amount cards) stay meaningful even when the
    // caller picked one specific status in the filter bar - only the headline
    // totals (totalExpense/totalTransaction/averageExpense) and Highest
    // Expense POD narrow to that one status.
    const baseWhere = this.buildWhere({ ...filter, status: undefined }, departmentIds);

    const [totalAgg, statusCounts, highestPodGroup, pendingAgg, rejectedAgg] = await Promise.all([
      this.prisma.expense.aggregate({ where, _sum: { amount: true }, _count: true, _avg: { amount: true } }),
      this.prisma.expense.groupBy({ by: ['status'], where: baseWhere, _count: true }),
      this.prisma.expense.groupBy({
        by: ['departmentId'],
        where: { ...where, departmentId: { not: null } },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 1,
      }),
      this.prisma.expense.aggregate({
        where: { ...baseWhere, status: { in: PENDING_APPROVAL_STATUSES } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.expense.aggregate({
        where: { ...baseWhere, status: ExpenseStatus.REJECTED },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const countByStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count])) as Record<ExpenseStatus, number>;
    // "Pending" spans every per-tier APPROVAL_<position> status (see ApprovalsService.
    // pendingStatusForPosition) plus the generic PENDING_APPROVAL fallback - status is
    // no longer ever a single fixed value while an Expense is mid-chain.
    const pendingCount = Object.entries(countByStatus).reduce(
      (sum, [status, count]) => (status === 'PENDING_APPROVAL' || status.startsWith('APPROVAL_') ? sum + count : sum),
      0,
    );

    const topPod = highestPodGroup[0];
    let highestExpensePod: { id: string; name: string; totalExpense: number } | null = null;
    if (topPod?.departmentId) {
      const dept = await this.prisma.department.findUnique({ where: { id: topPod.departmentId } });
      highestExpensePod = { id: topPod.departmentId, name: dept?.name ?? '-', totalExpense: Number(topPod._sum.amount ?? 0) };
    }

    // "vs previous period" deltas (headline KPI cards) - only well-defined once
    // the caller picked an explicit from/to window, mirroring
    // settlementSummary()'s equivalent block: same window length, shifted to
    // end the instant before `from`.
    let previous: { totalExpense: number; totalTransaction: number; averageExpense: number } | null = null;
    if (filter.from && filter.to) {
      const from = new Date(filter.from);
      const to = new Date(filter.to);
      const durationMs = to.getTime() - from.getTime();
      const prevTo = new Date(from.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - durationMs);
      const prevWhere = this.buildWhere({ ...filter, from: prevFrom.toISOString(), to: prevTo.toISOString() }, departmentIds);
      const prevAgg = await this.prisma.expense.aggregate({ where: prevWhere, _sum: { amount: true }, _count: true, _avg: { amount: true } });
      previous = {
        totalExpense: Number(prevAgg._sum.amount ?? 0),
        totalTransaction: prevAgg._count,
        averageExpense: Number(prevAgg._avg.amount ?? 0),
      };
    }

    return {
      totalExpense: totalAgg._sum.amount ?? 0,
      totalTransaction: totalAgg._count,
      averageExpense: totalAgg._avg.amount ?? 0,
      approved: (countByStatus.APPROVED ?? 0) + (countByStatus.SETTLED ?? 0),
      pending: pendingCount,
      rejected: countByStatus.REJECTED ?? 0,
      draft: countByStatus.DRAFT ?? 0,
      highestExpensePod,
      pendingApprovalCount: pendingAgg._count,
      pendingApprovalAmount: pendingAgg._sum.amount ?? 0,
      rejectedCount: rejectedAgg._count,
      rejectedAmount: rejectedAgg._sum.amount ?? 0,
      previous,
    };
  }

  async expenseByUnit(actor: AuthUser, filter: PeriodFilter) {
    return this.groupByRelation(actor, filter, 'unitId', 'unit');
  }

  async expenseBySales(actor: AuthUser, filter: PeriodFilter) {
    return this.groupByRelation(actor, filter, 'salesId', 'sales');
  }

  // "Expense by Advertiser & PIC": grouped by advertiserId, subtitle names
  // whichever Sales contributed the most amount to that Advertiser (its "PIC"
  // for this report) - same top-contributor pattern as expenseByAgency()/
  // settlementByPod() below.
  async expenseByAdvertiser(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);
    const expenses = await this.prisma.expense.findMany({
      where,
      select: {
        amount: true,
        advertiserId: true,
        advertiser: { select: { name: true } },
        sales: { select: { id: true, name: true } },
      },
    });
    if (expenses.length === 0) return [];

    const byAdvertiser = new Map<string, { name: string; totalExpense: number; transactionCount: number; sales: Map<string, { name: string; amount: number }> }>();
    for (const e of expenses) {
      if (!e.advertiserId || !e.advertiser) continue;
      const bucket = byAdvertiser.get(e.advertiserId) ?? { name: e.advertiser.name, totalExpense: 0, transactionCount: 0, sales: new Map() };
      bucket.totalExpense += Number(e.amount);
      bucket.transactionCount += 1;
      if (e.sales) {
        const s = bucket.sales.get(e.sales.id) ?? { name: e.sales.name, amount: 0 };
        s.amount += Number(e.amount);
        bucket.sales.set(e.sales.id, s);
      }
      byAdvertiser.set(e.advertiserId, bucket);
    }

    return Array.from(byAdvertiser.entries())
      .map(([id, v]) => ({
        id,
        name: v.name,
        subtitle: topContributorName(v.sales),
        totalExpense: v.totalExpense,
        transactionCount: v.transactionCount,
      }))
      .sort((a, b) => b.totalExpense - a.totalExpense);
  }

  // Expense has no direct agencyId (only advertiserId, mandatory) - Agency is
  // one hop up the Agency->Advertiser->Brand ownership chain, so this groups
  // by advertiserId first, then re-buckets by each Advertiser's agencyId.
  // Subtitle names whichever Sales contributed the most amount to that Agency
  // (its "PIC" for this report), same top-contributor pattern as
  // expenseByAdvertiser() above.
  async expenseByAgency(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);
    const expenses = await this.prisma.expense.findMany({
      where,
      select: {
        amount: true,
        sales: { select: { id: true, name: true } },
        advertiser: { select: { agencyId: true, agency: { select: { name: true } } } },
      },
    });
    if (expenses.length === 0) return [];

    const byAgency = new Map<string, { name: string; totalExpense: number; transactionCount: number; sales: Map<string, { name: string; amount: number }> }>();
    for (const e of expenses) {
      if (!e.advertiser) continue;
      const agencyId = e.advertiser.agencyId;
      const bucket = byAgency.get(agencyId) ?? { name: e.advertiser.agency.name, totalExpense: 0, transactionCount: 0, sales: new Map() };
      bucket.totalExpense += Number(e.amount);
      bucket.transactionCount += 1;
      if (e.sales) {
        const s = bucket.sales.get(e.sales.id) ?? { name: e.sales.name, amount: 0 };
        s.amount += Number(e.amount);
        bucket.sales.set(e.sales.id, s);
      }
      byAgency.set(agencyId, bucket);
    }

    return Array.from(byAgency.entries())
      .map(([id, v]) => ({
        id,
        name: v.name,
        subtitle: topContributorName(v.sales),
        totalExpense: v.totalExpense,
        transactionCount: v.transactionCount,
      }))
      .sort((a, b) => b.totalExpense - a.totalExpense);
  }

  // Category lives on ExpenseItem (an Expense can carry items under several
  // categories), so this groups ExpenseItem by categoryId, filtered through
  // its parent Expense's scope/date/pod (categoryId itself is ignored even if
  // present in filter - it would collapse the breakdown to one bucket).
  async expenseByCategory(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const expenseWhere = this.buildWhere({ ...filter, categoryId: undefined }, departmentIds);
    const grouped = await this.prisma.expenseItem.groupBy({
      by: ['categoryId'],
      where: { expense: expenseWhere },
      _sum: { amount: true },
      _count: true,
    });
    if (grouped.length === 0) return [];

    const categoryIds = grouped.map((g) => g.categoryId).filter((id): id is string => !!id);
    const categories = await this.prisma.expenseCategory.findMany({ where: { id: { in: categoryIds } } });
    const nameMap = new Map(categories.map((c) => [c.id, c.name]));

    return grouped
      .map((g) => ({
        id: g.categoryId ?? 'uncategorized',
        name: g.categoryId ? nameMap.get(g.categoryId) ?? '-' : 'Uncategorized',
        totalExpense: g._sum.amount ?? 0,
        transactionCount: g._count,
      }))
      .sort((a, b) => Number(b.totalExpense) - Number(a.totalExpense));
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
      include: { memberships: { where: { status: 'ACTIVE' }, include: { user: { select: { name: true } } } } },
    });
    const departmentMap = new Map(departments.map((d) => [d.id, d]));

    return grouped.map((g) => {
      const department = departmentMap.get(g.departmentId as string);
      return {
        id: g.departmentId,
        name: department?.name ?? '-',
        sales: department?.memberships.map((m) => m.user.name).join(', ') || '-',
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

  // Recent Transactions table (dashboard). Agency isn't a direct Expense
  // column - resolved via advertiser.agency same as expenseByAgency(). An
  // Expense's "category" is really its items' categories (0..n) - joined into
  // one display string since the table has a single Category column.
  async recentTransactions(actor: AuthUser, filter: PeriodFilter, limit = 10) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere(filter, departmentIds);
    const expenses = await this.prisma.expense.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      take: limit,
      select: {
        id: true,
        expenseNo: true,
        expenseDate: true,
        amount: true,
        status: true,
        sales: { select: { name: true } },
        department: { select: { name: true } },
        advertiser: { select: { name: true, agency: { select: { name: true } } } },
        items: { select: { category: { select: { name: true } } } },
      },
    });

    return expenses.map((e) => ({
      id: e.id,
      expenseNo: e.expenseNo,
      expenseDate: e.expenseDate,
      salesName: e.sales?.name ?? '-',
      departmentName: e.department?.name ?? '-',
      agencyName: e.advertiser?.agency?.name ?? '-',
      advertiserName: e.advertiser?.name ?? '-',
      categoryNames: [...new Set(e.items.map((it) => it.category?.name).filter((n): n is string => !!n))].join(', ') || '-',
      amount: e.amount,
      status: e.status,
    }));
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

  // ---------------------------------------------------------------------
  // Settlement Dashboard - mirrors the Expense Dashboard's shape/filtering
  // conventions above, but over the Settlement model and its own tier chain
  // (SLS_MAR_DIR -> VP_ACC_BIL_TAX_3TV -> CO_CFO_3TV) instead of Expense's.
  // ---------------------------------------------------------------------

  // Same POD-intersect-with-owndept-scope rule as buildWhere() - picking a POD
  // outside the caller's scope yields zero rows rather than falling back to
  // "unscoped".
  private buildSettlementWhere(filter: SettlementPeriodFilter, departmentIds?: string[]) {
    let departmentWhere: string | { in: string[] } | undefined;
    if (filter.departmentId) {
      departmentWhere = departmentIds && !departmentIds.includes(filter.departmentId) ? { in: [] } : filter.departmentId;
    } else {
      departmentWhere = departmentIds ? { in: departmentIds } : undefined;
    }

    return {
      departmentId: departmentWhere,
      createdById: filter.submitterId || undefined,
      status: filter.status ? (filter.status as SettlementStatus) : undefined,
      createdAt: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  // externalSyncedAt is set the moment a Settlement's final tier is submitted
  // and pushed to the external system (ExternalSyncService) - the closest
  // thing to a "finished" timestamp the schema has, so processing time is
  // measured from createdAt to there. Settlements never synced (still mid-
  // chain, or rejected) don't have one and are excluded.
  private averageProcessingDays(rows: { createdAt: Date; externalSyncedAt: Date | null }[]): number {
    const days = rows.filter((r) => r.externalSyncedAt).map((r) => (r.externalSyncedAt!.getTime() - r.createdAt.getTime()) / 86_400_000);
    return days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  }

  async settlementSummary(actor: AuthUser, filter: SettlementPeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere(filter, departmentIds);

    const [totalAgg, approvedAgg, waitingAgg, rejectedAgg, completedForProcessing] = await Promise.all([
      this.prisma.settlement.aggregate({ where, _sum: { totalAmount: true }, _count: true }),
      this.prisma.settlement.aggregate({ where: { ...where, status: SettlementStatus.COMPLETE }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.settlement.aggregate({ where: { ...where, status: { in: SETTLEMENT_WAITING_STATUSES } }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.settlement.aggregate({ where: { ...where, status: SettlementStatus.REJECTED }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.settlement.findMany({ where: { ...where, externalSyncedAt: { not: null } }, select: { createdAt: true, externalSyncedAt: true } }),
    ]);

    // "vs previous period" deltas only make sense when the caller actually
    // picked a from/to window - otherwise there's no well-defined "previous"
    // window to compare against.
    let previous: { totalAmount: number; totalTransactions: number; averageProcessingDays: number } | null = null;
    if (filter.from && filter.to) {
      const from = new Date(filter.from);
      const to = new Date(filter.to);
      const durationMs = to.getTime() - from.getTime();
      const prevTo = new Date(from.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - durationMs);
      const prevWhere = this.buildSettlementWhere({ ...filter, from: prevFrom.toISOString(), to: prevTo.toISOString() }, departmentIds);
      const [prevTotalAgg, prevCompleted] = await Promise.all([
        this.prisma.settlement.aggregate({ where: prevWhere, _sum: { totalAmount: true }, _count: true }),
        this.prisma.settlement.findMany({ where: { ...prevWhere, externalSyncedAt: { not: null } }, select: { createdAt: true, externalSyncedAt: true } }),
      ]);
      previous = {
        totalAmount: Number(prevTotalAgg._sum.totalAmount ?? 0),
        totalTransactions: prevTotalAgg._count,
        averageProcessingDays: this.averageProcessingDays(prevCompleted),
      };
    }

    return {
      totalAmount: totalAgg._sum.totalAmount ?? 0,
      totalTransactions: totalAgg._count,
      approvedAmount: approvedAgg._sum.totalAmount ?? 0,
      approvedCount: approvedAgg._count,
      waitingApprovalAmount: waitingAgg._sum.totalAmount ?? 0,
      waitingApprovalCount: waitingAgg._count,
      rejectedAmount: rejectedAgg._sum.totalAmount ?? 0,
      rejectedCount: rejectedAgg._count,
      averageProcessingDays: this.averageProcessingDays(completedForProcessing),
      previous,
    };
  }

  // Bucketed into the same 4 labels the status donut shows, regardless of
  // any status filter the caller picked (a breakdown of "just REJECTED" would
  // be a pointless single-slice chart).
  async settlementStatusBreakdown(actor: AuthUser, filter: SettlementPeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere({ ...filter, status: undefined }, departmentIds);
    const grouped = await this.prisma.settlement.groupBy({ by: ['status'], where, _count: true });
    const countByStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count])) as Record<SettlementStatus, number>;
    const waiting = SETTLEMENT_WAITING_STATUSES.reduce((sum, s) => sum + (countByStatus[s] ?? 0), 0);

    return [
      { key: 'approved', label: 'Approved', count: countByStatus.COMPLETE ?? 0, color: '#3fd085' },
      { key: 'waiting', label: 'Waiting Approval', count: waiting, color: '#f7b955' },
      { key: 'rejected', label: 'Rejected', count: countByStatus.REJECTED ?? 0, color: '#ef5da8' },
      { key: 'draft', label: 'Draft', count: countByStatus.DRAFT ?? 0, color: '#8b7bfb' },
    ];
  }

  async settlementTrend(actor: AuthUser, filter: SettlementPeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere(filter, departmentIds);
    const settlements = await this.prisma.settlement.findMany({ where, select: { createdAt: true, totalAmount: true } });
    const byMonth = new Map<string, { total: number; count: number }>();
    for (const s of settlements) {
      const key = `${s.createdAt.getFullYear()}-${String(s.createdAt.getMonth() + 1).padStart(2, '0')}`;
      const bucket = byMonth.get(key) ?? { total: 0, count: 0 };
      bucket.total += Number(s.totalAmount);
      bucket.count += 1;
      byMonth.set(key, bucket);
    }
    return Array.from(byMonth.entries())
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  // "Settlement by POD & Submitter": grouped by Department like
  // expenseByDepartment(), but the subtitle names whichever 2 submitters
  // (Settlement.createdBy) contributed the most amount in that Department,
  // instead of every active member.
  async settlementByPod(actor: AuthUser, filter: SettlementPeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere(filter, departmentIds);
    const settlements = await this.prisma.settlement.findMany({
      where,
      select: { departmentId: true, totalAmount: true, createdBy: { select: { id: true, name: true } } },
    });
    if (settlements.length === 0) return [];

    const byDept = new Map<string, { totalExpense: number; transactionCount: number; submitters: Map<string, { name: string; amount: number }> }>();
    for (const s of settlements) {
      const bucket = byDept.get(s.departmentId) ?? { totalExpense: 0, transactionCount: 0, submitters: new Map() };
      bucket.totalExpense += Number(s.totalAmount);
      bucket.transactionCount += 1;
      const sub = bucket.submitters.get(s.createdBy.id) ?? { name: s.createdBy.name, amount: 0 };
      sub.amount += Number(s.totalAmount);
      bucket.submitters.set(s.createdBy.id, sub);
      byDept.set(s.departmentId, bucket);
    }

    const departments = await this.prisma.department.findMany({ where: { id: { in: [...byDept.keys()] } } });
    const nameMap = new Map(departments.map((d) => [d.id, d.name]));

    return Array.from(byDept.entries())
      .map(([id, v]) => ({
        id,
        name: nameMap.get(id) ?? '-',
        subtitle: Array.from(v.submitters.values())
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 2)
          .map((s) => s.name)
          .join(', '),
        totalExpense: v.totalExpense,
        transactionCount: v.transactionCount,
      }))
      .sort((a, b) => b.totalExpense - a.totalExpense);
  }

  async settlementTopSubmitters(actor: AuthUser, filter: SettlementPeriodFilter, limit = 5) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere(filter, departmentIds);
    const grouped = await this.prisma.settlement.groupBy({
      by: ['createdById'],
      where,
      _sum: { totalAmount: true },
      _count: true,
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: limit,
    });
    if (grouped.length === 0) return [];

    const users = await this.prisma.user.findMany({ where: { id: { in: grouped.map((g) => g.createdById) } }, select: { id: true, name: true } });
    const nameMap = new Map(users.map((u) => [u.id, u.name]));

    return grouped.map((g) => ({
      id: g.createdById,
      name: nameMap.get(g.createdById) ?? '-',
      totalExpense: g._sum.totalAmount ?? 0,
      transactionCount: g._count,
    }));
  }

  // "Approval Progress" per tier: approved/rejected come from the historical
  // ApprovalAction log at that tier's Position (documentStage SETTLEMENT);
  // waiting is however many Settlements currently sit at that tier right now.
  // Position.code is admin-entered free text (ApprovalLevel master data) - the
  // exact original dash placement isn't knowable from the enum alone, so this
  // matches by re-deriving each Position's normalized APPROVAL_<code> key
  // (same normalization ApprovalsService.pendingStatusForPosition uses) rather
  // than guessing a literal code string.
  async settlementApprovalProgress(actor: AuthUser, filter: SettlementPeriodFilter) {
    const positions = await this.prisma.position.findMany();
    const positionByTierKey = new Map<string, { id: string; name: string }>();
    for (const p of positions) {
      const key = `APPROVAL_${p.code.replace(/-/g, '_')}`;
      if ((SETTLEMENT_TIER_KEYS as readonly string[]).includes(key)) positionByTierKey.set(key, p);
    }

    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere({ ...filter, status: undefined }, departmentIds);
    const waitingGroups = await this.prisma.settlement.groupBy({ by: ['status'], where, _count: true });
    const waitingByStatus = Object.fromEntries(waitingGroups.map((g) => [g.status, g._count])) as Record<string, number>;

    const results: { level: number; positionName: string; approvedPct: number; waitingPct: number; rejectedPct: number }[] = [];
    for (let i = 0; i < SETTLEMENT_TIER_KEYS.length; i++) {
      const tierKey = SETTLEMENT_TIER_KEYS[i];
      const position = positionByTierKey.get(tierKey);
      const waiting = waitingByStatus[tierKey] ?? 0;
      let approved = 0;
      let rejected = 0;
      if (position) {
        [approved, rejected] = await Promise.all([
          this.prisma.approvalAction.count({
            where: { positionId: position.id, action: 'APPROVE', approvalRequest: { documentStage: 'SETTLEMENT', settlement: { is: where } } },
          }),
          this.prisma.approvalAction.count({
            where: { positionId: position.id, action: 'REJECT', approvalRequest: { documentStage: 'SETTLEMENT', settlement: { is: where } } },
          }),
        ]);
      }
      const total = approved + waiting + rejected || 1;
      results.push({
        level: i + 1,
        positionName: position?.name ?? tierKey.replace('APPROVAL_', '').replace(/_/g, ' '),
        approvedPct: Math.round((approved / total) * 100),
        waitingPct: Math.round((waiting / total) * 100),
        rejectedPct: Math.round((rejected / total) * 100),
      });
    }
    return results;
  }

  async settlementProcessingTimeByPod(actor: AuthUser, filter: SettlementPeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere({ ...filter, status: undefined }, departmentIds);
    const settlements = await this.prisma.settlement.findMany({
      where: { ...where, externalSyncedAt: { not: null } },
      select: { departmentId: true, createdAt: true, externalSyncedAt: true },
    });
    if (settlements.length === 0) return [];

    const byDept = new Map<string, number[]>();
    for (const s of settlements) {
      const days = (s.externalSyncedAt!.getTime() - s.createdAt.getTime()) / 86_400_000;
      const list = byDept.get(s.departmentId) ?? [];
      list.push(days);
      byDept.set(s.departmentId, list);
    }

    const departments = await this.prisma.department.findMany({ where: { id: { in: [...byDept.keys()] } } });
    const nameMap = new Map(departments.map((d) => [d.id, d.name]));

    return Array.from(byDept.entries())
      .map(([id, days]) => ({ id, name: nameMap.get(id) ?? '-', averageDays: days.reduce((a, b) => a + b, 0) / days.length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Recent Settlements table. approvalLevel names the tier currently (or, for
  // a REJECTED batch, last) reviewing it via approvalRequest.currentStep,
  // which is never reset by a rejection - COMPLETE gets the plain "Completed"
  // label instead of "Level 3" once it's actually done.
  async recentSettlements(actor: AuthUser, filter: SettlementPeriodFilter, limit = 10) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildSettlementWhere(filter, departmentIds);
    const settlements = await this.prisma.settlement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        settlementNo: true,
        createdAt: true,
        totalAmount: true,
        status: true,
        department: { select: { name: true } },
        createdBy: { select: { name: true } },
        _count: { select: { expenses: true } },
        approvalRequest: { select: { currentStep: true } },
      },
    });

    return settlements.map((s) => ({
      id: s.id,
      settlementNo: s.settlementNo,
      period: `${MONTH_NAMES[s.createdAt.getMonth()]} ${s.createdAt.getFullYear()}`,
      departmentName: s.department.name,
      submitterName: s.createdBy.name,
      transactionCount: s._count.expenses,
      totalAmount: s.totalAmount,
      approvalLevel: s.status === SettlementStatus.COMPLETE ? 'Completed' : `Level ${(s.approvalRequest?.currentStep ?? 0) + 1}`,
      status: s.status,
    }));
  }

  // ---------------------------------------------------------------------
  // Expense Analytics Dashboard - unlike the Expense/Settlement Dashboards
  // above (each scoped to just their own model), this reads Expense joined
  // to its optional Settlement so every figure is "settled" in the same
  // sense: Expense.amount attributed the moment its Settlement reaches
  // COMPLETE. Filter stays Expense-dated (PeriodFilter/buildWhere) like the
  // Expense Dashboard, not Settlement-dated - a POD's "outstanding exposure"
  // is naturally about when the expense happened, not when (or whether) it
  // was later settled.
  // ---------------------------------------------------------------------

  async expenseSettlementSummary(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere({ ...filter, status: undefined }, departmentIds);

    const [totalAgg, settledAgg, waitingAgg, completedForProcessing] = await Promise.all([
      this.prisma.expense.aggregate({ where, _sum: { amount: true }, _count: true }),
      this.prisma.expense.aggregate({
        where: { ...where, settlement: { status: SettlementStatus.COMPLETE } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.expense.aggregate({
        where: { ...where, settlement: { status: { in: SETTLEMENT_WAITING_STATUSES } } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.settlement.findMany({
        where: { expenses: { some: where }, externalSyncedAt: { not: null } },
        select: { createdAt: true, externalSyncedAt: true },
      }),
    ]);

    const totalExpense = Number(totalAgg._sum.amount ?? 0);
    const totalSettled = Number(settledAgg._sum.amount ?? 0);

    let previous: {
      totalExpense: number;
      totalSettled: number;
      settlementRate: number;
      averageProcessingDays: number;
    } | null = null;
    if (filter.from && filter.to) {
      const from = new Date(filter.from);
      const to = new Date(filter.to);
      const durationMs = to.getTime() - from.getTime();
      const prevTo = new Date(from.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - durationMs);
      const prevWhere = this.buildWhere(
        { ...filter, status: undefined, from: prevFrom.toISOString(), to: prevTo.toISOString() },
        departmentIds,
      );
      const [prevTotalAgg, prevSettledAgg, prevCompletedForProcessing] = await Promise.all([
        this.prisma.expense.aggregate({ where: prevWhere, _sum: { amount: true } }),
        this.prisma.expense.aggregate({
          where: { ...prevWhere, settlement: { status: SettlementStatus.COMPLETE } },
          _sum: { amount: true },
        }),
        this.prisma.settlement.findMany({
          where: { expenses: { some: prevWhere }, externalSyncedAt: { not: null } },
          select: { createdAt: true, externalSyncedAt: true },
        }),
      ]);
      const prevTotalExpense = Number(prevTotalAgg._sum.amount ?? 0);
      const prevTotalSettled = Number(prevSettledAgg._sum.amount ?? 0);
      previous = {
        totalExpense: prevTotalExpense,
        totalSettled: prevTotalSettled,
        settlementRate: prevTotalExpense > 0 ? (prevTotalSettled / prevTotalExpense) * 100 : 0,
        averageProcessingDays: this.averageProcessingDays(prevCompletedForProcessing),
      };
    }

    return {
      totalExpense,
      totalExpenseCount: totalAgg._count,
      totalSettled,
      totalSettledCount: settledAgg._count,
      outstanding: totalExpense - totalSettled,
      outstandingCount: totalAgg._count - settledAgg._count,
      settlementRate: totalExpense > 0 ? (totalSettled / totalExpense) * 100 : 0,
      waitingApprovalAmount: Number(waitingAgg._sum.amount ?? 0),
      waitingApprovalCount: waitingAgg._count,
      averageProcessingDays: this.averageProcessingDays(completedForProcessing),
      previous,
    };
  }

  // "Expenses vs Settlement by POD" - each Department's total expense split
  // into settled (its Settlement reached COMPLETE) vs outstanding (everything
  // else: unmatched, mid-chain, or rejected).
  async expenseVsSettlementByPod(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere({ ...filter, status: undefined }, departmentIds);
    const expenses = await this.prisma.expense.findMany({
      where: { ...where, departmentId: { not: null } },
      select: { departmentId: true, amount: true, settlement: { select: { status: true } } },
    });
    if (expenses.length === 0) return [];

    const byDept = new Map<string, { totalExpense: number; settled: number; transactionCount: number }>();
    for (const e of expenses) {
      const bucket = byDept.get(e.departmentId as string) ?? { totalExpense: 0, settled: 0, transactionCount: 0 };
      bucket.totalExpense += Number(e.amount);
      if (e.settlement?.status === SettlementStatus.COMPLETE) bucket.settled += Number(e.amount);
      bucket.transactionCount += 1;
      byDept.set(e.departmentId as string, bucket);
    }

    const departments = await this.prisma.department.findMany({ where: { id: { in: [...byDept.keys()] } } });
    const nameMap = new Map(departments.map((d) => [d.id, d.name]));

    return Array.from(byDept.entries())
      .map(([id, v]) => ({
        id,
        name: nameMap.get(id) ?? '-',
        totalExpense: v.totalExpense,
        settled: v.settled,
        outstanding: v.totalExpense - v.settled,
        transactionCount: v.transactionCount,
      }))
      .sort((a, b) => b.totalExpense - a.totalExpense);
  }

  async expenseSettlementTrend(actor: AuthUser, filter: PeriodFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere({ ...filter, status: undefined }, departmentIds);
    const expenses = await this.prisma.expense.findMany({
      where,
      select: { expenseDate: true, amount: true, settlement: { select: { status: true } } },
    });
    const byMonth = new Map<string, { totalExpense: number; settled: number }>();
    for (const e of expenses) {
      const key = `${e.expenseDate.getFullYear()}-${String(e.expenseDate.getMonth() + 1).padStart(2, '0')}`;
      const bucket = byMonth.get(key) ?? { totalExpense: 0, settled: 0 };
      bucket.totalExpense += Number(e.amount);
      if (e.settlement?.status === SettlementStatus.COMPLETE) bucket.settled += Number(e.amount);
      byMonth.set(key, bucket);
    }
    return Array.from(byMonth.entries())
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  // "Expense & Settlement Reconciliation" table - one row per Expense showing
  // whatever Settlement (if any) it's currently attached to and how much of
  // its amount that Settlement has actually settled.
  async expenseSettlementReconciliation(actor: AuthUser, filter: PeriodFilter, limit = 10) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildWhere({ ...filter, status: undefined }, departmentIds);
    const expenses = await this.prisma.expense.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      take: limit,
      select: {
        id: true,
        expenseNo: true,
        amount: true,
        sales: { select: { name: true } },
        department: { select: { name: true } },
        settlement: { select: { settlementNo: true, status: true } },
      },
    });

    return expenses.map((e) => {
      const settled = e.settlement?.status === SettlementStatus.COMPLETE ? Number(e.amount) : 0;
      return {
        id: e.id,
        expenseNo: e.expenseNo,
        podName: e.department?.name ?? '-',
        submitterName: e.sales?.name ?? '-',
        expenseAmount: e.amount,
        settlementNo: e.settlement?.settlementNo ?? null,
        settledAmount: settled,
        outstanding: Number(e.amount) - settled,
        settlementStatus: e.settlement?.status ?? null,
      };
    });
  }
}
