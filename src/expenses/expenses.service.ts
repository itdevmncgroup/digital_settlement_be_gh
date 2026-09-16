import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExpenseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canViewAllRecords, canAccessExpenseOwnedRecord, getActorDepartmentIds } from '../common/rbac/scope.util';
import { RoleName } from '../common/constants/role-name';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';

type ListFilter = {
  salesId?: string;
  status?: ExpenseStatus | 'ALL';
  unitId?: string;
  departmentId?: string;
  departmentIdIn?: string[];
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
  paymentMethod: true,
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

  // Back office (Admin/Finance/Supervisor/Management) sees everything, scoped
  // only by whatever query params they pass. Sales Admin is Department-scoped:
  // not a global back-office role, but should see every Sales' expense within
  // their own Department(s) (their own UserDepartment membership(s)), not just
  // their own records. A plain expense.read.owndept permission holder (e.g. a
  // HEAD_POD/BOD Role approving for their Department - DepartmentPositionAssignment,
  // not UserDepartment) gets the same Department-wide scoping via whichever
  // of the two sources actually covers them. Everyone else (plain Sales) only
  // ever sees their own.
  private async resolveScope(actor: AuthUser, q: ListFilter): Promise<ListFilter> {
    if (canViewAllRecords(actor)) {
      return q;
    }
    if (actor.roles.includes(RoleName.SALES_ADMIN) || actor.permissions?.includes('expense.read.owndept')) {
      const managedDepartmentIds = await this.getManagedDepartmentIds(actor.userId);
      // No Department on the actor's own profile and no per-Department assignment
      // means their position sits above Department level (e.g. Co-Chief Sales
      // Officer) - they see every Department, same as a back-office role.
      if (managedDepartmentIds.length === 0) {
        return q;
      }
      const departmentId = q.departmentId && managedDepartmentIds.includes(q.departmentId) ? q.departmentId : undefined;
      return { ...q, salesId: undefined, unitId: undefined, departmentId, departmentIdIn: departmentId ? undefined : managedDepartmentIds };
    }
    return { ...q, salesId: actor.userId, unitId: undefined };
  }

  // A caller's "own Department(s)" for *.owndept permissions - either their
  // own UserDepartment membership(s) (e.g. SALES_ADMIN) or every Department
  // they hold an active approval Position for (DepartmentPositionAssignment -
  // e.g. HEAD_POD), same two sources resolveScope() already reads for listing.
  private getManagedDepartmentIds(actorId: string): Promise<string[]> {
    return getActorDepartmentIds(this.prisma, actorId);
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
      departmentId: filter.departmentIdIn ? { in: filter.departmentIdIn } : filter.departmentId,
      expenseDate:
        filter.fromDate || filter.toDate
          ? {
              gte: filter.fromDate ? new Date(filter.fromDate) : undefined,
              lte: filter.toDate ? new Date(filter.toDate) : undefined,
            }
          : undefined,
      // isMatched is the source of truth (also true for a manual match with no
      // billing-statement transaction at all - e.g. e-wallet/personal
      // reimbursement), so filter on it directly rather than the bankTransactions
      // relation, which is empty in that case.
      isMatched: filter.matched === 'MATCHED' ? true : filter.matched === 'UNMATCHED' ? false : undefined,
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
      { header: 'Department', key: 'department', width: 16 },
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
        department: r.department?.name ?? '',
        advertiser: r.advertiser?.name,
        brand: r.brand?.name,
        purpose: r.purpose,
        amount: Number(r.amount),
        status: r.status,
        matching: r.isMatched ? 'Matched' : 'Not Matched',
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
  async create(dto: CreateExpenseDto, actorId: string, actorRoles: string[], actorPermissions: string[] = []) {
    const targetSalesId = this.isBackOffice(actorRoles) && dto.salesId ? dto.salesId : actorId;

    if (!dto.unitId || !dto.advertiserId || !dto.brandId || !dto.activityTypeId) {
      throw new BadRequestException('unitId, advertiserId, brandId and activityTypeId are required');
    }
    const unitId = dto.unitId;
    const advertiserId = dto.advertiserId;
    const brandId = dto.brandId;
    const activityTypeId = dto.activityTypeId;
    const departmentId = dto.departmentId;

    await this.assertCanCreateForDepartment(actorId, actorRoles, actorPermissions, departmentId);

    const paymentMethod = dto.paymentMethodId
      ? await this.prisma.paymentMethod.findUnique({ where: { id: dto.paymentMethodId } })
      : null;
    if (paymentMethod?.code === 'CORPORATE_CARD' && dto.creditCardId) {
      await this.assertCreditCardMatchesDepartment(dto.creditCardId, departmentId);
    }

    const expenseNo = await this.generateExpenseNo();

    const expense = await this.prisma.expense.create({
      data: {
        expenseNo,
        salesId: targetSalesId,
        unitId,
        departmentId,
        advertiserId,
        brandId,
        activityTypeId,
        costCenterId: dto.costCenterId,
        paymentMethodId: dto.paymentMethodId,
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

    // Submitting IS creating - the approval chain (HEAD_POD -> CO-CSO-1 ->
    // CO-CSO-2) starts right away, so a new Expense is never a DRAFT sitting
    // outside the workflow. Bank matching comes later, once that chain is done
    // (see BankMatchingService.afterMatchChange).
    await this.prisma.$transaction((tx) =>
      this.approvals.enterExpenseApproval(tx, { expenseId: expense.id, amount: expense.amount, departmentId: expense.departmentId }),
    );

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Expense', objectId: expense.id, newValue: expense });
    return this.findOne(expense.id);
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

    const effectivePaymentMethodId = dto.paymentMethodId ?? before.paymentMethodId;
    const effectivePaymentMethod = effectivePaymentMethodId
      ? await this.prisma.paymentMethod.findUnique({ where: { id: effectivePaymentMethodId } })
      : null;
    const effectiveCreditCardId = dto.creditCardId ?? before.creditCardId;
    if (effectivePaymentMethod?.code === 'CORPORATE_CARD' && effectiveCreditCardId) {
      await this.assertCreditCardMatchesDepartment(effectiveCreditCardId, before.departmentId);
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
          paymentMethodId: dto.paymentMethodId,
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
          departmentId: before.departmentId,
        });
      }

      return tx.expense.findUniqueOrThrow({ where: { id }, include });
    });

    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Expense', objectId: id, oldValue: before, newValue: expense });
    return expense;
  }

  // 1 Department = 1 credit card: a Sales in a given Department may only pay
  // by that Department's own card.
  private async assertCreditCardMatchesDepartment(creditCardId: string, departmentId?: string | null) {
    const card = await this.prisma.creditCard.findUnique({ where: { id: creditCardId } });
    if (!card) throw new NotFoundException('Credit card not found');
    if (!card.departmentId || card.departmentId !== departmentId) {
      throw new BadRequestException("Selected credit card is not assigned to this Sales' Department");
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
      include: { expense: { select: { salesId: true, departmentId: true } } },
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

  // expense.create.all / expense.create.owndept (Role/Permission master) - lets
  // a caller outside the route's @Roles(SALES/ADMIN/FINANCE) gate (e.g. a
  // HEAD_POD/Management holder wanting to log an Expense on their Department's
  // behalf) reach ExpensesController.create at all; RolesGuard already OR's that
  // in. .all is unrestricted like ADMIN/FINANCE; .owndept is only checked here
  // because the guard can't see *which* departmentId the request body carries -
  // it must be one of the actor's own (see getManagedDepartmentIds). SALES/
  // ADMIN/FINANCE (the @Roles gate) stay unrestricted, same as before this
  // permission pair existed.
  private async assertCanCreateForDepartment(actorId: string, actorRoles: string[], actorPermissions: string[], departmentId?: string | null) {
    if (this.isBackOffice(actorRoles) || actorRoles.includes(RoleName.SALES)) return;
    if (actorPermissions.includes('expense.create.all')) return;
    if (actorPermissions.includes('expense.create.owndept')) {
      const managedDepartmentIds = await this.getManagedDepartmentIds(actorId);
      if (departmentId && managedDepartmentIds.includes(departmentId)) return;
      throw new ForbiddenException('Cannot create an Expense for a Department outside your own');
    }
  }

  // expense.edit.all / expense.edit.owndept (Role/Permission master) - .all
  // grants edit access on any Sales' Expense the same way ADMIN/FINANCE
  // already does; .owndept extends that to just the Expenses whose Department
  // the actor belongs to (UserDepartment - same source ExpensesService's
  // resolveScope() reads for listing).
  private async canEditExpense(
    expense: { departmentId: string | null },
    actorId: string,
    actorRoles: string[],
    actorPermissions: string[],
  ): Promise<boolean> {
    if (this.isBackOffice(actorRoles) || actorPermissions.includes('expense.edit.all')) return true;
    if (actorPermissions.includes('expense.edit.owndept') && expense.departmentId) {
      const actorDeptIds = await getActorDepartmentIds(this.prisma, actorId);
      if (actorDeptIds.includes(expense.departmentId)) return true;
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
