import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BankTxnStatus, ExpenseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords, canAccessExpenseOwnedRecord } from '../common/rbac/scope.util';
import { RoleName } from '../common/constants/role-name';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';

type ListFilter = {
  salesId?: string;
  status?: ExpenseStatus | 'ALL';
  unitId?: string;
  podId?: string;
  podIdIn?: string[];
  fromDate?: string;
  toDate?: string;
  matched?: 'MATCHED' | 'UNMATCHED';
  search?: string;
};

const include = {
  sales: { select: { id: true, name: true, employeeId: true } },
  unit: true,
  advertiser: { include: { agency: true } },
  brand: true,
  event: true,
  activityType: true,
  costCenter: true,
  creditCard: true,
  pod: true,
  department: true,
  items: { include: { category: true } },
  invoices: { include: { files: true } },
  approvalRequest: {
    include: {
      steps: { include: { position: true, resolvedApprover: { select: { id: true, name: true } } }, orderBy: { stepOrder: 'asc' } },
      actions: { include: { actor: { select: { id: true, name: true } }, position: true }, orderBy: { actedAt: 'asc' } },
    },
  },
  extraBrands: { include: { brand: true } },
  extraAgencies: { include: { agency: true } },
  extraAdvertisers: { include: { advertiser: true } },
  participants: true,
  photos: true,
  // Matched/Unmatched (BankMatching) - AUTO_MATCHED/MANUAL_MATCHED means this
  // Expense is reconciled against a bank/credit-card settlement line.
  bankTransactions: { select: { id: true, status: true, batchId: true, batch: { select: { id: true, fileName: true } } } },
  settlement: { select: { id: true, settlementNo: true } },
} as const;

const MATCHED_TXN_STATUSES: BankTxnStatus[] = [BankTxnStatus.AUTO_MATCHED, BankTxnStatus.MANUAL_MATCHED];

// Editable until approved/rejected/settled - matches web-admin's edit-gate policy.
const LOCKED_STATUSES: ExpenseStatus[] = [ExpenseStatus.APPROVED, ExpenseStatus.REJECTED, ExpenseStatus.SETTLED];

// Matches web-admin's lib/date.ts formatDate() - dd-mm-yyyy everywhere a date is
// shown to a user, including this Excel export.
function formatDateDDMMYYYY(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getFullYear()}`;
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly storage: StorageService,
  ) {}

  // No explicit status filter -> only fully-approved-or-beyond expenses show, so an
  // in-progress Pre-Event Expense only appears in the list once its full approval
  // chain is done. Callers can still see in-progress records by picking an explicit
  // status, or 'ALL' to see everything they're scoped to.
  async findAll(actor: AuthUser, rawFilter: ListFilter) {
    const filter = await this.resolveScope(actor, rawFilter);
    return this.prisma.expense.findMany({ where: this.buildWhere(filter), include, orderBy: { createdAt: 'desc' } });
  }

  // Back office (Admin/Finance/Supervisor/Management) sees everything, scoped only
  // by whatever query params they pass. Sales Admin is POD-scoped: not a global
  // back-office role, but should see every Sales' expense within their own POD(s)
  // (PodMember - same table Sales use to declare POD coverage), not just their own
  // records. A plain expense.read.ownpod permission holder (e.g. a HEAD_POD/BOD
  // Role approving for their POD - PodPositionAssignment, not PodMember) gets the
  // same POD-wide scoping via whichever of the two tables actually covers them.
  // Everyone else (plain Sales) only ever sees their own.
  private async resolveScope(actor: AuthUser, q: ListFilter): Promise<ListFilter> {
    if (canViewAllRecords(actor)) {
      return q;
    }
    if (actor.roles.includes(RoleName.SALES_ADMIN) || actor.permissions?.includes('expense.read.ownpod')) {
      const [memberships, assignments] = await Promise.all([
        this.prisma.podMember.findMany({ where: { salesId: actor.userId }, select: { podId: true } }),
        this.prisma.podPositionAssignment.findMany({ where: { userId: actor.userId, status: 'ACTIVE' }, select: { podId: true } }),
      ]);
      const managedPodIds = Array.from(new Set([...memberships.map((m) => m.podId), ...assignments.map((a) => a.podId)]));
      const podId = q.podId && managedPodIds.includes(q.podId) ? q.podId : undefined;
      return { ...q, salesId: undefined, unitId: undefined, podId, podIdIn: podId ? undefined : managedPodIds };
    }
    return { ...q, salesId: actor.userId, unitId: undefined };
  }

  private buildWhere(filter: ListFilter): Prisma.ExpenseWhereInput {
    // No explicit status -> only SETTLED (fully wound down) shows by default. APPROVED
    // is no longer a resting state (final approval step settles directly), so it's
    // dropped from this default - an explicit ?status=APPROVED still finds any
    // leftover historical row.
    const statusFilter = filter.status === 'ALL' ? undefined : filter.status ? filter.status : ExpenseStatus.SETTLED;
    return {
      salesId: filter.salesId,
      status: statusFilter,
      unitId: filter.unitId,
      podId: filter.podIdIn ? { in: filter.podIdIn } : filter.podId,
      expenseDate:
        filter.fromDate || filter.toDate
          ? {
              gte: filter.fromDate ? new Date(filter.fromDate) : undefined,
              lte: filter.toDate ? new Date(filter.toDate) : undefined,
            }
          : undefined,
      bankTransactions:
        filter.matched === 'MATCHED'
          ? { some: { status: { in: MATCHED_TXN_STATUSES } } }
          : filter.matched === 'UNMATCHED'
          ? { none: { status: { in: MATCHED_TXN_STATUSES } } }
          : undefined,
      ...(filter.search
        ? {
            OR: [
              { expenseNo: { contains: filter.search, mode: 'insensitive' } },
              { purpose: { contains: filter.search, mode: 'insensitive' } },
              { sales: { name: { contains: filter.search, mode: 'insensitive' } } },
              { advertiser: { name: { contains: filter.search, mode: 'insensitive' } } },
              { brand: { name: { contains: filter.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  // Streams the same filtered rows as findAll() into a workbook for the "Export to
  // Excel" button on the Expense page.
  async exportWorkbook(actor: AuthUser, rawFilter: ListFilter) {
    const filter = await this.resolveScope(actor, rawFilter);
    const rows = await this.prisma.expense.findMany({
      where: this.buildWhere(filter),
      include,
      orderBy: { createdAt: 'desc' },
    });

    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Expenses');
    sheet.columns = [
      { header: 'Expense No', key: 'expenseNo', width: 20 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Sales', key: 'sales', width: 20 },
      { header: 'POD', key: 'pod', width: 16 },
      { header: 'Advertiser', key: 'advertiser', width: 20 },
      { header: 'Brand', key: 'brand', width: 20 },
      { header: 'Purpose', key: 'purpose', width: 30 },
      { header: 'Amount', key: 'amount', width: 16 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Matching', key: 'matching', width: 12 },
      { header: 'Settlement No', key: 'settlement', width: 20 },
    ];
    for (const r of rows) {
      sheet.addRow({
        expenseNo: r.expenseNo,
        date: formatDateDDMMYYYY(r.expenseDate),
        sales: r.sales?.name,
        pod: r.pod?.name ?? '',
        advertiser: r.advertiser?.name,
        brand: r.brand?.name,
        purpose: r.purpose,
        amount: Number(r.amount),
        status: r.status,
        matching: r.bankTransactions.some((t) => MATCHED_TXN_STATUSES.includes(t.status)) ? 'Matched' : 'Not Matched',
        settlement: r.settlement?.settlementNo ?? '',
      });
    }
    sheet.getRow(1).font = { bold: true };
    return workbook.xlsx.writeBuffer();
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id }, include });
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  // BR-001/BR-002/BR-003: Sales required, Unit from profile, Advertiser/Brand from Master Data.
  // Pre-Event is no longer part of the Expense flow at all (retired - the Event
  // module/table still exists for any historical data, but Expense creation never
  // reads from it anymore) - unitId/advertiserId/brandId/activityTypeId are always
  // supplied directly by the caller.
  //
  // Admin/Finance may pass dto.salesId to create on behalf of another Sales (historical /
  // corrective entry, BRD section 5.3) - ignored for a plain Sales caller, who can only
  // ever create their own.
  async create(dto: CreateExpenseDto, actorId: string, actorRoles: string[]) {
    const targetSalesId = this.isBackOffice(actorRoles) && dto.salesId ? dto.salesId : actorId;

    if (!dto.unitId || !dto.advertiserId || !dto.brandId || !dto.activityTypeId) {
      throw new BadRequestException('unitId, advertiserId, brandId and activityTypeId are required');
    }
    const unitId = dto.unitId;
    const advertiserId = dto.advertiserId;
    const brandId = dto.brandId;
    const activityTypeId = dto.activityTypeId;
    const departmentId = dto.departmentId;
    const podId = dto.podId;

    if (dto.paymentMethodType === 'CREDIT_CARD' && dto.creditCardId) {
      await this.assertCreditCardMatchesPod(dto.creditCardId, podId);
    }

    const expenseNo = await this.generateExpenseNo();

    const expense = await this.prisma.expense.create({
      data: {
        expenseNo,
        salesId: targetSalesId,
        unitId,
        podId,
        departmentId,
        advertiserId,
        brandId,
        activityTypeId,
        costCenterId: dto.costCenterId,
        paymentMethodType: dto.paymentMethodType,
        paymentMethodNote: dto.paymentMethodNote,
        creditCardId: dto.creditCardId,
        merchantName: dto.merchantName,
        location: dto.location,
        expenseDate: new Date(dto.expenseDate),
        purpose: dto.purpose,
        amount: dto.amount,
        items: dto.items ? { create: dto.items } : undefined,
        extraBrands: dto.extraBrandIds?.length
          ? { create: dto.extraBrandIds.map((brandId) => ({ brandId })) }
          : undefined,
        extraAgencies: dto.extraAgencyIds?.length
          ? { create: dto.extraAgencyIds.map((agencyId) => ({ agencyId })) }
          : undefined,
        extraAdvertisers: dto.extraAdvertiserIds?.length
          ? { create: dto.extraAdvertiserIds.map((advertiserId) => ({ advertiserId })) }
          : undefined,
        participants: dto.participants?.length ? { create: dto.participants } : undefined,
      },
      include,
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Expense', objectId: expense.id, newValue: expense });
    return expense;
  }

  async update(id: string, dto: UpdateExpenseDto, actorId: string, actorRoles: string[], actorPermissions: string[] = []) {
    const before = await this.findOne(id);
    if (before.salesId !== actorId && !(await this.canEditExpense(before, actorId, actorRoles, actorPermissions))) {
      throw new ForbiddenException('Not owner of this expense');
    }
    if (LOCKED_STATUSES.includes(before.status)) {
      throw new BadRequestException(`Expense in status ${before.status} cannot be edited`);
    }

    const nextStatus = before.status === ExpenseStatus.REJECTED ? ExpenseStatus.REVISION : before.status;

    const effectivePaymentMethod = dto.paymentMethodType ?? before.paymentMethodType;
    const effectiveCreditCardId = dto.creditCardId ?? before.creditCardId;
    if (effectivePaymentMethod === 'CREDIT_CARD' && effectiveCreditCardId) {
      await this.assertCreditCardMatchesPod(effectiveCreditCardId, before.podId);
    }

    const expense = await this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.expenseItem.deleteMany({ where: { expenseId: id } });
      }
      if (dto.extraBrandIds) {
        await tx.expenseBrand.deleteMany({ where: { expenseId: id } });
      }
      if (dto.extraAgencyIds) {
        await tx.expenseAgency.deleteMany({ where: { expenseId: id } });
      }
      if (dto.extraAdvertiserIds) {
        await tx.expenseAdvertiser.deleteMany({ where: { expenseId: id } });
      }
      if (dto.participants) {
        await tx.expenseParticipant.deleteMany({ where: { expenseId: id } });
      }
      await tx.expense.update({
        where: { id },
        data: {
          costCenterId: dto.costCenterId,
          paymentMethodType: dto.paymentMethodType,
          paymentMethodNote: dto.paymentMethodNote,
          creditCardId: dto.creditCardId,
          merchantName: dto.merchantName,
          location: dto.location,
          expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : undefined,
          purpose: dto.purpose,
          amount: dto.amount,
          status: nextStatus,
          items: dto.items ? { create: dto.items } : undefined,
          extraBrands: dto.extraBrandIds?.length
            ? { create: dto.extraBrandIds.map((brandId) => ({ brandId })) }
            : undefined,
          extraAgencies: dto.extraAgencyIds?.length
            ? { create: dto.extraAgencyIds.map((agencyId) => ({ agencyId })) }
            : undefined,
          extraAdvertisers: dto.extraAdvertiserIds?.length
            ? { create: dto.extraAdvertiserIds.map((advertiserId) => ({ advertiserId })) }
            : undefined,
          participants: dto.participants?.length ? { create: dto.participants } : undefined,
        },
      });

      // Being bank-matched is the only gate into the approval chain now - a
      // REJECTED, already-matched Expense re-enters immediately on edit instead
      // of resting at REVISION waiting for a Submit click (removed entirely).
      if (before.status === ExpenseStatus.REJECTED && before.isMatched) {
        await this.approvals.enterExpenseApproval(tx, {
          expenseId: id,
          amount: dto.amount ?? before.amount,
          podId: before.podId,
          departmentId: before.departmentId,
        });
      }

      return tx.expense.findUniqueOrThrow({ where: { id }, include });
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Expense', objectId: id, oldValue: before, newValue: expense });
    return expense;
  }

  // 1 POD = 1 credit card: a Sales in a given POD may only pay by that POD's own card.
  private async assertCreditCardMatchesPod(creditCardId: string, podId?: string | null) {
    const card = await this.prisma.creditCard.findUnique({ where: { id: creditCardId } });
    if (!card) throw new NotFoundException('Credit card not found');
    if (!card.podId || card.podId !== podId) {
      throw new BadRequestException("Selected credit card is not assigned to this Sales' POD");
    }
  }

  // Foto Kegiatan (activity photos) - stored separately from Invoice/InvoiceFile,
  // multiple per Expense, editable while the Expense is still in a DRAFT-ish state.
  async addPhoto(
    expenseId: string,
    file: Express.Multer.File,
    actorId: string,
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    const expense = await this.getEditableExpenseOrThrow(expenseId, actorId, actorRoles, actorPermissions);

    const stored = await this.storage.save(file.buffer, `photo/${expense.id}`, file.originalname);

    const photo = await this.prisma.expensePhoto.create({
      data: {
        expenseId: expense.id,
        storageKey: stored.storageKey,
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: stored.size,
        checksum: stored.checksum,
      },
    });

    await this.audit.log({ userId: actorId, action: 'UPLOAD', objectType: 'ExpensePhoto', objectId: photo.id, newValue: photo });
    return photo;
  }

  async getPhotoForDownload(photoId: string, actor: AuthUser) {
    const photo = await this.prisma.expensePhoto.findUnique({
      where: { id: photoId },
      include: { expense: { select: { salesId: true, podId: true } } },
    });
    if (!photo) throw new NotFoundException('Photo not found');
    if (!(await canAccessExpenseOwnedRecord(this.prisma, actor, photo.expense))) {
      throw new ForbiddenException('Not authorized to access this photo');
    }
    return { path: this.storage.resolvePath(photo.storageKey), fileName: photo.fileName, mimeType: photo.mimeType };
  }

  private async getEditableExpenseOrThrow(
    expenseId: string,
    actorId: string,
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.salesId !== actorId && !(await this.canEditExpense(expense, actorId, actorRoles, actorPermissions))) {
      throw new ForbiddenException('Not owner of this expense');
    }
    if (LOCKED_STATUSES.includes(expense.status)) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be modified`);
    }
    return expense;
  }

  private isBackOffice(actorRoles: string[]): boolean {
    return actorRoles.some((r) => r === 'ADMIN' || r === 'FINANCE');
  }

  // expense.edit.all / expense.edit.ownpod (Role/Permission master) - .all grants
  // edit access on any Sales' Expense the same way ADMIN/FINANCE already does;
  // .ownpod extends that to just the Expenses whose POD the actor is a member of
  // (PodMember - same table ExpensesService's resolveScope() reads for listing).
  private async canEditExpense(
    expense: { podId: string | null },
    actorId: string,
    actorRoles: string[],
    actorPermissions: string[],
  ): Promise<boolean> {
    if (this.isBackOffice(actorRoles) || actorPermissions.includes('expense.edit.all')) return true;
    if (actorPermissions.includes('expense.edit.ownpod') && expense.podId) {
      const membership = await this.prisma.podMember.findFirst({ where: { salesId: actorId, podId: expense.podId } });
      if (membership) return true;
    }
    return false;
  }

  private async generateExpenseNo(): Promise<string> {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await this.prisma.expense.count({ where: { expenseNo: { startsWith: `EXP-${yyyymm}-` } } });
    return `EXP-${yyyymm}-${String(count + 1).padStart(4, '0')}`;
  }
}
