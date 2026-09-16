import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditFindingStatus, AuditFindingType, AuditRiskLevel, ExpenseStatus, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords, getActorDepartmentIds } from '../common/rbac/scope.util';

export interface AuditReportFilter {
  from?: string;
  to?: string;
  departmentId?: string;
  riskLevel?: string;
  findingType?: string;
  status?: string;
}

interface FindingCandidate {
  expenseId?: string;
  settlementId?: string;
  amount: number;
  departmentId: string | null;
  agingDays: number;
  riskLevel: AuditRiskLevel;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Below this age an unmatched Expense / open Settlement isn't flagged yet -
// gives Sales Admin / approvers a grace window before it counts as a finding.
const AGING_THRESHOLD_DAYS = 14;

const daysSince = (date: Date) => Math.floor((Date.now() - date.getTime()) / DAY_MS);

const riskByAmount = (amount: number): AuditRiskLevel => (amount >= 10_000_000 ? 'HIGH' : amount >= 2_000_000 ? 'MEDIUM' : 'LOW');
const riskByAging = (days: number): AuditRiskLevel => (days > 30 ? 'HIGH' : 'MEDIUM');

const FINDING_TYPE_LABELS: Record<AuditFindingType, string> = {
  MISSING_RECEIPT: 'Missing Receipt',
  UNMATCHED_TRANSACTION: 'Unmatched Transaction',
  OVERDUE_SETTLEMENT: 'Overdue Settlement',
  DUPLICATE_CLAIM: 'Duplicate Claim',
  POLICY_EXCEPTION: 'Policy Exception',
};

const FINDING_TYPE_COLORS: Record<AuditFindingType, string> = {
  MISSING_RECEIPT: '#f0605f',
  UNMATCHED_TRANSACTION: '#f7b955',
  OVERDUE_SETTLEMENT: '#ef5da8',
  DUPLICATE_CLAIM: '#8b7bfb',
  POLICY_EXCEPTION: '#5850c9',
};

const RISK_COLORS: Record<AuditRiskLevel, string> = { HIGH: '#f0605f', MEDIUM: '#f7b955', LOW: '#8b7bfb' };

@Injectable()
export class AuditReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // audit-report.read.all / audit-report.read.owndept (Role/Permission master),
  // same shape as DashboardService.resolveDepartmentScope() - undefined = no
  // restriction, [] = caller holds neither the role nor a permission (guard
  // should already have blocked this).
  private async resolveDepartmentScope(actor: AuthUser): Promise<string[] | undefined> {
    if (canViewAllRecords(actor) || actor.permissions?.includes('audit-report.read.all')) return undefined;
    if (actor.permissions?.includes('audit-report.read.owndept')) {
      return getActorDepartmentIds(this.prisma, actor.userId);
    }
    return [];
  }

  private scopedDepartmentWhere(filterDepartmentId: string | undefined, departmentIds?: string[]) {
    if (filterDepartmentId) {
      return departmentIds && !departmentIds.includes(filterDepartmentId) ? { in: [] } : filterDepartmentId;
    }
    return departmentIds ? { in: departmentIds } : undefined;
  }

  private buildExpenseWhere(filter: AuditReportFilter, departmentIds?: string[]) {
    return {
      departmentId: this.scopedDepartmentWhere(filter.departmentId, departmentIds),
      status: { not: ExpenseStatus.DRAFT },
      expenseDate: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  private buildFindingWhere(filter: AuditReportFilter, departmentIds?: string[]) {
    return {
      departmentId: this.scopedDepartmentWhere(filter.departmentId, departmentIds),
      riskLevel: filter.riskLevel ? (filter.riskLevel as AuditRiskLevel) : undefined,
      findingType: filter.findingType ? (filter.findingType as AuditFindingType) : undefined,
      status: filter.status ? (filter.status as AuditFindingStatus) : undefined,
      detectedAt: {
        gte: filter.from ? new Date(filter.from) : undefined,
        lte: filter.to ? new Date(filter.to) : undefined,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Detection - re-derives AuditFinding rows from source data on every read.
  // Upserts refresh amount/departmentId/agingDays/riskLevel but never touch
  // status/notes/resolvedAt (the human audit workflow); a finding whose
  // subject no longer matches its rule gets auto-RESOLVED.
  // ---------------------------------------------------------------------

  async ensureFindingsSynced(): Promise<void> {
    const [missingReceipt, unmatched, overdueSettlement, duplicateClaim, policyException] = await Promise.all([
      this.findMissingReceiptCandidates(),
      this.findUnmatchedCandidates(),
      this.findOverdueSettlementCandidates(),
      this.findDuplicateCandidates(),
      this.findPolicyExceptionCandidates(),
    ]);
    await Promise.all([
      this.syncFindingSet('MISSING_RECEIPT', missingReceipt),
      this.syncFindingSet('UNMATCHED_TRANSACTION', unmatched),
      this.syncFindingSet('OVERDUE_SETTLEMENT', overdueSettlement),
      this.syncFindingSet('DUPLICATE_CLAIM', duplicateClaim),
      this.syncFindingSet('POLICY_EXCEPTION', policyException),
    ]);
  }

  private async syncFindingSet(findingType: AuditFindingType, candidates: FindingCandidate[]) {
    const activeKeys = new Set(candidates.map((c) => c.expenseId ?? c.settlementId ?? ''));

    for (const c of candidates) {
      const data = { riskLevel: c.riskLevel, amount: c.amount, departmentId: c.departmentId, agingDays: c.agingDays };
      if (c.expenseId) {
        await this.prisma.auditFinding.upsert({
          where: { findingType_expenseId: { findingType, expenseId: c.expenseId } },
          create: { findingType, expenseId: c.expenseId, ...data },
          update: data,
        });
      } else if (c.settlementId) {
        await this.prisma.auditFinding.upsert({
          where: { findingType_settlementId: { findingType, settlementId: c.settlementId } },
          create: { findingType, settlementId: c.settlementId, ...data },
          update: data,
        });
      }
    }

    const stale = await this.prisma.auditFinding.findMany({
      where: { findingType, status: { not: 'RESOLVED' } },
      select: { id: true, expenseId: true, settlementId: true },
    });
    const staleIds = stale.filter((f) => !activeKeys.has(f.expenseId ?? f.settlementId ?? '')).map((f) => f.id);
    if (staleIds.length) {
      await this.prisma.auditFinding.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: null },
      });
    }
  }

  private async findMissingReceiptCandidates(): Promise<FindingCandidate[]> {
    const expenses = await this.prisma.expense.findMany({
      where: {
        status: { not: ExpenseStatus.DRAFT },
        OR: [{ invoices: { none: {} } }, { invoices: { every: { files: { none: {} } } } }],
      },
      select: { id: true, amount: true, departmentId: true, expenseDate: true },
    });
    return expenses.map((e) => {
      const amount = Number(e.amount);
      return { expenseId: e.id, amount, departmentId: e.departmentId, agingDays: daysSince(e.expenseDate), riskLevel: riskByAmount(amount) };
    });
  }

  private async findUnmatchedCandidates(): Promise<FindingCandidate[]> {
    const threshold = new Date(Date.now() - AGING_THRESHOLD_DAYS * DAY_MS);
    const expenses = await this.prisma.expense.findMany({
      where: { isMatched: false, status: ExpenseStatus.READY_TO_MATCHING, expenseDate: { lt: threshold } },
      select: { id: true, amount: true, departmentId: true, expenseDate: true },
    });
    return expenses.map((e) => {
      const agingDays = daysSince(e.expenseDate);
      return { expenseId: e.id, amount: Number(e.amount), departmentId: e.departmentId, agingDays, riskLevel: riskByAging(agingDays) };
    });
  }

  private async findOverdueSettlementCandidates(): Promise<FindingCandidate[]> {
    const threshold = new Date(Date.now() - AGING_THRESHOLD_DAYS * DAY_MS);
    const settlements = await this.prisma.settlement.findMany({
      where: { status: { not: SettlementStatus.COMPLETE }, createdAt: { lt: threshold } },
      select: { id: true, totalAmount: true, departmentId: true, createdAt: true },
    });
    return settlements.map((s) => {
      const agingDays = daysSince(s.createdAt);
      return { settlementId: s.id, amount: Number(s.totalAmount), departmentId: s.departmentId, agingDays, riskLevel: riskByAging(agingDays) };
    });
  }

  private async findDuplicateCandidates(): Promise<FindingCandidate[]> {
    const grouped = await this.prisma.expense.groupBy({
      by: ['merchantName', 'amount', 'expenseDate'],
      where: { merchantName: { not: null } },
      _count: { id: true },
    });
    const dupGroups = grouped.filter((g) => g._count.id > 1);
    const results: FindingCandidate[] = [];
    for (const g of dupGroups) {
      const rows = await this.prisma.expense.findMany({
        where: { merchantName: g.merchantName, amount: g.amount, expenseDate: g.expenseDate },
        select: { id: true, amount: true, departmentId: true, expenseDate: true },
        orderBy: { createdAt: 'asc' },
      });
      // Earliest row is treated as the original claim; every later one with the
      // same merchant/amount/date is flagged as a potential duplicate.
      for (const row of rows.slice(1)) {
        results.push({ expenseId: row.id, amount: Number(row.amount), departmentId: row.departmentId, agingDays: daysSince(row.expenseDate), riskLevel: 'HIGH' });
      }
    }
    return results;
  }

  private async findPolicyExceptionCandidates(): Promise<FindingCandidate[]> {
    const items = await this.prisma.expenseItem.findMany({
      where: { category: { policyLimit: { not: null } } },
      select: {
        amount: true,
        category: { select: { policyLimit: true } },
        expense: { select: { id: true, departmentId: true, expenseDate: true } },
      },
    });
    const byExpense = new Map<string, FindingCandidate>();
    for (const item of items) {
      const limit = item.category?.policyLimit ? Number(item.category.policyLimit) : null;
      if (limit == null) continue;
      const amount = Number(item.amount);
      if (amount <= limit) continue;
      const candidate: FindingCandidate = {
        expenseId: item.expense.id,
        amount,
        departmentId: item.expense.departmentId,
        agingDays: daysSince(item.expense.expenseDate),
        riskLevel: amount > limit * 1.5 ? 'HIGH' : 'MEDIUM',
      };
      const existing = byExpense.get(candidate.expenseId!);
      if (!existing || candidate.amount > existing.amount) byExpense.set(candidate.expenseId!, candidate);
    }
    return Array.from(byExpense.values());
  }

  // ---------------------------------------------------------------------
  // Read endpoints
  // ---------------------------------------------------------------------

  private async documentCompletenessRaw(expenseWhere: ReturnType<AuditReportService['buildExpenseWhere']>) {
    const expenses = await this.prisma.expense.findMany({
      where: expenseWhere,
      select: { invoices: { select: { finalTotal: true, files: { select: { id: true } } } } },
    });
    let complete = 0;
    let missing = 0;
    let invalid = 0;
    for (const e of expenses) {
      const hasFile = e.invoices.some((inv) => inv.files.length > 0);
      if (!hasFile) {
        missing++;
        continue;
      }
      const hasValidTotal = e.invoices.some((inv) => inv.files.length > 0 && inv.finalTotal != null);
      if (hasValidTotal) complete++;
      else invalid++;
    }
    const total = expenses.length;
    return { total, complete, missing, invalid, completePct: total ? Math.round((complete / total) * 1000) / 10 : 0 };
  }

  async summary(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const expenseWhere = this.buildExpenseWhere(filter, departmentIds);
    const findingWhere = this.buildFindingWhere(filter, departmentIds);

    const [transactionsReviewedAgg, exceptionsAgg, highRiskAgg, outstandingAgg, nonCompliantExpenseIds, documentCompleteness] = await Promise.all([
      this.prisma.expense.aggregate({ where: expenseWhere, _count: true, _sum: { amount: true } }),
      this.prisma.auditFinding.aggregate({ where: { ...findingWhere, status: { not: 'RESOLVED' } }, _count: true, _sum: { amount: true } }),
      this.prisma.auditFinding.aggregate({ where: { ...findingWhere, riskLevel: 'HIGH', status: { not: 'RESOLVED' } }, _count: true, _sum: { amount: true } }),
      this.prisma.settlement.aggregate({
        where: { status: { not: 'COMPLETE' }, departmentId: expenseWhere.departmentId },
        _sum: { totalAmount: true },
        _count: true,
      }),
      this.prisma.auditFinding.findMany({
        where: { ...findingWhere, status: { not: 'RESOLVED' }, expenseId: { not: null } },
        select: { expenseId: true },
        distinct: ['expenseId'],
      }),
      this.documentCompletenessRaw(expenseWhere),
    ]);

    const transactionsReviewed = transactionsReviewedAgg._count;
    const compliantTransactions = Math.max(transactionsReviewed - nonCompliantExpenseIds.length, 0);

    return {
      transactionsReviewed,
      transactionsReviewedAmount: Number(transactionsReviewedAgg._sum.amount ?? 0),
      compliantTransactions,
      complianceRate: transactionsReviewed ? Math.round((compliantTransactions / transactionsReviewed) * 1000) / 10 : 0,
      auditExceptions: exceptionsAgg._count,
      auditExceptionsAmount: Number(exceptionsAgg._sum.amount ?? 0),
      highRiskFindings: highRiskAgg._count,
      highRiskFindingsAmount: Number(highRiskAgg._sum.amount ?? 0),
      outstandingSettlement: Number(outstandingAgg._sum.totalAmount ?? 0),
      outstandingSettlementCount: outstandingAgg._count,
      documentsCompletePct: documentCompleteness.completePct,
    };
  }

  async findingsByType(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = { ...this.buildFindingWhere(filter, departmentIds), status: { not: 'RESOLVED' as AuditFindingStatus } };
    const grouped = await this.prisma.auditFinding.groupBy({ by: ['findingType'], where, _count: true, _sum: { amount: true } });
    return grouped
      .map((g) => ({
        key: g.findingType,
        label: FINDING_TYPE_LABELS[g.findingType],
        count: g._count,
        amount: Number(g._sum.amount ?? 0),
        color: FINDING_TYPE_COLORS[g.findingType],
      }))
      .sort((a, b) => b.count - a.count);
  }

  async riskBreakdown(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = { ...this.buildFindingWhere(filter, departmentIds), status: { not: 'RESOLVED' as AuditFindingStatus } };
    const grouped = await this.prisma.auditFinding.groupBy({ by: ['riskLevel'], where, _count: true });
    const total = grouped.reduce((s, g) => s + g._count, 0) || 1;
    return grouped.map((g) => ({
      id: g.riskLevel,
      label: g.riskLevel.charAt(0) + g.riskLevel.slice(1).toLowerCase(),
      value: g._count,
      color: RISK_COLORS[g.riskLevel],
      subtitle: `${Math.round((g._count / total) * 100)}%`,
    }));
  }

  async trend(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const expenseWhere = this.buildExpenseWhere(filter, departmentIds);
    const settlementDeptWhere = expenseWhere.departmentId;

    const [expenses, settlements, findings] = await Promise.all([
      this.prisma.expense.findMany({ where: expenseWhere, select: { expenseDate: true, amount: true } }),
      this.prisma.settlement.findMany({ where: { departmentId: settlementDeptWhere, status: 'COMPLETE' }, select: { createdAt: true, totalAmount: true } }),
      this.prisma.auditFinding.findMany({ where: this.buildFindingWhere(filter, departmentIds), select: { detectedAt: true } }),
    ]);

    const byMonth = new Map<string, { totalExpense: number; totalSettled: number; exceptionsCount: number }>();
    const bump = (date: Date, field: 'totalExpense' | 'totalSettled' | 'exceptionsCount', amount: number) => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const bucket = byMonth.get(key) ?? { totalExpense: 0, totalSettled: 0, exceptionsCount: 0 };
      bucket[field] += amount;
      byMonth.set(key, bucket);
    };
    for (const e of expenses) bump(e.expenseDate, 'totalExpense', Number(e.amount));
    for (const s of settlements) bump(s.createdAt, 'totalSettled', Number(s.totalAmount));
    for (const f of findings) bump(f.detectedAt, 'exceptionsCount', 1);

    return Array.from(byMonth.entries())
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  async complianceByPod(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const expenseWhere = this.buildExpenseWhere(filter, departmentIds);

    const [expenseGroups, findingGroups, departments] = await Promise.all([
      this.prisma.expense.groupBy({ by: ['departmentId'], where: { ...expenseWhere, departmentId: { not: null } }, _count: true }),
      this.prisma.auditFinding.groupBy({
        by: ['departmentId'],
        where: { ...this.buildFindingWhere(filter, departmentIds), status: { not: 'RESOLVED' }, departmentId: { not: null } },
        _count: true,
      }),
      this.prisma.department.findMany({ select: { id: true, name: true } }),
    ]);
    const nameMap = new Map(departments.map((d) => [d.id, d.name]));
    const findingCountMap = new Map(findingGroups.map((g) => [g.departmentId, g._count]));

    return expenseGroups
      .map((g) => {
        const reviewed = g._count;
        const exceptions = findingCountMap.get(g.departmentId) ?? 0;
        const value = reviewed ? Math.max(0, Math.round((1 - exceptions / reviewed) * 100)) : 100;
        return { id: g.departmentId as string, name: nameMap.get(g.departmentId as string) ?? '-', value };
      })
      .sort((a, b) => a.value - b.value);
  }

  async highRiskExposureByPod(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = {
      ...this.buildFindingWhere(filter, departmentIds),
      riskLevel: 'HIGH' as AuditRiskLevel,
      status: { not: 'RESOLVED' as AuditFindingStatus },
      departmentId: { not: null },
    };
    const grouped = await this.prisma.auditFinding.groupBy({ by: ['departmentId'], where, _sum: { amount: true } });
    const departments = await this.prisma.department.findMany({ where: { id: { in: grouped.map((g) => g.departmentId as string) } } });
    const nameMap = new Map(departments.map((d) => [d.id, d.name]));
    return grouped
      .map((g) => ({ id: g.departmentId as string, name: nameMap.get(g.departmentId as string) ?? '-', value: Number(g._sum.amount ?? 0) }))
      .sort((a, b) => b.value - a.value);
  }

  async documentCompleteness(actor: AuthUser, filter: AuditReportFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const expenseWhere = this.buildExpenseWhere(filter, departmentIds);
    const r = await this.documentCompletenessRaw(expenseWhere);
    return [
      { id: 'complete', label: 'Complete', value: r.complete, color: '#3fd085' },
      { id: 'missing', label: 'Missing', value: r.missing, color: '#f0605f' },
      { id: 'invalid', label: 'Invalid', value: r.invalid, color: '#f7b955' },
    ];
  }

  async settlementAging(actor: AuthUser, filter: AuditReportFilter) {
    const departmentIds = await this.resolveDepartmentScope(actor);
    const departmentWhere = this.scopedDepartmentWhere(filter.departmentId, departmentIds);
    const settlements = await this.prisma.settlement.findMany({
      where: { status: { not: 'COMPLETE' }, departmentId: departmentWhere },
      select: { totalAmount: true, createdAt: true },
    });

    const buckets = [
      { id: '0-7', name: '0 - 7 Days', min: 0, max: 7, value: 0 },
      { id: '8-14', name: '8 - 14 Days', min: 8, max: 14, value: 0 },
      { id: '15-30', name: '15 - 30 Days', min: 15, max: 30, value: 0 },
      { id: '30+', name: '> 30 Days', min: 31, max: Infinity, value: 0 },
    ];
    for (const s of settlements) {
      const days = daysSince(s.createdAt);
      const bucket = buckets.find((b) => days >= b.min && days <= b.max) ?? buckets[buckets.length - 1];
      bucket.value += Number(s.totalAmount);
    }
    return buckets.map(({ id, name, value }) => ({ id, name, value }));
  }

  async directorAttention(actor: AuthUser, filter: AuditReportFilter) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const [compliance, unmatchedCount, overdueAgg] = await Promise.all([
      this.complianceByPod(actor, filter),
      this.prisma.auditFinding.count({
        where: { ...this.buildFindingWhere(filter, departmentIds), findingType: 'UNMATCHED_TRANSACTION', status: { not: 'RESOLVED' } },
      }),
      this.prisma.settlement.aggregate({
        where: { status: { not: 'COMPLETE' }, createdAt: { lt: new Date(Date.now() - 30 * DAY_MS) } },
        _sum: { totalAmount: true },
      }),
    ]);

    const alerts: { id: string; level: 'danger' | 'warning'; message: string }[] = [];
    const lowest = compliance[0];
    if (lowest) alerts.push({ id: 'lowest-compliance', level: 'danger', message: `${lowest.name} has the lowest compliance score: ${lowest.value}%` });
    if (unmatchedCount > 0) alerts.push({ id: 'unmatched', level: 'warning', message: `${unmatchedCount} transactions remain unmatched` });
    const overdueAmount = Number(overdueAgg._sum.totalAmount ?? 0);
    if (overdueAmount > 0) {
      alerts.push({ id: 'overdue', level: 'danger', message: `Rp ${overdueAmount.toLocaleString('id-ID')} settlement overdue > 30 days` });
    }
    return alerts;
  }

  async findings(actor: AuthUser, filter: AuditReportFilter, page = 1, pageSize = 10) {
    await this.ensureFindingsSynced();
    const departmentIds = await this.resolveDepartmentScope(actor);
    const where = this.buildFindingWhere(filter, departmentIds);

    const [total, rows] = await Promise.all([
      this.prisma.auditFinding.count({ where }),
      this.prisma.auditFinding.findMany({
        where,
        include: {
          department: { select: { name: true } },
          expense: { select: { expenseNo: true, sales: { select: { name: true } } } },
          settlement: { select: { settlementNo: true, createdBy: { select: { name: true } } } },
        },
        // Postgres enums sort by declaration order (HIGH, MEDIUM, LOW in the
        // schema), so `asc` here already means "worst risk first".
        orderBy: [{ riskLevel: 'asc' }, { agingDays: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      rows: rows.map((r) => ({
        id: r.id,
        findingNo: `AUD-${r.createdAt.getFullYear()}-${String(r.seq).padStart(4, '0')}`,
        findingType: r.findingType,
        findingLabel: FINDING_TYPE_LABELS[r.findingType],
        status: r.status,
        riskLevel: r.riskLevel,
        amount: Number(r.amount),
        agingDays: r.agingDays,
        departmentName: r.department?.name ?? '-',
        subjectNo: r.expense?.expenseNo ?? r.settlement?.settlementNo ?? '-',
        submitterName: r.expense?.sales?.name ?? r.settlement?.createdBy?.name ?? '-',
        expenseId: r.expenseId,
        settlementId: r.settlementId,
        notes: r.notes,
      })),
    };
  }

  async updateFindingStatus(actor: AuthUser, id: string, dto: { status: AuditFindingStatus; notes?: string }) {
    const finding = await this.prisma.auditFinding.findUnique({ where: { id } });
    if (!finding) throw new NotFoundException('Finding not found');

    const updated = await this.prisma.auditFinding.update({
      where: { id },
      data: {
        status: dto.status,
        notes: dto.notes ?? finding.notes,
        resolvedAt: dto.status === 'RESOLVED' ? new Date() : null,
        resolvedById: dto.status === 'RESOLVED' ? actor.userId : null,
      },
    });

    await this.audit.log({
      userId: actor.userId,
      action: 'UPDATE',
      objectType: 'AuditFinding',
      objectId: id,
      oldValue: { status: finding.status },
      newValue: { status: updated.status, notes: updated.notes },
    });

    return updated;
  }
}
