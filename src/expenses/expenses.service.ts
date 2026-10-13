import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExpenseRequestStatus, ExpenseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { canViewAllRecords, canAccessExpenseOwnedRecord, getActorDepartmentIds, canUploadExpenseFiles, canCompletePendingSalesAdmin } from '../common/rbac/scope.util';
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
  // Corsec only sees the Expenses raised from an Expense Request.
  requestLinkedOnly?: boolean;
  // A caller without any wider scope sees the Expenses they own (salesId) OR keyed in
  // themselves on someone else's behalf (createdById, expense.create.* holders).
  ownOrInputtedBy?: string;
};

const POSITION_CORSEC = 'CORSEC';
// Positions (Position.code) that can be the requestor of an Expense keyed in on their behalf.
const REQUESTOR_POSITION_CODES = ['SLS', 'STAFF', 'CO-CSO'];

const include = {
  sales: { select: { id: true, name: true, employeeId: true } },
  createdBy: { select: { id: true, name: true } },
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
  settlement: { select: { id: true, settlementNo: true, status: true, odooSyncStatus: true, odooSyncError: true, sentAt: true } },
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
    private readonly notifications: NotificationsService,
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
    if ((await this.positionCodeOf(actor.userId)) === POSITION_CORSEC) {
      return { ...q, salesId: undefined, unitId: undefined, requestLinkedOnly: true };
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
    return { ...q, salesId: undefined, unitId: undefined, ownOrInputtedBy: actor.userId };
  }

  // A caller's "own Department(s)" for *.owndept permissions - either their
  // own UserDepartment membership(s) (e.g. SALES_ADMIN) or every Department
  // they hold an active approval Position for (DepartmentPositionAssignment -
  // e.g. HEAD_POD), same two sources resolveScope() already reads for listing.
  private getManagedDepartmentIds(actorId: string): Promise<string[]> {
    return getActorDepartmentIds(this.prisma, actorId);
  }

  private async positionCodeOf(userId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { position: { select: { code: true } } } });
    return user?.position?.code;
  }

  private buildWhere(filter: ListFilter): Prisma.ExpenseWhereInput {
    // No explicit status -> only SETTLED (fully wound down) shows by default. APPROVED
    // is no longer a resting state (final approval step settles directly), so it's
    // dropped from this default - an explicit ?status=APPROVED still finds any
    // leftover historical row.
    const statusFilter = filter.status === 'ALL' ? undefined : filter.status ? filter.status : ExpenseStatus.SETTLED;

    const and: Prisma.ExpenseWhereInput[] = [];
    if (filter.ownOrInputtedBy) {
      and.push({ OR: [{ salesId: filter.ownOrInputtedBy }, { createdById: filter.ownOrInputtedBy }] });
    }
    if (filter.fromDate || filter.toDate) {
      // toDate is a calendar day ("YYYY-MM-DD" -> parsed as that day's UTC
      // midnight) - `lt` the *next* day instead of `lte` the parsed instant so
      // the whole day is included even if an expenseDate/createdAt carries a
      // time-of-day past midnight (e.g. demo/seed data, or any future write
      // that isn't strictly normalised to midnight).
      const toDateExclusive = filter.toDate ? new Date(filter.toDate) : undefined;
      toDateExclusive?.setDate(toDateExclusive.getDate() + 1);
      and.push({
        expenseDate: {
          gte: filter.fromDate ? new Date(filter.fromDate) : undefined,
          lt: toDateExclusive,
        },
      });
    }
    if (filter.search) {
      and.push({
        OR: [
          { expenseNo: { contains: filter.search, mode: 'insensitive' } },
          { purpose: { contains: filter.search, mode: 'insensitive' } },
          { sales: { name: { contains: filter.search, mode: 'insensitive' } } },
          { advertiser: { name: { contains: filter.search, mode: 'insensitive' } } },
          { brand: { name: { contains: filter.search, mode: 'insensitive' } } },
        ],
      });
    }

    return {
      salesId: filter.salesId,
      status: statusFilter,
      unitId: filter.unitId,
      departmentId: filter.departmentIdIn ? { in: filter.departmentIdIn } : filter.departmentId,
      // isMatched is the source of truth (also true for a manual match with no
      // billing-statement transaction at all - e.g. e-wallet/personal
      // reimbursement), so filter on it directly rather than the bankTransactions
      // relation, which is empty in that case.
      expenseRequestId: filter.requestLinkedOnly ? { not: null } : undefined,
      isMatched: filter.matched === 'MATCHED' ? true : filter.matched === 'UNMATCHED' ? false : undefined,
      ...(and.length > 0 ? { AND: and } : {}),
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
  // reads from it anymore) - advertiserId/brandId/activityTypeId are always
  // supplied directly by the caller; unitId is optional from the caller (web still
  // sends one) and falls back to the target Sales's own profile Unit (mobile has
  // no Unit field at all).
  //
  // dto.salesId (the requestor) lets the caller key the Expense in on another user's behalf:
  // Admin (historical / corrective entry, BRD section 5.3), expense.create.all (any user),
  // or expense.create.owndept (a Sales of the Expense's own Department, see
  // resolveRequestorId). The requestor (salesId) stays that user; the caller is recorded
  // as createdById. Ignored for anyone else, who can only ever create their own.
  async create(dto: CreateExpenseDto, actorId: string, actorRoles: string[], actorPermissions: string[] = []) {
    if (dto.expenseRequestId) return this.createFromExpenseRequest(dto, actorId, actorRoles);

    const targetSalesId = await this.resolveRequestorId(dto, actorId, actorRoles, actorPermissions);

    if (!dto.advertiserId || !dto.brandId || !dto.activityTypeId) {
      throw new BadRequestException('Advertiser, Brand and Activity Type are required');
    }
    // Payment method can stay empty while still a DRAFT (filled in later), but
    // is mandatory the moment an Expense enters the approval chain.
    if (!dto.isDraft && !dto.paymentMethodId) {
      throw new BadRequestException('paymentMethodId is required');
    }
    // Unit is BR-001 "from profile" - caller (web) may still pass one explicitly,
    // but mobile has no Unit field, so fall back to the target Sales's own Unit.
    const unitId = dto.unitId ?? (await this.prisma.user.findUnique({ where: { id: targetSalesId }, select: { unitId: true } }))?.unitId;
    if (!unitId) {
      throw new BadRequestException('Sales has no Unit assigned in profile - contact Admin');
    }
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
        createdById: actorId,
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

    // Submitting IS creating by default - the approval chain (HEAD_POD -> CO-CSO)
    // starts right away, so a new Expense only stays a DRAFT (still editable,
    // invisible to any approver) when the caller explicitly asks for that via
    // dto.isDraft. Bank matching comes later, once that chain is done (see
    // BankMatchingService.afterMatchChange).
    if (!dto.isDraft) {
      await this.prisma.$transaction((tx) =>
        this.approvals.enterExpenseApproval(tx, { expenseId: expense.id, amount: expense.amount, departmentId: expense.departmentId }),
      );
    }

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Expense', objectId: expense.id, newValue: expense });
    return this.findOne(expense.id);
  }

  // "Add Invoices" -> "Upload & Create Expense" on a PROCEED Expense Request: raises the
  // Expense exactly as POST /expenses with expenseRequestId would (purpose = activity type +
  // greeting, amount = Sales CS budget, else the requester's budget) and attaches the uploaded
  // files as one Invoice. The Sales Admin completes the amounts afterwards.
  async createFromExpenseRequestWithInvoices(
    requestId: string,
    files: Express.Multer.File[],
    photos: Express.Multer.File[],
    merchantName: string | undefined,
    actorId: string,
    actorRoles: string[],
  ) {
    if (!files?.length) throw new BadRequestException('Upload at least one invoice file');
    const request = await this.prisma.expenseRequest.findUnique({
      where: { id: requestId },
      select: { sendDate: true, greetingText: true, budgetAmount: true, requestBudget: true, activityType: { select: { name: true } } },
    });
    if (!request) throw new NotFoundException('Expense Request not found');

    // Defaults to AP Disbursement; the Sales Admin can still change it while completing the Expense.
    // Left empty (they must pick one before submitting) if that master row is missing.
    const defaultPaymentMethod = await this.prisma.paymentMethod.findFirst({
      where: { code: 'AP_DISBURSEMENT', isActive: true },
      select: { id: true },
    });

    const expense = await this.createFromExpenseRequest(
      {
        expenseRequestId: requestId,
        expenseDate: request.sendDate.toISOString(),
        purpose: `${request.activityType.name} - ${request.greetingText}`,
        amount: Number(request.budgetAmount ?? request.requestBudget ?? 0),
        merchantName,
        paymentMethodId: defaultPaymentMethod?.id,
      } as CreateExpenseDto,
      actorId,
      actorRoles,
    );

    try {
      await this.savePhotos(expense.id, photos ?? [], actorId);
      const invoice = await this.prisma.invoice.create({
        data: { expenseId: expense.id, finalMerchantName: merchantName, modifiedById: actorId, modifiedAt: new Date() },
      });
      await this.saveInvoiceFiles(expense.id, invoice.id, files, actorId);
    } catch (err) {
      // Don't leave an invoice-less Expense behind (it would also block the Request: 1 Request -> 1 Expense).
      await this.prisma.expense.delete({ where: { id: expense.id } }).catch(() => undefined);
      throw err;
    }
    return this.findOne(expense.id);
  }

  // "Update Invoice" on an Expense Request whose Expense a Sales Admin sent back
  // (REVISION, see ApprovalsService.revise): Corsec replaces the invoice files (and may
  // add Foto Product / change the vendor), then the Expense resumes at the tier that
  // sent it back - the Sales Admin's - instead of waiting for an unrelated edit.
  async updateInvoicesFromExpenseRequest(
    requestId: string,
    files: Express.Multer.File[],
    photos: Express.Multer.File[],
    merchantName: string | undefined,
    actorId: string,
    actorRoles: string[],
  ) {
    if (!this.isBackOffice(actorRoles) && (await this.positionCodeOf(actorId)) !== POSITION_CORSEC) {
      throw new ForbiddenException('Only Corsec can update the invoice of an Expense raised from an Expense Request');
    }
    if (!files?.length) throw new BadRequestException('Upload at least one invoice file');

    const request = await this.prisma.expenseRequest.findUnique({
      where: { id: requestId },
      select: { requestNo: true, expense: { select: { id: true, status: true } } },
    });
    if (!request) throw new NotFoundException('Expense Request not found');
    if (!request.expense) throw new BadRequestException(`Expense Request ${request.requestNo} has no Expense yet`);
    const expenseId = request.expense.id;
    if (request.expense.status !== ExpenseStatus.REVISION) {
      throw new BadRequestException(`Expense in status ${request.expense.status} was not sent back for revision`);
    }

    await this.savePhotos(expenseId, photos ?? [], actorId);

    // The existing Invoice row is kept (its totals may already be filled in by the Sales
    // Admin); only its files are replaced. The old file rows stay recoverable from the audit log.
    const existing = await this.prisma.invoice.findFirst({ where: { expenseId }, orderBy: { createdAt: 'asc' }, include: { files: true } });
    const invoiceId = existing
      ? existing.id
      : (
          await this.prisma.invoice.create({
            data: { expenseId, finalMerchantName: merchantName, modifiedById: actorId, modifiedAt: new Date() },
          })
        ).id;
    // New files first, so a failed upload never leaves the Invoice without any file.
    await this.saveInvoiceFiles(expenseId, invoiceId, files, actorId);
    if (existing) {
      for (const old of existing.files) {
        await this.prisma.invoiceFile.delete({ where: { id: old.id } });
        await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'InvoiceFile', objectId: old.id, oldValue: old });
      }
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { ...(merchantName ? { finalMerchantName: merchantName } : {}), modifiedById: actorId, modifiedAt: new Date() },
      });
    }

    await this.prisma.$transaction((tx) => this.approvals.resumeExpenseApproval(tx, { expenseId }));
    await this.audit.log({
      userId: actorId,
      action: 'UPDATE',
      objectType: 'Expense',
      objectId: expenseId,
      oldValue: { status: ExpenseStatus.REVISION },
      newValue: { invoiceUpdated: true },
    });
    return this.findOne(expenseId);
  }

  private async savePhotos(expenseId: string, photos: Express.Multer.File[], actorId: string) {
    for (const photo of photos) {
      const stored = await this.storage.save(photo.buffer, `photo/${expenseId}`, photo.originalname);
      const created = await this.prisma.expensePhoto.create({
        data: {
          expenseId,
          storageKey: stored.storageKey,
          fileName: photo.originalname,
          mimeType: photo.mimetype,
          size: stored.size,
          checksum: stored.checksum,
        },
      });
      await this.audit.log({ userId: actorId, action: 'UPLOAD', objectType: 'ExpensePhoto', objectId: created.id, newValue: created });
    }
  }

  private async saveInvoiceFiles(expenseId: string, invoiceId: string, files: Express.Multer.File[], actorId: string) {
    for (const file of files) {
      const stored = await this.storage.save(file.buffer, `invoice/${expenseId}`, file.originalname);
      const invoiceFile = await this.prisma.invoiceFile.create({
        data: {
          invoiceId,
          fileType: 'ORIGINAL',
          storageKey: stored.storageKey,
          fileName: file.originalname,
          mimeType: file.mimetype,
          size: stored.size,
          checksum: stored.checksum,
        },
      });
      await this.audit.log({ userId: actorId, action: 'UPLOAD', objectType: 'InvoiceFile', objectId: invoiceFile.id, newValue: invoiceFile });
    }
  }

  // Corsec raises an Expense from a PROCEED Expense Request (Karangan Bunga).
  // Everything that classifies it comes from the Request - date (= sendDate),
  // Department, Activity Type, Agency/Advertiser/Brand - and the Expense belongs
  // to the Request's requester (the Sales who entered it). It then waits in
  // PENDING_SALES_ADMIN with no approval chain yet: a Sales Admin of the same
  // Department completes it (payment method, amount, invoices...) and submits it
  // (submitDraft) into the normal EXPENSES chain.
  private async createFromExpenseRequest(dto: CreateExpenseDto, actorId: string, actorRoles: string[]) {
    if (!this.isBackOffice(actorRoles) && (await this.positionCodeOf(actorId)) !== POSITION_CORSEC) {
      throw new ForbiddenException('Only Corsec can create an Expense from an Expense Request');
    }
    const request = await this.prisma.expenseRequest.findUnique({
      where: { id: dto.expenseRequestId },
      include: {
        agencies: true,
        advertisers: true,
        brands: { include: { brand: { select: { id: true, advertiserId: true } } } },
        expense: { select: { expenseNo: true } },
        requestedBy: { select: { unitId: true } },
      },
    });
    if (!request) throw new NotFoundException('Expense Request not found');
    if (request.status !== ExpenseRequestStatus.PROCEED) {
      throw new BadRequestException(`Expense Request in status ${request.status} is not marked Proceed by Corsec yet`);
    }
    if (request.expense) {
      throw new ConflictException(`Expense Request ${request.requestNo} already has Expense ${request.expense.expenseNo}`);
    }
    if (!request.departmentId) throw new BadRequestException('Expense Request has no Department');
    const unitId = dto.unitId ?? request.requestedBy.unitId;
    if (!unitId) throw new BadRequestException('Sales has no Unit assigned in profile - contact Admin');

    // Expense holds one primary Advertiser/Brand (the first Brand picked and its
    // Advertiser); every other Brand/Advertiser/Agency on the Request rides along as an "extra".
    // Brand and Advertiser are both optional on a Request (an Agency alone is enough), so the
    // Expense's primary Advertiser/Brand may stay empty; the Agencies always ride along as extras.
    const [primaryBrand, ...otherBrands] = request.brands.map((b) => b.brand);
    const advertiserId = primaryBrand?.advertiserId ?? request.advertisers[0]?.advertiserId ?? null;
    const otherAdvertisers = request.advertisers.filter((a) => a.advertiserId !== advertiserId);

    let created;
    try {
      created = await this.prisma.expense.create({
        data: {
          expenseNo: await this.generateExpenseNo(),
          salesId: request.requestedById,
          unitId,
          departmentId: request.departmentId,
          advertiserId,
          brandId: primaryBrand?.id ?? null,
          activityTypeId: request.activityTypeId,
          expenseRequestId: request.id,
          expenseDate: request.sendDate,
          purpose: dto.purpose,
          amount: dto.amount,
          merchantName: dto.merchantName,
          paymentMethodId: dto.paymentMethodId,
          status: ExpenseStatus.PENDING_SALES_ADMIN,
          extraBrands: otherBrands.length ? { create: otherBrands.map((b) => ({ brandId: b.id })) } : undefined,
          extraAdvertisers: otherAdvertisers.length ? { create: otherAdvertisers.map((a) => ({ advertiserId: a.advertiserId })) } : undefined,
          extraAgencies: request.agencies.length ? { create: request.agencies.map((a) => ({ agencyId: a.agencyId })) } : undefined,
        },
        include,
      });
    } catch (err) {
      // Two Corsec users racing on the same Request: expenseRequestId is unique.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Expense Request ${request.requestNo} already has an Expense`);
      }
      throw err;
    }

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Expense', objectId: created.id, newValue: created });
    await this.notifySalesAdmins(created.id, created.expenseNo, request.departmentId, request.requestNo);
    return created;
  }

  // Every active Sales Admin of the Department is asked to complete the Expense.
  private async notifySalesAdmins(expenseId: string, expenseNo: string, departmentId: string, requestNo: string) {
    const salesAdmins = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        roles: { some: { role: { name: RoleName.SALES_ADMIN } } },
        departments: { some: { departmentId, status: 'ACTIVE' } },
      },
      select: { id: true },
    });
    for (const u of salesAdmins) {
      await this.notifications.notify({
        userId: u.id,
        type: 'EXPENSE_PENDING',
        title: 'Expense awaiting completion',
        body: `${expenseNo} (from ${requestNo}) was created by Corsec and needs to be completed and submitted.`,
        deepLink: `/expenses/${expenseId}`,
        objectType: 'Expense',
        objectId: expenseId,
      });
    }
  }

  // The one explicit "Submit" action a DRAFT Expense gets - moves it into the
  // approval chain. Editing a REJECTED Expense re-enters the chain automatically
  // (see update() below), but a DRAFT never does until this is called.
  async submitDraft(id: string, actorId: string, actorRoles: string[], actorPermissions: string[] = []) {
    const before = await this.findOne(id);
    await this.assertCanEdit(before, actorId, actorRoles, actorPermissions, true);
    if (before.status !== ExpenseStatus.DRAFT && before.status !== ExpenseStatus.PENDING_SALES_ADMIN) {
      throw new BadRequestException(`Expense in status ${before.status} is not a draft`);
    }
    if (!before.paymentMethodId) {
      throw new BadRequestException('paymentMethodId is required');
    }

    await this.prisma.$transaction((tx) =>
      this.approvals.enterExpenseApproval(tx, { expenseId: id, amount: before.amount, departmentId: before.departmentId }),
    );

    await this.audit.log({ userId: actorId, action: 'SUBMIT', objectType: 'Expense', objectId: id, oldValue: { status: before.status } });
    return this.findOne(id);
  }

  // Re-sends the current approval step's email/notification without advancing
  // the chain - lets the owner (or an override permission holder / ADMIN) nudge
  // an approver who hasn't acted yet. See ApprovalsService.resendNotification.
  async resendApprovalEmail(id: string, actorId: string, actorRoles: string[], actorPermissions: string[] = []) {
    await this.findOne(id);
    await this.approvals.resendNotification(actorId, actorRoles, actorPermissions, { expenseId: id });
    return { sent: true };
  }

  async update(id: string, dto: UpdateExpenseDto, actorId: string, actorRoles: string[], actorPermissions: string[] = []) {
    const before = await this.findOne(id);
    await this.assertCanEdit(before, actorId, actorRoles, actorPermissions, true);
    if (LOCKED_STATUSES.includes(before.status)) {
      throw new BadRequestException(`Expense in status ${before.status} cannot be edited`);
    }

    // REJECTED is terminal (and LOCKED_STATUSES above already blocks editing
    // it) - the only resting "sent back, awaiting edit" state reachable here is
    // REVISION, set by ApprovalsService.revise(). The field patch below leaves
    // status untouched; resumeExpenseApproval (further down) is what moves it
    // off REVISION once the chain resumes.
    const nextStatus = before.status;

    // Draft is still fully Sales' own working copy - core classification fields
    // may change. Anything past DRAFT keeps them frozen (they drive the
    // approval chain already entered).
    const isDraft = before.status === ExpenseStatus.DRAFT;
    if (isDraft && dto.departmentId !== undefined && dto.departmentId !== before.departmentId) {
      await this.assertCanCreateForDepartment(actorId, actorRoles, actorPermissions, dto.departmentId);
    }
    const effectiveDepartmentId = isDraft ? (dto.departmentId ?? before.departmentId) : before.departmentId;

    const effectivePaymentMethodId = dto.paymentMethodId ?? before.paymentMethodId;
    // A REVISION Expense re-enters the approval chain on this same call (see
    // the resumeExpenseApproval call below) - payment method must be filled by
    // then, even if it was left empty back when the Expense was still a DRAFT.
    if (before.status === ExpenseStatus.REVISION && !effectivePaymentMethodId) {
      throw new BadRequestException('paymentMethodId is required');
    }
    const effectivePaymentMethod = effectivePaymentMethodId
      ? await this.prisma.paymentMethod.findUnique({ where: { id: effectivePaymentMethodId } })
      : null;
    const effectiveCreditCardId = dto.creditCardId ?? before.creditCardId;
    if (effectivePaymentMethod?.code === 'CORPORATE_CARD' && effectiveCreditCardId) {
      await this.assertCreditCardMatchesDepartment(effectiveCreditCardId, effectiveDepartmentId);
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
          ...(isDraft
            ? {
                departmentId: dto.departmentId || undefined,
                unitId: dto.unitId || undefined,
                activityTypeId: dto.activityTypeId || undefined,
                advertiserId: dto.advertiserId || undefined,
                brandId: dto.brandId || undefined,
              }
            : {}),
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
      // REVISION, already-matched Expense resumes its existing chain at the
      // same tier Revise sent it back from (not a fresh restart from step 0 -
      // that path, enterExpenseApproval/createOrResetRequest, remains solely
      // for brand-new submissions).
      if (before.status === ExpenseStatus.REVISION && before.isMatched) {
        await this.approvals.resumeExpenseApproval(tx, { expenseId: id });
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
    const completesPending = await canCompletePendingSalesAdmin(this.prisma, { userId: actorId, roles: actorRoles }, expense);
    if (!completesPending && !canUploadExpenseFiles(expense, { userId: actorId, roles: actorRoles, permissions: actorPermissions })) {
      throw new ForbiddenException('Uploading photos requires edit permission on this expense');
    }

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
      include: { expense: { select: { salesId: true, createdById: true, departmentId: true } } },
    });
    if (!photo) throw new NotFoundException('Photo not found');
    if (!(await canAccessExpenseOwnedRecord(this.prisma, actor, { ...photo.expense, expenseId: photo.expenseId }))) {
      throw new ForbiddenException('Not authorized to access this photo');
    }
    const buffer = await this.storage.read(photo.storageKey);
    return { buffer, fileName: photo.fileName, mimeType: photo.mimeType };
  }

  private async getEditableExpenseOrThrow(
    expenseId: string,
    actorId: string,
    actorRoles: string[] = [],
    actorPermissions: string[] = [],
  ) {
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertCanEdit(expense, actorId, actorRoles, actorPermissions);
    if (LOCKED_STATUSES.includes(expense.status)) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be modified`);
    }
    return expense;
  }

  private isBackOffice(actorRoles: string[]): boolean {
    return actorRoles.includes('ADMINISTRATOR');
  }

  private async resolveRequestorId(
    dto: { salesId?: string; departmentId?: string },
    actorId: string,
    actorRoles: string[],
    actorPermissions: string[],
  ): Promise<string> {
    if (!dto.salesId || dto.salesId === actorId) return actorId;
    const canAny = this.isBackOffice(actorRoles) || actorPermissions.includes('expense.create.all');
    if (!canAny && !actorPermissions.includes('expense.create.owndept')) return actorId;

    const requestor = await this.prisma.user.findUnique({
      where: { id: dto.salesId },
      select: {
        status: true,
        position: { select: { code: true } },
        departments: { where: { status: 'ACTIVE' }, select: { departmentId: true } },
      },
    });
    if (!requestor || requestor.status !== 'ACTIVE') {
      throw new BadRequestException('Requestor not found or inactive');
    }
    if (!requestor.position || !REQUESTOR_POSITION_CODES.includes(requestor.position.code)) {
      throw new BadRequestException('Requestor must hold a Sales, Staff or Co-CSO position');
    }
    if (!canAny) {
      // .owndept: the Expense's Department must be one of the caller's own, and the
      // requestor must belong to it (checked here, not left to
      // assertCanCreateForDepartment, which exempts the SALES role).
      const managedDepartmentIds = await this.getManagedDepartmentIds(actorId);
      if (!dto.departmentId || !managedDepartmentIds.includes(dto.departmentId)) {
        throw new ForbiddenException('Cannot create an Expense for a Department outside your own');
      }
      if (!requestor.departments.some((d) => d.departmentId === dto.departmentId)) {
        throw new ForbiddenException('Requestor is not a member of the selected Department');
      }
    }
    return dto.salesId;
  }

  // Users the caller may pick as requestor in the New Expense form: active users holding a
  // Sales / Staff / Co-CSO position (REQUESTOR_POSITION_CODES). expense.create.all / Admin ->
  // any of them; expense.create.owndept -> only those sharing a Department with the caller.
  // Mirrors resolveRequestorId's rules.
  async listRequestors(actorId: string, actorRoles: string[], actorPermissions: string[]) {
    const canAny = this.isBackOffice(actorRoles) || actorPermissions.includes('expense.create.all');
    let departmentFilter: Prisma.UserWhereInput = {};
    if (!canAny) {
      if (!actorPermissions.includes('expense.create.owndept')) return [];
      const managedDepartmentIds = await this.getManagedDepartmentIds(actorId);
      if (managedDepartmentIds.length === 0) return [];
      departmentFilter = { departments: { some: { departmentId: { in: managedDepartmentIds }, status: 'ACTIVE' } } };
    }
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', position: { code: { in: REQUESTOR_POSITION_CODES } }, ...departmentFilter },
      select: {
        id: true,
        name: true,
        employeeId: true,
        unitId: true,
        departments: { where: { status: 'ACTIVE' }, select: { departmentId: true } },
      },
      orderBy: { name: 'asc' },
    });
    return users.map(({ departments, ...u }) => ({ ...u, departmentIds: departments.map((d) => d.departmentId) }));
  }

  // expense.create.all / .own / .owndept (Role/Permission master) - lets
  // a caller outside the route's @Roles(SALES/ADMIN) gate (e.g. a
  // HEAD_POD/Management holder wanting to log an Expense on their Department's
  // behalf) reach ExpensesController.create at all; RolesGuard already OR's that
  // in. .all is unrestricted like ADMIN; .owndept is only checked here
  // because the guard can't see *which* departmentId the request body carries -
  // it must be one of the actor's own (see getManagedDepartmentIds). SALES/
  // ADMIN (the @Roles gate) stay unrestricted, same as before this
  // permission pair existed.
  private async assertCanCreateForDepartment(actorId: string, actorRoles: string[], actorPermissions: string[], departmentId?: string | null) {
    if (this.isBackOffice(actorRoles) || actorRoles.includes(RoleName.SALES)) return;
    if (actorPermissions.includes('expense.create.all')) return;
    // .own (own Expense only - resolveRequestorId never lets it pick another requestor) is
    // still confined to the caller's own Department(s), same as .owndept.
    if (actorPermissions.includes('expense.create.owndept') || actorPermissions.includes('expense.create.own')) {
      const managedDepartmentIds = await this.getManagedDepartmentIds(actorId);
      if (departmentId && managedDepartmentIds.includes(departmentId)) return;
      throw new ForbiddenException('Cannot create an Expense for a Department outside your own');
    }
  }

  // Owner edits are unrestricted (until LOCKED_STATUSES) unless the actor holds
  // expense.edit.own - that permission means "own Expense only, and only until
  // the first approver has approved it". Non-owners fall through to
  // canEditExpense (.all / .owndept / back office) as before.
  //
  // A PENDING_SALES_ADMIN Expense (raised by Corsec from an Expense Request) is
  // completed by a SALES_ADMIN of its Department, owner or not. `routeGate` is for
  // the PATCH/submit routes, whose @Roles list now also admits SALES_ADMIN purely
  // for that case: such a role-only caller must not edit anything else.
  private async assertCanEdit(
    expense: { id: string; salesId: string; createdById?: string | null; departmentId: string | null; status?: ExpenseStatus },
    actorId: string,
    actorRoles: string[],
    actorPermissions: string[],
    routeGate = false,
  ) {
    if (expense.status && (await canCompletePendingSalesAdmin(this.prisma, { userId: actorId, roles: actorRoles }, { status: expense.status, departmentId: expense.departmentId }))) {
      return;
    }
    // The inputter (createdById) of an Expense keyed in on someone else's behalf (see
    // create) keeps working on it like its owner does - they hold expense.create.* by
    // construction, which is what let them key it in at all.
    const isInputter = expense.createdById === actorId;
    if (
      routeGate &&
      !isInputter &&
      !actorRoles.includes(RoleName.SALES) &&
      !this.isBackOffice(actorRoles) &&
      !actorPermissions.some((p) => p === 'expense.edit.all' || p === 'expense.edit.own')
    ) {
      throw new ForbiddenException('Requires permission [expense.edit.all, expense.edit.own]');
    }
    if (expense.salesId === actorId || isInputter) {
      const canEditBroadly = this.isBackOffice(actorRoles) || actorPermissions.includes('expense.edit.all');
      if (actorPermissions.includes('expense.edit.own') && !canEditBroadly) {
        const approvedCount = await this.prisma.approvalAction.count({
          where: { approvalRequest: { expenseId: expense.id }, action: 'APPROVE' },
        });
        if (approvedCount > 0) {
          throw new ForbiddenException('Expense can no longer be edited - the first approver has already approved it');
        }
      }
      return;
    }
    if (!(await this.canEditExpense(expense, actorId, actorRoles, actorPermissions))) {
      throw new ForbiddenException('Not owner of this expense');
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
